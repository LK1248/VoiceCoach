// Interval identification: hear two notes, pick the interval.
import { INTERVALS, intervalBySemis, midiToName, midiToFreq, pickItem } from './music.js?v=20261009132303';
// (no room-noise controls in this tab: the spectrum is the app's own playback)
import { makeSpectrumAnalyser } from './audio.js?v=20261009132303';
import { LOG_FREQS, logSpectrum, findPeaks, cleanSpectrum, spectralCentroid, perceptualCentroid, chordPartials, roughness, drawSpectrum } from './spectrum.js?v=20261009132303';
import { settings, getRange, vowelsFor, soundText, instrumentFor, noteDursFor } from './settings.js?v=20261009132303';

const $ = (id) => document.getElementById(id);
const AUTO_NEXT_DELAY = 1200; // ms to show a correct answer before moving on
const SPECTRUM_INTERVAL = 50; // ms between spectrum reads while notes play
// A note's average only uses analysis windows lying entirely inside the note, starting this
// long after it begins: by then the previous note's release has died away (> 35 dB down).
const NOTE_SKIP = 0.2;
const LOOSE_SKIP = 0.1; // fallback for notes too short for a clean window (may keep a faint trace)
const FFT_SIZE = 8192; // ~0.17 s window at 48 kHz: short enough for clean frames even in 0.4 s notes
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
const noteFloor = (m) => 440 * 2 ** ((m - 1 - 69) / 12); // a semitone below the note: analysis starts here
const freshStats = () => ({ total: 0, correct: 0, streak: 0, best: 0, per: {} });

