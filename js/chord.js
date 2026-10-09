// With Chords: a major or minor chord plays as backing while the user sings one note of the
// matching scale over it.
//  • Pitch alignment: every time the user starts singing, a fixed-length attempt is scored.
//  • Pitch following: hold the note in tune for `chHold` seconds to move on to the next.
// Listening on headphones the microphone hears only the voice. On speakers it also hears the
// chord. The backing is a fixed loop, so one cycle of it is first measured on its own, moment by
// moment; the pitch is then read from what rises above the backing at the same point of the
// cycle (spectralPitch.js) — best effort.
import { midiToName, DEGREES } from './music.js?v=20261009205629';
import { INSTRUMENTS, pickInstrument } from './instruments.js?v=20261009205629';
import { makeSpectrumAnalyser } from './audio.js?v=20261009205629';
import { settings, vowelsFor, instrumentFor } from './settings.js?v=20261009205629';
import { GRADE_FROM, GRADE_TO, segmentCents, octaveShift, scoreNote, noteCardHtml } from './grading.js?v=20261009205629';
import { createPlot, drawBand, drawTrace, drawPlayhead, drawMessage } from './plot.js?v=20261009205629';
import { emptyProfile, holdMax, detectOverBacking } from './spectralPitch.js?v=20261009205629';

const $ = (id) => document.getElementById(id);
const VOICE_FRAMES = 3; // consecutive steady voiced frames (~70 ms) that start an attempt
const VOICE_PREROLL = 0.08; // seconds kept before the detected onset
const SILENCE_FRAMES = 8; // ~0.2 s without pitch needed before another attempt can start
const DEAF_TAIL = 0.3; // seconds the mic is ignored after the target note ends (speaker echo)
const MAX_BREAK = 0.2; // pitch following: longest allowed break in the held note
const FOLLOW_VIEW = 6; // seconds shown on the pitch-following graph
const NEXT_DELAY = 800; // ms between a successful match and the next note
const RECENT_SEC = 1.5; // pitch frames kept so an attempt can start slightly in the past
const SPEC_FFT = 8192; // speakers: ~0.17 s analysis window
const SLOT = 0.06; // s: the backing cycle is measured in slices this long
const SPEAKER_BREAK = 0.5; // pitch following on speakers: each chord strike briefly hides the voice
const LOOKAHEAD = 0.4; // s of backing scheduled ahead
const ARP_ORDER = [0, 1, 2, 3, 2, 1]; // root, third, fifth, octave and back
const MAX_STRIKE = 3; // s: block chords are struck again at least this often (the samples are ~3 s long)
const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'];
const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const freshStats = () => ({ notes: 0, attempts: 0, scoreSum: 0, best: 0, per: {} });

