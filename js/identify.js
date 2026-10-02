// Interval identification: hear two notes, pick the interval.
import { INTERVALS, intervalBySemis, midiToName, pickItem } from './music.js?v=20261002184453';
// (no room-noise controls in this tab: the spectrum is the app's own playback)
import { makeSpectrumAnalyser } from './audio.js?v=20261002184453';
import { LOG_FREQS, logSpectrum, findPeaks, cleanSpectrum, spectralCentroid, drawSpectrum } from './spectrum.js?v=20261002184453';
import { settings, getRange, vowelsFor, soundText, instrumentFor } from './settings.js?v=20261002184453';

const $ = (id) => document.getElementById(id);
const AUTO_NEXT_DELAY = 1200; // ms to show a correct answer before moving on
const SPECTRUM_INTERVAL = 50; // ms between spectrum reads while notes play
// A note's average only uses analysis windows lying entirely inside the note, starting this
// long after it begins: by then the previous note's release has died away (> 35 dB down).
const NOTE_SKIP = 0.2;
const LOOSE_SKIP = 0.1; // fallback for notes too short for a clean window (may keep a faint trace)
const FFT_SIZE = 8192; // ~0.17 s window at 48 kHz: short enough for clean frames even in 0.4 s notes
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
    const sign = this.item.dir === 'asc' ? 1 : -1;
    await this.playNotes([this.item.root, this.item.root + sign * semis]);
  }

  async playNotes(midis) {
    this.engine.stopAll();
    const r = await this.engine.playSequence(instrumentFor(this.item), midis, { dur: settings.noteDur, vowels: vowelsFor(this.item) });
    this.status.fallback(r.fallback);
    this.captureSpectra(r, midis, settings.noteDur);
  }

  // ---- Spectrum of the played notes ------------------------------------------------

  /**
   * While the two notes play, read the output spectrum every SPECTRUM_INTERVAL, draw it live,
   * and average each note's steady part. Note 1 stays as a pale curve under note 2.
   */
  captureSpectra(r, midis, dur) {
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
    const windows = [[r.start, r.start + dur], [r.end - dur, r.end]];
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
    this.spec = { midis, notes: [null, null], live: null };
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
      this.spec.notes = [avg(0), avg(1)];
      this.spec.live = t < r.end + 0.05 ? { s, buf: buf.slice(), binHz, k: t < windows[1][0] ? 0 : 1 } : null;
      this.renderSpectrum();
      if (t > r.end + 0.05) clearInterval(timer);
    }, SPECTRUM_INTERVAL);
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
    if (!sp) {
      drawSpectrum(canvas, { ...common, live: null, sourceLabel: 'Press New interval to hear (and see) two notes' });
      return;
    }
    if (settings.hideSpectrum && !reveal) {
      drawSpectrum(canvas, { ...common, live: null, sourceLabel: 'Spectrum hidden until you answer' });
      return;
    }
    const [m1, m2] = sp.midis;
    if (sp.live) {
      const k = sp.live.k;
      const midi = sp.midis[k];
      drawSpectrum(canvas, {
        ...common,
        live: view(sp.live.s, midi),
        ghost: k === 1 && sp.notes[0] ? view(sp.notes[0], m1) : null,
        sourceLabel: `playing note ${k + 1}`,
        peaks: findPeaks(sp.live.s, sp.live.buf, sp.live.binHz, { minFreq: 440 * 2 ** ((midi - 1 - 69) / 12) }),
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
      peaks: findPeaks(n2, null, 0, { minFreq: 440 * 2 ** ((m2 - 1 - 69) / 12) }),
    });
    this.renderBrightness();
  }

  /** After answering: each note's brightness (spectral centroid) and how it moves vs. the pitch. */
  renderBrightness() {
    const sp = this.spec;
    const box = $('idBright');
    if (!this.answered || !sp?.notes[0] || !sp.notes[1]) { box.innerHTML = ''; return; }
    const [m1, m2] = sp.midis;
    const c1 = spectralCentroid(sp.notes[0], 440 * 2 ** ((m1 - 1 - 69) / 12));
    const c2 = spectralCentroid(sp.notes[1], 440 * 2 ** ((m2 - 1 - 69) / 12));
    if (!c1 || !c2) { box.innerHTML = ''; return; }
    const fmt = (f) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
    const semis = 12 * Math.log2(c2 / c1);
    const bright = Math.abs(semis) < 1 ? 'about the same brightness' : semis > 0 ? 'brighter' : 'darker';
    const pitchUp = m2 > m1;
    const clash = Math.abs(semis) >= 1 && (semis > 0) !== pitchUp;
    box.innerHTML = `<b>Brightness</b> (spectral centroid): note 1 ${fmt(c1)} → note 2 ${fmt(c2)}
      (${semis >= 0 ? '+' : '−'}${Math.abs(semis).toFixed(1)} semitones, ${bright}).
      ${clash ? `<span class="clash">The pitch goes ${pitchUp ? 'up' : 'down'} but the brightness goes ${pitchUp ? 'down' : 'up'}: a common reason an interval can sound ${pitchUp ? 'descending' : 'ascending'}.</span>` : ''}`;
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
    const desc = `${midiToName(item.root)} → ${midiToName(item.second)} · ${item.interval.name}, ${item.dir === 'asc' ? 'ascending' : 'descending'}${soundText(item)}`;
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