export class IdentifyMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.status = status;
    this.spec = null; // averaged spectra of the last two notes played: { notes: [{ midi, db }], ... }
    this.item = null;
    this.answered = false;
    this.stats = freshStats();

    $('idPlay').onclick = () => this.next();
    $('idReplay').onclick = () => this.play();
    $('idResetStats').onclick = () => { this.stats = freshStats(); this.renderStats(); };
    $('idFeedback').onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'next') this.next();
      if (b.dataset.act === 'correct') this.play();
      if (b.dataset.act === 'chosen') this.playSemis(+b.dataset.semis);
    };
    // Spectrum of the played notes
    $('idRaw').onchange = () => this.renderSpectrum();
    // Shown only for notes played together
    this.onSoloChange = () => {
      if (settings.harmSolo && this.spec?.together && !this.spec.live) this.renderSolo();
      this.renderSpectrum();
    };
    new ResizeObserver(() => this.renderSpectrum()).observe($('idSpectrum'));
    this.renderAnswers();
    this.renderStats();
  }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space') {
      if (!this.item || this.answered) this.next(); // Next only once answered
    } else if (key === 'n') {
      this.next();
    } else if (key === 'a') {
      this.play();
    } else if (this.answered && key === 's') {
      this.play();
    } else if (this.answered && key === 'd' && this.chosen !== this.item.interval.semis) {
      this.playSemis(this.chosen);
    } else if (this.item && !this.answered) {
      const iv = INTERVALS.find((i) => i.key === key && settings.intervals.includes(i.semis));
      if (iv) this.answer(iv.semis);
    }
  }

  async next() {
    clearTimeout(this.autoNextTimer); // moving on manually cancels a pending auto-next
    try {
      this.item = pickItem(settings, getRange(), this.item);
    } catch (err) {
      $('idPrompt').textContent = err.message;
      return;
    }
    this.answered = false;
    $('idPrompt').textContent = 'Which interval was that?';
    $('idFeedback').innerHTML = '';
    $('idBright').innerHTML = '';
    $('idReplay').disabled = false;
    this.renderAnswers();
    await this.play();
  }

  async play() {
    if (!this.item) return;
    await this.playNotes([this.item.root, this.item.second]);
  }

  /** Play a different interval from the same root (to hear what the user chose). */
  async playSemis(semis) {
    const sign = this.item.dir === 'desc' ? -1 : 1;
    await this.playNotes([this.item.root, this.item.root + sign * semis]);
  }

  async playNotes(midis) {
    this.engine.stopAll();
    const together = this.item.dir === 'harm';
    const durs = noteDursFor(this.item);
    const r = await this.engine.playSequence(instrumentFor(this.item), midis, { dur: durs, vowels: vowelsFor(this.item), together });
    this.status.fallback(r.fallback);
    this.captureSpectra(r, midis, durs, together);
  }

  // ---- Spectrum of the played notes ------------------------------------------------

  /**
   * While the two notes play, read the output spectrum every SPECTRUM_INTERVAL, draw it live,
   * and average each note's steady part. Note 1 stays as a pale curve under note 2.
   * With `together` (harmonic interval) there is one window: the spectrum of both notes at once.
   */
  captureSpectra(r, midis, durs, together = false) {
    const ctx = this.engine.ctx;
    if (!this.analyser) {
      // Own analyser on the playback: shorter window and no frame-to-frame smoothing, so a
      // note's average holds nothing of its neighbour.
      this.analyser = makeSpectrumAnalyser(ctx);
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;
      this.engine.master.connect(this.analyser);
    }
    const an = this.analyser;
    const token = (this.specToken = (this.specToken ?? 0) + 1);
    const half = an.fftSize / 2 / ctx.sampleRate; // the window spans [t - half, t + half] around t = now - half
    const lag = half;
    const windows = together ? [[r.start, r.end]] : [[r.start, r.start + durs[0]], [r.end - durs[1], r.end]];
    const sums = [new Float64Array(LOG_FREQS.length), new Float64Array(LOG_FREQS.length)];
    const counts = [0, 0];
    // Fallback for very short notes, where no whole window fits: window centre inside the note.
    const looseSums = [new Float64Array(LOG_FREQS.length), new Float64Array(LOG_FREQS.length)];
    const looseCounts = [0, 0];
    const buf = new Float32Array(an.frequencyBinCount);
    const binHz = ctx.sampleRate / an.fftSize;
    const avg = (k) => {
      const [sum, n] = counts[k] ? [sums[k], counts[k]] : [looseSums[k], looseCounts[k]];
      return n ? Float32Array.from(sum, (v) => 10 * Math.log10(v / n + 1e-20)) : null;
    };
    this.spec = { midis, durs, notes: [null, null], live: null, together };
    const timer = setInterval(() => {
      if (token !== this.specToken) { clearInterval(timer); return; }
      const t = ctx.currentTime - lag;
      an.getFloatFrequencyData(buf);
      const s = logSpectrum(buf, binHz);
      windows.forEach(([a, b], k) => {
        if (t - half >= a + NOTE_SKIP && t + half <= b) {
          for (let i = 0; i < s.length; i++) sums[k][i] += 10 ** (s[i] / 10);
          counts[k]++;
        } else if (t >= a + LOOSE_SKIP && t <= b) {
          for (let i = 0; i < s.length; i++) looseSums[k][i] += 10 ** (s[i] / 10);
          looseCounts[k]++;
        }
      });
      this.spec.notes = windows.map((_, k) => avg(k));
      this.spec.live = t < r.end + 0.05 ? { s, buf: buf.slice(), binHz, k: together || t < windows[1][0] ? 0 : 1 } : null;
      this.renderSpectrum();
      if (t > r.end + 0.05) {
        clearInterval(timer);
        if (together && settings.harmSolo) this.renderSolo();
      }
    }, SPECTRUM_INTERVAL);
  }

  /**
   * Notes played together: render each note alone silently (offline, at its share of the
   * chord's level) and average its spectrum the same way as a played note.
   */
  async renderSolo() {
    const sp = this.spec;
    if (!sp?.together || sp.solo || sp.soloPending) return;
    sp.soloPending = true;
    const dur = sp.durs[0]; // notes played together share one length
    const sr = this.engine.ensure().sampleRate;
    const win = FFT_SIZE / sr;
    const times = [];
    for (let t = NOTE_SKIP + win; t <= dur + 1e-6; t += SPECTRUM_INTERVAL / 1000) times.push(t);
    if (!times.length) times.push(dur); // very short notes: one window ending with the note
    const vowels = vowelsFor(this.item);
    const solo = await Promise.all(sp.midis.map(async (m, i) => {
      const frames = await this.engine.offlineFrames(instrumentFor(this.item), m, {
        dur, vowel: vowels[i], gain: 1 / Math.sqrt(2), fftSize: FFT_SIZE, times,
      });
      const sum = new Float64Array(LOG_FREQS.length);
      for (const f of frames) {
        const s = logSpectrum(f, sr / FFT_SIZE);
        for (let k = 0; k < s.length; k++) sum[k] += 10 ** (s[k] / 10);
      }
      return Float32Array.from(sum, (v) => 10 * Math.log10(v / frames.length + 1e-20));
    }));
    sp.soloPending = false;
    if (this.spec !== sp) return; // a newer interval has been played meanwhile
    sp.solo = solo;
    this.renderSpectrum();
  }

  /**
   * Draw: live while playing (note 1's average pale under note 2), then both averages.
   * Frequencies, the peak legend and the brightness readout stay hidden until the answer
   * is given; harmonic guides are never shown here.
   */
  renderSpectrum() {
    const canvas = $('idSpectrum');
    const sp = this.spec;
    const reveal = this.answered;
    const unfiltered = $('idRaw').checked;
    const view = (db, midi) => (unfiltered ? db : cleanSpectrum(db, 440 * 2 ** ((midi - 1 - 69) / 12)));
    const common = { hideFreqLabels: !reveal, hidePeakLegend: !reveal, ghostLabel: 'pale: note 1' };
    $('harmSoloWrap').hidden = !(sp?.together || settings.direction === 'harm');
    if (!sp) {
      drawSpectrum(canvas, { ...common, live: null, sourceLabel: 'Press New interval to hear (and see) two notes' });
      return;
    }
    if (settings.hideSpectrum && !reveal) {
      drawSpectrum(canvas, { ...common, live: null, sourceLabel: 'Spectrum hidden until you answer' });
      return;
    }
    const [m1, m2] = sp.midis;
    const low = Math.min(m1, m2);
    if (sp.together) {
      // Both notes at once: one spectrum. After answering, each note's harmonics are marked
      // (shared ones filled) with the roughest beating pairs bracketed.
      const db = sp.live ? sp.live.s : sp.notes[0];
      if (!db) return;
      const opts = { ...common, live: view(db, low), sourceLabel: sp.live ? 'playing both notes' : 'both notes together' };
      if (!reveal || sp.live) {
        opts.peaks = findPeaks(db, sp.live?.buf ?? null, sp.live?.binHz ?? 0, { minFreq: noteFloor(low) });
      } else {
        const partials = chordPartials(db, [midiToFreq(m1), midiToFreq(m2)]);
        const rough = roughness(partials);
        opts.partials = partials;
        // The roughest pairs: comparable to the worst one and a real share of the total
        const worst = rough.pairs[0]?.d ?? 0;
        opts.roughPairs = rough.pairs.filter((p) => p.d > 0 && p.d >= 0.4 * worst && p.d >= 0.03 * rough.total).slice(0, 6);
        const [lowName, highName] = [m1, m2].map((m) => midiToName(m));
        opts.legend = [
          { color: '--accent', text: `${lowName} harmonics` },
          { color: '--good', text: `${highName} harmonics` },
          { color: '--bad', text: 'shared by both', filled: true },
          ...(opts.roughPairs.length ? [{ color: '--warn', text: 'beating pair (rough)', bracket: true }] : []),
        ];
        if (settings.harmSolo && sp.solo) {
          opts.extras = [{ db: view(sp.solo[0], m1), color: '--accent' }, { db: view(sp.solo[1], m2), color: '--good' }];
          opts.sourceLabel = 'both notes together; thin: each note alone';
        }
      }
      drawSpectrum(canvas, opts);
      if (!sp.live) this.renderBrightness();
      return;
    }
    if (sp.live) {
      const k = sp.live.k;
      const midi = sp.midis[k];
      drawSpectrum(canvas, {
        ...common,
        live: view(sp.live.s, midi),
        ghost: k === 1 && sp.notes[0] ? view(sp.notes[0], m1) : null,
        sourceLabel: `playing note ${k + 1}`,
        peaks: findPeaks(sp.live.s, sp.live.buf, sp.live.binHz, { minFreq: noteFloor(midi), f0: midiToFreq(midi) }),
      });
      return;
    }
    const [n1, n2] = sp.notes;
    if (!n2) return;
    drawSpectrum(canvas, {
      ...common,
      live: view(n2, m2),
      ghost: n1 ? view(n1, m1) : null,
      sourceLabel: 'solid: note 2',
      peaks: findPeaks(n2, null, 0, { minFreq: noteFloor(m2), f0: midiToFreq(m2) }),
    });
    this.renderBrightness();
  }

  /**
   * After answering: each note's brightness (spectral centroid) and how it moves vs. the pitch.
   * Notes played together: the chord's brightness and roughness (plus the per-note comparison
   * when "Each note alone" is on).
   */
  renderBrightness() {
    const sp = this.spec;
    const box = $('idBright');
    if (!this.answered || !sp) { box.innerHTML = ''; return; }
    if (sp.together) {
      const parts = [this.chordReadout()];
      if (settings.harmSolo) parts.push(sp.solo ? this.brightnessComparison(sp.solo) : '<div>Rendering each note alone…</div>');
      box.innerHTML = parts.filter(Boolean).join('');
      return;
    }
    box.innerHTML = this.brightnessComparison(sp.notes);
  }

  /** Brightness of the two notes played together, and their roughness vs. other intervals. */
  chordReadout() {
    const sp = this.spec;
    const db = sp.notes[0];
    if (!db) return '';
    const [m1, m2] = sp.midis;
    const lo = noteFloor(Math.min(m1, m2));
    const lin = spectralCentroid(db, lo);
    const per = perceptualCentroid(db, lo);
    let html = lin && per ? `<div><b>Brightness</b> (both notes together): linear ${fmtHz(lin)}, perceptual ${fmtHz(per)}</div>` : '';
    // Roughness: how much the two notes' partials beat against each other. The same partials,
    // moved to every other interval, give this sound's own dissonance curve for comparison.
    const partials = chordPartials(db, [midiToFreq(m1), midiToFreq(m2)]);
    const actual = m2 - m1;
    const curve = INTERVALS.map((iv) => ({ iv, r: roughness(partials, iv.semis - actual).total }));
    const max = Math.max(...curve.map((c) => c.r));
    if (!(max > 0)) return html;
    const now = roughness(partials).total;
    const roughest = curve.reduce((a, b) => (b.r > a.r ? b : a));
    const pct = (r) => Math.round((100 * r) / max);
    const bars = curve.map(({ iv, r }) => `<span class="${iv.semis === actual ? 'now' : ''}" title="${iv.name}: ${pct(r)}%">`
      + `<i style="height:${Math.max(2, pct(r))}%"></i><small>${iv.short}</small></span>`).join('');
    html += `<div class="rough-line"><b>Roughness</b> (beating between the two notes' partials):
      ${pct(now)}% of the roughest interval for this sound (${roughest.iv.short}).
      Shared (filled) harmonics fuse the notes; close pairs (bracketed) beat.</div>
      <div class="rough-curve" title="Roughness of each interval, from this sound's partials">${bars}</div>`;
    return html;
  }

  /** Two notes' spectra compared: pitch shift vs. brightness shift (three measures). */
  brightnessComparison(notes) {
    const [m1, m2] = this.spec.midis;
    if (!notes?.[0] || !notes[1]) return '';
    const pitchUp = m2 > m1;
    const unison = m2 === m1;
    // A semitone shift as the nearest interval, e.g. 15.2 → "≈ octave + m3 up"
    const asInterval = (semis) => {
      const n = Math.round(Math.abs(semis));
      if (n === 0) return 'unison';
      const oct = Math.floor(n / 12);
      const rest = n % 12;
      const parts = [oct === 1 ? 'octave' : oct > 1 ? `${oct} octaves` : '', rest ? intervalBySemis(rest).short : ''];
      return `${parts.filter(Boolean).join(' + ')} ${semis > 0 ? 'up' : 'down'}`;
    };
    // Two measures side by side while we compare them: the classic power-weighted centroid in Hz,
    // and a perceptual one (ERB-rate scale, loudness-compressed).
    const measures = [
      ['Linear', 'power-weighted centroid in Hz', spectralCentroid],
      ['Perceptual', 'loudness-weighted centroid on the ERB scale', perceptualCentroid],
    ].map(([name, title, fn]) => {
      const c1 = fn(notes[0], noteFloor(m1));
      const c2 = fn(notes[1], noteFloor(m2));
      if (!c1 || !c2) return null;
      const semis = 12 * Math.log2(c2 / c1);
      const bright = Math.abs(semis) < 1 ? 'about the same' : semis > 0 ? 'brighter' : 'darker';
      const clash = !unison && Math.abs(semis) >= 1 && (semis > 0) !== pitchUp;
      return { name, clash, html: `<span title="${title}">${name}:</span> ${fmtHz(c1)} → ${fmtHz(c2)}
        (${semis > -0.05 ? '+' : '−'}${Math.abs(semis).toFixed(1)} st ≈ ${asInterval(semis)}, ${bright})` };
    }).filter(Boolean);
    if (!measures.length) return '';
    const clashing = measures.filter((m) => m.clash).map((m) => m.name.toLowerCase());
    // Linear centroid in harmonic numbers (÷ f0): the spectrum's shape relative to the note.
    // In semitones, linear brightness shift = pitch shift + this shift.
    let harmonic = '';
    const l1 = spectralCentroid(notes[0], noteFloor(m1));
    const l2 = spectralCentroid(notes[1], noteFloor(m2));
    if (l1 && l2) {
      const h1 = l1 / midiToFreq(m1);
      const h2 = l2 / midiToFreq(m2);
      const semis = 12 * Math.log2(h2 / h1);
      harmonic = `<br><span title="linear centroid ÷ fundamental: around which harmonic the energy sits. Linear shift = pitch shift + this shift">Harmonic:</span>
        ${h1.toFixed(1)} → ${h2.toFixed(1)} (${semis > -0.05 ? '+' : '−'}${Math.abs(semis).toFixed(1)} st; pitch + harmonic = linear)`;
    }
    const heading = this.spec.together ? '<b>Each note alone</b>: brightness vs. pitch' : '<b>Brightness</b> (spectral centroid) vs. pitch';
    return `<div>${heading}<br>
      Pitch: ${unison ? '0 st = unison' : `${pitchUp ? '+' : '−'}${Math.abs(m2 - m1)} st = ${asInterval(m2 - m1)}`}<br>${measures.map((m) => m.html).join('<br>')}${harmonic}
      ${clashing.length ? `<span class="clash">The pitch goes ${pitchUp ? 'up' : 'down'} but the brightness goes ${pitchUp ? 'down' : 'up'}${clashing.length < measures.length ? ` (${clashing[0]} measure)` : ''}: a common reason an interval can sound ${pitchUp ? 'descending' : 'ascending'}.</span>` : ''}</div>`;
  }

  renderAnswers() {
    const box = $('idAnswers');
    box.innerHTML = '';
    for (const iv of INTERVALS.filter((i) => settings.intervals.includes(i.semis))) {
      const b = document.createElement('button');
      b.dataset.semis = iv.semis;
      b.innerHTML = `<kbd class="key">${iv.key.toUpperCase()}</kbd><b>${iv.short}</b><small>${iv.name}</small>`;
      b.disabled = !this.item || this.answered;
      b.onclick = () => this.answer(iv.semis);
      box.append(b);
    }
    if (this.answered) this.markAnswers();
  }

  answer(semis) {
    if (!this.item || this.answered) return;
    this.answered = true;
    this.chosen = semis;
    const { item, stats } = this;
    const ok = semis === item.interval.semis;

    stats.total++;
    if (ok) stats.correct++;
    stats.streak = ok ? stats.streak + 1 : 0;
    stats.best = Math.max(stats.best, stats.streak);
    const p = (stats.per[item.interval.semis] ??= { c: 0, t: 0 });
    p.t++;
    if (ok) p.c++;

    this.renderAnswers();
    const durs = noteDursFor(item);
    const lengths = !settings.randomDur ? '' : ` · ${item.dir === 'harm' ? `length ${durs[0].toFixed(1)} s` : `lengths ${durs[0].toFixed(1)} s → ${durs[1].toFixed(1)} s`}`;
    const desc = `${midiToName(item.root)} ${item.dir === 'harm' ? '+' : '→'} ${midiToName(item.second)} · ${item.interval.name}${item.interval.semis === 0 ? '' : `, ${{ asc: 'ascending', desc: 'descending', harm: 'harmonic (together)' }[item.dir]}`}${soundText(item)}${lengths}`;
    const chosen = intervalBySemis(semis);
    $('idFeedback').innerHTML = `
      <div class="verdict ${ok ? 'ok' : 'no'}">${ok ? '✓ Correct!' : `✗ Not quite — you chose ${chosen.name}`}</div>
      <div class="detail">${desc}</div>
      <div class="controls">
        <button class="primary" data-act="next">Next ▶ <kbd>Space</kbd></button>
        <button data-act="correct">▶ Hear ${item.interval.short} <kbd>S</kbd></button>
        ${ok ? '' : `<button data-act="chosen" data-semis="${semis}">▶ Hear your answer (${chosen.short}) <kbd>D</kbd></button>`}
      </div>`;
    const auto = ok && settings.autoNext;
    $('idPrompt').textContent = auto ? 'Nice ear! Next one coming…' : ok ? 'Nice ear!' : 'Compare the two, then move on.';
    if (auto) {
      const item = this.item;
      this.autoNextTimer = setTimeout(() => {
        // Only if nothing else moved on meanwhile and Interval ID is still the active tab.
        if (this.item === item && document.body.dataset.mode === 'identify') this.next();
      }, AUTO_NEXT_DELAY);
    }
    this.renderStats();
    this.renderSpectrum(); // reveal frequencies, peak legend and brightness
  }

  markAnswers() {
    $('idAnswers').querySelectorAll('button').forEach((b) => {
      const s = +b.dataset.semis;
      b.disabled = true;
      if (s === this.item.interval.semis) b.classList.add('correct');
      else if (s === this.chosen) b.classList.add('wrong');
    });
  }

  renderStats() {
    const s = this.stats;
    const pct = s.total ? Math.round((100 * s.correct) / s.total) : 0;
    const rows = INTERVALS.filter((i) => s.per[i.semis])
      .map((i) => {
        const p = s.per[i.semis];
        const r = Math.round((100 * p.c) / p.t);
        return `<span>${i.name}</span><div class="bar"><div style="width:${r}%"></div></div><span class="num">${p.c}/${p.t}</span>`;
      })
      .join('');
    $('idStats').innerHTML = `
      <div class="summary">
        <div><b>${s.correct}/${s.total}</b>correct</div>
        <div><b>${pct}%</b>accuracy</div>
        <div><b>${s.streak}</b>streak</div>
        <div><b>${s.best}</b>best streak</div>
      </div>
      ${rows ? `<div class="bars">${rows}</div>` : '<div class="empty">Per-interval accuracy will appear here.</div>'}`;
  }
}