export class ChordMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.recorder = recorder;
    this.status = status;
    this.active = false; // backing playing and listening to the mic
    this.target = null; // MIDI note to sing
    this.item = null; // { key, quality, degree, chord: [4 MIDI notes] }
    this.revealed = false; // the note's name has been given away (hint or finished attempt)
    this.token = 0; // bumps whenever the current note / backing is replaced
    this.deafUntil = 0; // AudioContext time until which mic frames are ignored
    this.back = null; // running backing loop
    this.bus = null; // backing volume
    this.recent = []; // recent pitch frames (after speaker-mode correction)
    // Speakers
    this.specAn = null;
    this.specBuf = null;
    this.masks = null; // backing spectrum through the mic, per slice of its cycle
    this.calib = null; // measurement in progress: { slots, from, until }
    // Pitch alignment
    this.attempts = [];
    this.live = null;
    this.run = [];
    this.needSilence = false;
    this.quiet = 0;
    // Pitch following
    this.follow = [];
    this.hold = { start: null, lastVoiced: -Infinity };
    this.advancing = false;
    this.matched = 0;
    this.bestRun = 0;
    this.stats = freshStats();

    $('chNew').onclick = () => this.newNote();
    $('chHear').onclick = () => this.hear();
    $('chStop').onclick = () => this.stop();
    $('chResetRun').onclick = () => { this.matched = 0; this.renderCounter(); };
    $('chResetStats').onclick = () => { this.stats = freshStats(); this.bestRun = 0; this.renderStats(); };
    new ResizeObserver(() => this.draw()).observe($('chCanvas'));
    this.renderUI();
    this.renderHold(0);
    this.renderStats();
  }

  get following() { return settings.chMode === 'follow'; }
  get speakers() { return settings.chListen === 'speakers'; }
  get soundItem() { return { randomVowels: [this.randomVowel, this.randomVowel], instrument: this.randomInstrument }; }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space' || key === 'n') this.newNote();
    else if (key === 'a') this.hear();
  }

  activate() { this.renderUI(); this.draw(); }

  deactivate() { if (this.active) this.stop(true); }

  onSettings(field) {
    if (field === 'chMode') {
      this.stop(true);
      this.target = null;
      this.item = null;
      this.attempts = [];
      this.follow = [];
      this.matched = 0;
    }
    if ((field === 'tolerance' || field === 'octaveTolerant') && this.attempts.length) {
      for (const a of this.attempts) a.result = this.gradeAttempt(a.frames, a.D);
      this.renderResults();
    }
    if (field === 'chVol' && this.bus) this.bus.gain.setTargetAtTime(settings.chVol, this.engine.ctx.currentTime, 0.03);
    // A different backing sound: restart it (and measure it again on speakers).
    if (['chInst', 'chStyle', 'chBeat', 'chListen', 'chVol'].includes(field) && this.active && this.target
      && (field !== 'chVol' || this.speakers)) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { if (this.active && this.target) this.intro(++this.token, false); }, 250);
    }
    if (field === 'chHold') this.renderHold(0);
    if (field.startsWith('ch') || field === 'instrument' || field === 'vowel') this.renderUI();
    this.draw();
  }

  // ---- Flow ---------------------------------------------------------------

  /** Draw a chord and a note of its scale to sing; null if no selected degree fits the range. */
  pickItem() {
    const quality = settings.chQuality === 'random' ? rand(['major', 'minor']) : settings.chQuality;
    const steps = SCALE[quality];
    const degrees = settings.chDegrees.filter((d) => d >= 1 && d <= 7);
    const [lo, hi] = settings.chRange;
    const keys = settings.chKey === 'random' ? [...Array(12).keys()] : [settings.chKey];
    const cands = [];
    for (const key of keys) {
      for (let m = lo; m <= hi; m++) {
        const d = steps.indexOf((((m - key) % 12) + 12) % 12) + 1;
        if (d && degrees.includes(d)) cands.push({ key, degree: d, target: m });
      }
    }
    if (!cands.length) return null;
    const fresh = cands.filter((c) => c.target !== this.target || c.key !== this.item?.key);
    const pick = rand(fresh.length ? fresh : cands);
    // Chord voicing: root in the octave from C3 (or the instrument's lowest note), third, fifth, octave.
    const inst = INSTRUMENTS[settings.chInst] ?? INSTRUMENTS.piano;
    const base = Math.max(48, (inst.playable ?? inst.range)[0]);
    const root = base + ((((pick.key - base) % 12) + 12) % 12);
    return { ...pick, quality, chord: [root, root + steps[2], root + 7, root + 12] };
  }

  async newNote() {
    if (this.starting) return;
    this.starting = true;
    const token = ++this.token;
    try {
      await this.recorder.init();
      const item = this.pickItem();
      if (!item) {
        this.setPhase('⚠️ No selected scale degree fits the singing range. Tick more degrees or widen the range.');
        return;
      }
      this.item = item;
      this.target = item.target;
      this.revealed = false;
      this.randomVowel = rand(VOWEL_KEYS);
      this.randomInstrument = pickInstrument([this.target]);
      this.abortAttempt();
      this.attempts = [];
      this.follow = [];
      this.resetHold();
      if (!this.following) this.stats.notes++;
      this.active = true;
      $('chResults').innerHTML = '';
      this.renderUI();
      this.renderStats();
      await this.intro(token, settings.chTarget === 'play');
    } catch (err) {
      this.setPhase(`⚠️ ${err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : err.message}`);
    } finally {
      this.starting = false;
    }
  }

  /** Optionally play the target note alone, then start the chord (measuring it first on speakers). */
  async intro(token, playTarget) {
    this.stopBacking();
    this.engine.stopAll();
    this.abortAttempt();
    this.deafUntil = Infinity;
    this.calib = null;
    const lag = this.engine.outputLatency + this.recorder.inputLatency;
    if (playTarget) {
      this.setPhase(`👂 Listen: ${this.targetText(true)}`);
      const r = await this.playTarget();
      await this.engine.waitUntil(r.end + 0.15);
      if (token !== this.token || !this.active) return;
    }
    const t0 = await this.startBacking(token);
    if (t0 == null) return;
    this.run = [];
    this.needSilence = false;
    this.resetHold();
    if (this.speakers) {
      this.ensureSpectrum();
      this.setPhase('🔈 Measuring the chord through your microphone: stay quiet…');
      // One full cycle, plus a little of the next so its start is also heard with the
      // previous notes still ringing.
      const cycle = this.cycleDur();
      const bins = this.specAn.frequencyBinCount;
      this.masks = null;
      this.calib = {
        token,
        slots: Array.from({ length: Math.ceil(cycle / SLOT) }, () => emptyProfile(bins)),
        from: t0 + lag + 0.05,
        until: t0 + lag + cycle + Math.min(0.6, cycle / 3),
      };
    } else {
      this.deafUntil = t0;
      this.setListeningPhase();
    }
    this.draw();
  }

  playTarget() {
    return this.engine
      .playSequence(instrumentFor(this.soundItem), [this.target], { dur: settings.singDur, vowels: vowelsFor(this.soundItem) })
      .then((r) => { this.status.fallback(r.fallback); return r; });
  }

  /** Hint: play the target note over the chord. The mic is ignored until it has ended. */
  async hear() {
    if (!this.target || this.starting || this.calib) return;
    if (!this.active) { this.active = true; this.renderUI(); await this.intro(++this.token, true); return; }
    this.abortAttempt();
    this.deafUntil = Infinity;
    this.revealed = true;
    this.renderUI();
    this.setPhase(`👂 Listen: ${this.targetText(true)}`);
    const token = this.token;
    const r = await this.playTarget();
    this.deafUntil = r.end + DEAF_TAIL + this.engine.outputLatency + this.recorder.inputLatency;
    this.resetHold();
    this.run = [];
    setTimeout(() => {
      if (this.active && token === this.token && !this.live) this.setListeningPhase();
    }, Math.max(0, (this.deafUntil - this.engine.ctx.currentTime) * 1000));
  }

  /** "the 3rd (E4)", or just "the 3rd" while the note's name is withheld. */
  targetText(withName = this.showName) {
    const d = `the ${DEGREES[this.item.degree - 1]}`;
    return withName ? `${d} (${midiToName(this.target)})` : d;
  }

  get showName() { return settings.chTarget !== 'degree' || this.revealed; }

  setListeningPhase() {
    this.setPhase(this.following
      ? `🎤 Sing ${this.targetText()} and hold it for ${settings.chHold.toFixed(1)} s`
      : this.attempts.length
        ? `🎤 Sing ${this.targetText()} again to retry, or press N for a new note`
        : `🎤 Sing ${this.targetText()} over the chord`, true);
  }

  stop(silent = false) {
    this.active = false;
    this.token++;
    this.calib = null;
    this.abortAttempt();
    this.stopBacking();
    this.engine.stopAll();
    this.renderHold(0);
    if (!silent) this.setPhase('Stopped. Press New note or Hear note to continue.');
    this.renderUI();
    this.draw();
  }

  abortAttempt() {
    if (this.live) {
      this.recorder.stop();
      this.live = null;
    }
  }

  resetHold() {
    this.hold = { start: null, lastVoiced: -Infinity };
    this.renderHold(0);
  }

  // ---- Backing --------------------------------------------------------------

  /** Seconds for the backing to sound every chord note at least once (block: one strike). */
  cycleDur() {
    return settings.chStyle === 'arp' ? ARP_ORDER.length * settings.chBeat : Math.min(4 * settings.chBeat, MAX_STRIKE);
  }

  /** Start the looping backing; resolves with its start time, or null if superseded meanwhile. */
  async startBacking(token) {
    const ctx = this.engine.ensure();
    const instKey = INSTRUMENTS[settings.chInst] ? settings.chInst : 'piano';
    const inst = INSTRUMENTS[instKey];
    const { chord } = this.item;
    const samples = await Promise.all(chord.map((m) => this.engine.loadSample(instKey, m).catch(() => null)));
    if (token !== this.token || !this.active) return null;
    this.status.fallback(!!inst.sf && samples.some((s) => !s));
    if (!this.bus) {
      this.bus = ctx.createGain();
      this.bus.connect(this.engine.master);
    }
    this.bus.gain.cancelScheduledValues(ctx.currentTime);
    this.bus.gain.setValueAtTime(settings.chVol, ctx.currentTime);
    const arp = settings.chStyle === 'arp';
    const step = arp ? settings.chBeat : Math.min(4 * settings.chBeat, MAX_STRIKE);
    const b = (this.back = { t0: ctx.currentTime + 0.08, k: 0, srcs: new Set(), timer: 0, cycle: this.cycleDur() });
    const out = { ctx, dest: this.bus };
    const play = (i, when, dur, gain) => {
      const src = this.engine.playNote(samples[i], chord[i], when, dur, gain * (inst.gain ?? 1), inst.wave, out);
      b.srcs.add(src);
      src.onended = () => b.srcs.delete(src);
    };
    const schedule = () => {
      const horizon = ctx.currentTime + LOOKAHEAD;
      for (let when = b.t0 + b.k * step; when <= horizon; when = b.t0 + ++b.k * step) {
        // Arpeggio notes ring a little into the next; block chords are re-struck as they fade.
        if (arp) play(ARP_ORDER[b.k % ARP_ORDER.length], when, step * 1.5, 0.8);
        else chord.forEach((_, i) => play(i, when, step, 0.5));
      }
    };
    schedule();
    b.timer = setInterval(schedule, 100);
    return b.t0;
  }

  stopBacking() {
    const b = this.back;
    if (!b) return;
    this.back = null;
    clearInterval(b.timer);
    const now = this.engine.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(now);
    this.bus.gain.setTargetAtTime(0, now, 0.02); // short fade: no click
    for (const src of b.srcs) { try { src.stop(now + 0.12); } catch { /* already stopped */ } }
  }

  // ---- Mic frames -----------------------------------------------------------

  ensureSpectrum() {
    if (this.specAn) return;
    this.specAn = makeSpectrumAnalyser(this.engine.ctx);
    this.specAn.fftSize = SPEC_FFT;
    this.specAn.smoothingTimeConstant = 0;
    this.recorder.source.connect(this.specAn);
    this.specBuf = new Float32Array(this.specAn.frequencyBinCount);
  }

  /** Which slice of the backing cycle is sounding at AudioContext time `now`. */
  slotAt(now, count) {
    const { t0, cycle } = this.back;
    const phase = (((now - t0) % cycle) + cycle) % cycle;
    return Math.min(count - 1, Math.floor(phase / SLOT));
  }

  /**
   * Turn the measured slices into masks: each is the loudest of itself and its neighbours
   * (the analysis window is longer than a slice, and frames don't land on exact times).
   */
  buildMasks(slots) {
    const n = slots.length;
    return slots.map((_, i) => {
      const m = Float32Array.from(slots[i]);
      for (const j of [(i + n - 1) % n, (i + 1) % n]) {
        const o = slots[j];
        for (let k = 0; k < m.length; k++) if (o[k] > m[k]) m[k] = o[k];
      }
      return m;
    });
  }

  /** Speakers: the pitch frame re-derived from what rises above the measured chord. */
  overBacking(f) {
    this.specAn.getFloatFrequencyData(this.specBuf);
    const [lo, hi] = settings.chRange;
    const hz = (m) => 440 * 2 ** ((m - 69) / 12);
    const mask = this.masks[this.slotAt(this.engine.ctx.currentTime, this.masks.length)];
    const d = detectOverBacking(this.specBuf, mask, this.engine.ctx.sampleRate / SPEC_FFT, { fmin: hz(lo - 13), fmax: hz(hi + 13) });
    return { ...f, voiced: d.voiced, midi: d.midi };
  }

  onFrame(raw) {
    $('chLevel').style.width = `${Math.min(100, raw.rms * 500)}%`;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.calib) {
      const c = this.calib;
      this.specAn.getFloatFrequencyData(this.specBuf);
      if (now >= c.from && this.back) holdMax(c.slots[this.slotAt(now, c.slots.length)], this.specBuf);
      if (now >= c.until) {
        this.masks = this.buildMasks(c.slots);
        this.calib = null;
        this.deafUntil = now;
        if (this.active) this.setListeningPhase();
      }
      return;
    }
    if (!this.active || !this.target || now < this.deafUntil) return;
    const f = this.speakers && this.masks && this.back ? this.overBacking(raw) : raw;
    this.recent.push(f);
    while (this.recent.length && this.recent[0].abs < f.abs - RECENT_SEC * this.recorder.sr) this.recent.shift();
    if (this.following) this.followFrame(f);
    else this.alignFrame(f);
    this.requestDraw();
  }

  alignFrame(f) {
    if (this.live) {
      if (f.t != null) this.live.frames.push(f);
      if (this.recorder.elapsed >= this.live.D) this.finishAttempt();
      return;
    }
    if (this.needSilence) {
      this.quiet = f.voiced ? 0 : this.quiet + 1;
      if (this.quiet < SILENCE_FRAMES) return;
      this.needSilence = false;
    }
    if (!f.voiced) { this.run = []; return; }
    if (this.run.length && Math.abs(f.midi - this.run[this.run.length - 1].midi) > 1) this.run = [];
    this.run.push(f);
    if (this.run.length >= VOICE_FRAMES) {
      this.recorder.start(this.run[0].abs - Math.round(VOICE_PREROLL * this.recorder.sr));
      const { startAbs, sr } = this.recorder;
      // Our own recent frames (already corrected on speakers), re-timed to the take.
      const past = this.recent.filter((r) => r.abs >= startAbs).map((r) => ({ ...r, t: (r.abs - startAbs) / sr }));
      this.live = { frames: past, D: settings.singDur };
      this.run = [];
      this.setPhase(`🎤 Recording ${this.targetText()}…`, true);
    }
  }

  finishAttempt() {
    const { frames, D } = this.live;
    this.recorder.stop();
    this.live = null;
    const result = this.gradeAttempt(frames, D);
    this.attempts.push({ frames, D, result });
    const s = this.stats;
    s.attempts++;
    s.scoreSum += result.score;
    s.best = Math.max(s.best, result.score);
    const p = (s.per[this.item.degree] ??= { sum: 0, n: 0 });
    p.sum += result.score;
    p.n++;
    this.revealed = true; // the result names the note
    this.needSilence = true;
    this.quiet = 0;
    this.renderUI();
    this.renderResults();
    this.renderStats();
    this.setListeningPhase();
    this.draw();
  }

  gradeAttempt(frames, D) {
    const seg = segmentCents(frames, this.target, GRADE_FROM * D, GRADE_TO * D);
    const shift = settings.octaveTolerant ? octaveShift(seg.raw) : 0;
    return { ...scoreNote(this.target, seg, settings.tolerance, shift), shift };
  }

  /** Nearest-octave display/compare pitch when any octave is accepted. */
  folded(midi) {
    return settings.octaveTolerant ? midi - 12 * Math.round((midi - this.target) / 12) : midi;
  }

  followFrame(f) {
    const t = f.abs / this.recorder.sr;
    const H = settings.chHold;
    const inTol = f.voiced && Math.abs(this.folded(f.midi) - this.target) * 100 <= settings.tolerance;
    this.follow.push({ t, midi: f.midi, voiced: f.voiced });
    while (this.follow.length && this.follow[0].t < t - Math.max(FOLLOW_VIEW, H) - 1) this.follow.shift();
    const h = this.hold;
    const maxBreak = this.speakers ? SPEAKER_BREAK : MAX_BREAK;
    if (f.voiced) {
      if (inTol && (h.start == null || t - h.lastVoiced > maxBreak)) h.start = t;
      if (!inTol) h.start = null;
      h.lastVoiced = t;
    } else if (h.start != null && t - h.lastVoiced > maxBreak) {
      h.start = null;
    }
    const held = h.start == null ? 0 : t - h.start;
    this.renderHold(held);
    if (held >= H && !this.advancing) this.matchSucceeded();
  }

  matchSucceeded() {
    this.advancing = true;
    this.deafUntil = Infinity;
    this.matched++;
    this.bestRun = Math.max(this.bestRun, this.matched);
    this.revealed = true;
    this.renderUI();
    this.renderStats();
    this.setPhase(`✓ Matched ${this.targetText(true)}!`);
    setTimeout(() => {
      this.advancing = false;
      if (this.active && this.following) this.newNote();
    }, NEXT_DELAY);
  }

  // ---- Rendering --------------------------------------------------------------

  setPhase(text, live = false) {
    const el = $('chPhase');
    el.innerHTML = text || '&nbsp;';
    el.classList.toggle('live', live);
  }

  renderUI() {
    const follow = this.following;
    const how = { play: 'The note is played first; then', name: 'The note is named;', degree: 'Only the scale degree is given;' }[settings.chTarget];
    $('chPrompt').textContent = `${how} sing it over the chord${follow ? ` and hold it in tune for ${settings.chHold.toFixed(1)} s to move on` : '. Every attempt is scored'}. ${
      this.speakers ? 'Speakers: stay quiet while each chord is measured, and keep your voice louder than the music at the microphone.' : 'Use headphones, so the microphone hears only you.'}`;
    const it = this.item;
    $('chLabel').innerHTML = it
      ? `${PITCH_CLASSES[it.key]} ${it.quality}<small class="sound"> · sing ${this.targetText()}</small>`
      : '&nbsp;';
    $('chNew').innerHTML = `${follow && this.target ? '⏭ Skip note' : '▶ New note'} <kbd>N</kbd>`;
    $('chHear').disabled = !this.target;
    $('chStop').disabled = !this.active;
    $('chFollowBox').hidden = !follow;
    $('chResults').hidden = follow;
    if (!this.target) this.setPhase('');
    this.renderCounter();
  }

  renderHold(held) {
    const H = settings.chHold;
    $('chHoldFill').style.width = `${Math.min(100, (held / H) * 100)}%`;
    $('chHoldText').textContent = `${Math.min(held, H).toFixed(1)} / ${H.toFixed(1)} s`;
  }

  renderCounter() {
    $('chCounter').textContent = this.matched;
  }

  renderResults() {
    const n = this.attempts.length;
    if (!n) { $('chResults').innerHTML = ''; return; }
    const last = this.attempts[n - 1].result;
    const octaves = -last.shift / 1200;
    const octLine = octaves
      ? `<div class="line">Sung ${Math.abs(octaves)} octave${Math.abs(octaves) > 1 ? 's' : ''} ${octaves < 0 ? 'lower' : 'higher'} than the target (accepted).</div>`
      : '';
    const history = this.attempts
      .map((a, i) => `<span class="chip-score ${a.result.ok ? 'ok' : 'no'}${i === n - 1 ? ' latest' : ''}">${a.result.score}</span>`)
      .join('');
    $('chResults').innerHTML = `
      <div class="notes">${noteCardHtml(last, `Attempt ${n} · ${DEGREES[this.item.degree - 1]}`, settings.tolerance)}</div>${octLine}
      <div class="attempts"><span class="field-label">Scores on this note:</span> ${history}</div>`;
  }

  renderStats() {
    const s = this.stats;
    const avg = s.attempts ? Math.round(s.scoreSum / s.attempts) : 0;
    const rows = DEGREES.map((name, i) => [name, s.per[i + 1]]).filter(([, p]) => p)
      .map(([name, p]) => {
        const a = Math.round(p.sum / p.n);
        return `<span>${name}</span><div class="bar"><div style="width:${a}%"></div></div><span class="num">avg ${a}</span>`;
      })
      .join('');
    $('chStats').innerHTML = `
      <div class="summary">
        <div><b>${s.notes}</b>notes practised</div>
        <div><b>${s.attempts}</b>attempts</div>
        <div><b>${avg}</b>avg score</div>
        <div><b>${s.best}</b>best score</div>
        <div><b>${this.bestRun}</b>best following run</div>
      </div>
      ${rows ? `<div class="bars">${rows}</div>` : ''}`;
  }

  /** Pitch axis: ±3 semitones around the target, widened (up to an octave) to fit what was sung. */
  pitchRange(sung) {
    let lo = this.target - 3;
    let hi = this.target + 3;
    for (const m of sung) {
      if (m == null) continue;
      lo = Math.min(lo, Math.floor(m) - 1);
      hi = Math.max(hi, Math.ceil(m) + 1);
    }
    return [Math.max(lo, this.target - 12), Math.min(hi, this.target + 12)];
  }

  requestDraw() {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }

  draw() {
    const c = $('chCanvas');
    if (!this.target) { drawMessage(c, 'Press New note to start'); return; }
    const name = this.showName ? midiToName(this.target) : DEGREES[this.item.degree - 1];
    const tol = settings.tolerance;
    if (settings.hidePitch && (this.live || (this.following && this.active))) {
      drawMessage(c, 'Pitch graph hidden while you sing');
      return;
    }
    if (this.following) {
      const now = this.follow.length ? this.follow[this.follow.length - 1].t : 0;
      const [lo, hi] = this.pitchRange(this.follow.filter((f) => f.t >= now - FOLLOW_VIEW).map((f) => this.folded(f.midi)));
      const p = createPlot(c, { lo, hi, t0: now - FOLLOW_VIEW, t1: now });
      if (!p) return;
      drawBand(p, this.target, tol, p.t0, p.t1, name);
      const good = p.col('--good');
      const text = p.col('--text');
      const start = this.hold.start;
      drawTrace(p, this.follow, {
        width: 3,
        pitchOf: (f) => this.folded(f.midi),
        colorOf: (f) => (start != null && f.t >= start ? good : text),
      });
      return;
    }
    const D = this.live?.D ?? this.attempts[this.attempts.length - 1]?.D ?? settings.singDur;
    const newest = this.live ? null : this.attempts[this.attempts.length - 1];
    const current = this.live
      ? this.live.frames.filter((f) => f.voiced).map((f) => this.folded(f.midi))
      : newest ? newest.frames.filter((f) => f.voiced).map((f) => f.midi + newest.result.shift / 100) : [];
    const [lo, hi] = this.pitchRange(current);
    const p = createPlot(c, { lo, hi, t0: 0, t1: D });
    if (!p) return;
    drawBand(p, this.target, tol, 0, D, name);
    for (const a of this.attempts) {
      if (a === newest) continue;
      drawTrace(p, a.frames, { color: p.col('--pale'), width: 2, clip: true, pitchOf: (f) => f.midi + a.result.shift / 100 });
    }
    if (this.live) {
      drawTrace(p, this.live.frames, { color: p.col('--text'), width: 3.5, pitchOf: (f) => this.folded(f.midi) });
      drawPlayhead(p, Math.min(this.recorder.elapsed, D));
    } else if (newest) {
      drawTrace(p, newest.frames, { color: p.col('--text'), width: 3.5, pitchOf: (f) => f.midi + newest.result.shift / 100 });
    }
  }
}
