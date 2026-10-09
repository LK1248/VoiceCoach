// Single Note theme.
//  • Pitch alignment: a note plays; every time the user starts singing, a
//    fixed-length attempt is recorded and scored. Earlier attempts stay on the
//    graph in pale gray; the newest is drawn in the text colour, thicker.
//  • Pitch following: the user must hold the note within tolerance for
//    `holdTime` seconds; then the next note plays. Successes are counted per run.
import { midiToName } from './music.js?v=20261009132303';
import { settings, vowelsFor, instrumentFor, soundText } from './settings.js?v=20261009132303';
import { pickInstrument } from './instruments.js?v=20261009132303';
import { getAllowedNotes } from './noteRange.js?v=20261009132303';
import { GRADE_FROM, GRADE_TO, segmentCents, octaveShift, scoreNote, noteCardHtml } from './grading.js?v=20261009132303';
import { activeNoiseProfile, bindRoomNoiseControls } from './roomNoise.js?v=20261009132303';
import { logSpectrum, findPeaks, cleanSpectrum, subtractNoise, drawSpectrum } from './spectrum.js?v=20261009132303';
import { createPlot, drawBand, drawTrace, drawPlayhead, drawMessage } from './plot.js?v=20261009132303';

const $ = (id) => document.getElementById(id);
const VOICE_FRAMES = 3; // consecutive steady voiced frames (~70 ms) that start an attempt
const VOICE_PREROLL = 0.08; // seconds kept before the detected onset
const SILENCE_FRAMES = 8; // ~0.2 s without pitch needed before another attempt can start
const DEAF_TAIL = 0.3; // seconds the mic is ignored after the reference ends (speaker echo)
const MAX_BREAK = 0.2; // pitch following: longest allowed break in the held note
const FOLLOW_VIEW = 6; // seconds shown on the pitch-following graph
const NEXT_DELAY = 600; // ms between a successful match and the next note
const SPECTRUM_INTERVAL = 50; // ms between spectrum updates
const REF_SKIP = 0.15; // s of reference attack left out of the averaged reference spectrum
const F0_FRESH_MS = 200; // a detected sung pitch counts as current for this long
const BELOW_F0_MARGIN = 2 ** (-1 / 12); // spectrum peaks more than a semitone below f0 are ignored
const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const freshStats = () => ({ notes: 0, attempts: 0, scoreSum: 0, best: 0 });

export class SingleMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.recorder = recorder;
    this.status = status;
    this.active = false; // listening to the mic
    this.target = null; // MIDI note to sing
    this.randomVowel = 'A';
    this.deafUntil = 0; // AudioContext time until which mic frames are ignored
    // Pitch alignment
    this.attempts = []; // { frames, D, result }
    this.live = null; // attempt being recorded: { frames, D }
    this.run = []; // voiced frames towards onset detection
    this.needSilence = false;
    this.quiet = 0;
    // Pitch following
    this.follow = []; // recent frames { t, midi, voiced }
    this.hold = { start: null, lastVoiced: -Infinity };
    this.advancing = false;
    this.matched = 0;
    this.bestRun = 0;
    this.stats = freshStats();
    // Spectrum view (pitch alignment)
    this.spec = { refWindow: null, refSum: null, refN: 0, ghost: null, last: null, buf: null };

    $('snNew').onclick = () => this.newNote();
    $('snHear').onclick = () => this.hear();
    $('snStop').onclick = () => this.stop();
    $('snResetRun').onclick = () => { this.matched = 0; this.renderCounter(); };
    $('snResetStats').onclick = () => { this.stats = freshStats(); this.bestRun = 0; this.renderStats(); };
    new ResizeObserver(() => this.draw()).observe($('snCanvas'));
    new ResizeObserver(() => this.redrawSpectrum()).observe($('snSpectrum'));
    this.spectrumLoop();
    // Room-noise subtraction (shared with Vocal Range) and the unfiltered view
    bindRoomNoiseControls({
      cal: $('snNoiseCal'), check: $('snNoiseOn'), status: $('snNoiseStatus'),
      engine, recorder,
      beforeCalibrate: () => { if (this.live) this.abortAttempt(); },
      onChange: () => this.redrawSpectrum(),
    });
    $('snRaw').onchange = () => this.redrawSpectrum();
    this.renderUI();
    this.renderHold(0);
    this.renderStats();
  }

  get following() { return settings.singleMode === 'follow'; }

  /** The current note's randomly drawn sound choices, in the shape settings helpers expect. */
  get soundItem() { return { randomVowels: [this.randomVowel, this.randomVowel], instrument: this.randomInstrument }; }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space' || key === 'n') this.newNote();
    else if (key === 'a') this.hear();
  }

  activate() { this.renderUI(); this.draw(); }

  deactivate() { if (this.active) this.stop(); }

  onSettings(field) {
    if (field === 'singleMode') {
      this.stop(true);
      this.target = null;
      this.attempts = [];
      this.follow = [];
      this.matched = 0;
      this.renderUI();
    }
    if ((field === 'tolerance' || field === 'octaveTolerant') && this.attempts.length) {
      for (const a of this.attempts) a.result = this.gradeAttempt(a.frames, a.D);
      this.renderResults();
    }
    if (field === 'instrument' || field === 'vowel') this.renderUI();
    if (field === 'holdTime') {
      this.renderHold(0);
      this.renderUI(); // prompt mentions the hold time
      const listening = this.active && this.target && !this.advancing && this.engine.ctx?.currentTime >= this.deafUntil;
      if (listening) this.setListeningPhase();
    }
    this.draw();
  }

  // ---- Flow ---------------------------------------------------------------

  async newNote() {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.recorder.init();
      const notes = getAllowedNotes();
      if (!notes.length) {
        this.setPhase('⚠️ No notes selected. Tick at least one note in the sidebar.');
        return;
      }
      const choices = notes.length > 1 ? notes.filter((m) => m !== this.target) : notes;
      this.target = rand(choices);
      this.randomVowel = rand(VOWEL_KEYS);
      this.randomInstrument = pickInstrument([this.target]);
      this.spec.ghost = null;
      this.abortAttempt();
      this.attempts = [];
      this.follow = [];
      this.resetHold();
      if (!this.following) this.stats.notes++;
      this.active = true;
      $('snResults').innerHTML = '';
      this.renderUI();
      this.renderStats();
      await this.playTarget();
    } catch (err) {
      this.setPhase(`⚠️ ${err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : err.message}`);
    } finally {
      this.starting = false;
    }
  }

  async hear() {
    if (!this.target || this.starting) return;
    this.active = true;
    this.renderUI();
    await this.playTarget();
  }

  /** Play the target note; the mic is ignored until it (plus an echo tail) has ended. */
  async playTarget() {
    this.abortAttempt();
    this.engine.stopAll();
    this.deafUntil = Infinity;
    this.setPhase(`👂 Listen: ${midiToName(this.target)}`);
    const r = await this.engine.playSequence(instrumentFor(this.soundItem), [this.target], {
      dur: settings.singDur, vowels: vowelsFor(this.soundItem),
    });
    this.status.fallback(r.fallback);
    this.spec.refWindow = [r.start, r.end];
    this.spec.refSum = null;
    this.spec.refN = 0;
    // Include the round-trip device delay (e.g. Bluetooth) so a late echo isn't taken for singing.
    this.deafUntil = r.end + DEAF_TAIL + this.engine.outputLatency + this.recorder.inputLatency;
    this.resetHold();
    this.run = [];
    this.needSilence = false;
    const target = this.target;
    setTimeout(() => {
      if (this.active && this.target === target && !this.live) this.setListeningPhase();
    }, Math.max(0, (this.deafUntil - this.engine.ctx.currentTime) * 1000));
    this.draw();
  }

  setListeningPhase() {
    const name = midiToName(this.target);
    this.setPhase(this.following
      ? `🎤 Sing ${name} and hold it for ${settings.holdTime.toFixed(1)} s`
      : this.attempts.length
        ? `🎤 Sing ${name} again to retry, or press N for a new note`
        : `🎤 Sing ${name} when ready`, true);
  }

  stop(silent = false) {
    this.active = false;
    this.abortAttempt();
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

  /** Ignore the mic until AudioContext time `t` (e.g. while a note preview plays). */
  ignoreMicUntil(t) {
    if (this.live) this.abortAttempt();
    this.deafUntil = Math.max(this.deafUntil, t);
    this.run = [];
    this.resetHold();
  }

  resetHold() {
    this.hold = { start: null, lastVoiced: -Infinity };
    this.renderHold(0);
  }

  // ---- Mic frames -----------------------------------------------------------

  onFrame(f) {
    $('snLevel').style.width = `${Math.min(100, f.rms * 500)}%`;
    if (f.voiced) this.lastF0 = { hz: 440 * 2 ** ((f.midi - 69) / 12), at: performance.now() };
    if (!this.active || !this.target || this.engine.ctx.currentTime < this.deafUntil) return;
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
    // After an attempt, wait for a short silence so a still-held note
    // doesn't immediately start another attempt.
    if (this.needSilence) {
      this.quiet = f.voiced ? 0 : this.quiet + 1;
      if (this.quiet < SILENCE_FRAMES) return;
      this.needSilence = false;
    }
    if (!f.voiced) { this.run = []; return; }
    if (this.run.length && Math.abs(f.midi - this.run[this.run.length - 1].midi) > 1) this.run = [];
    this.run.push(f);
    if (this.run.length >= VOICE_FRAMES) {
      const past = this.recorder.start(this.run[0].abs - Math.round(VOICE_PREROLL * this.recorder.sr));
      this.live = { frames: past, D: settings.singDur };
      this.run = [];
      this.setPhase(`🎤 Recording ${midiToName(this.target)}…`, true);
    }
  }

  finishAttempt() {
    const { frames, D } = this.live;
    this.recorder.stop();
    this.live = null;
    const result = this.gradeAttempt(frames, D);
    this.attempts.push({ frames, D, result });
    this.stats.attempts++;
    this.stats.scoreSum += result.score;
    this.stats.best = Math.max(this.stats.best, result.score);
    this.needSilence = true;
    this.quiet = 0;
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
    const H = settings.holdTime;
    const inTol = f.voiced && Math.abs(this.folded(f.midi) - this.target) * 100 <= settings.tolerance;
    this.follow.push({ t, midi: f.midi, voiced: f.voiced });
    while (this.follow.length && this.follow[0].t < t - Math.max(FOLLOW_VIEW, H) - 1) this.follow.shift();

    // Held = time since the note came into tolerance, allowing breaks < MAX_BREAK.
    const h = this.hold;
    if (f.voiced) {
      if (inTol && (h.start == null || t - h.lastVoiced > MAX_BREAK)) h.start = t;
      if (!inTol) h.start = null;
      h.lastVoiced = t;
    } else if (h.start != null && t - h.lastVoiced > MAX_BREAK) {
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
    this.renderCounter();
    this.renderStats();
    this.setPhase(`✓ Matched ${midiToName(this.target)}!`);
    setTimeout(async () => {
      this.advancing = false;
      if (!this.active || !this.following) return;
      const notes = getAllowedNotes();
      if (!notes.length) { this.stop(); return; }
      const choices = notes.length > 1 ? notes.filter((m) => m !== this.target) : notes;
      this.target = rand(choices);
      this.randomVowel = rand(VOWEL_KEYS);
      this.randomInstrument = pickInstrument([this.target]);
      this.follow = [];
      this.renderUI();
      await this.playTarget();
    }, NEXT_DELAY);
  }

  // ---- Rendering --------------------------------------------------------------

  setPhase(text, live = false) {
    const el = $('snPhase');
    el.innerHTML = text || '&nbsp;';
    el.classList.toggle('live', live);
  }

  renderUI() {
    const follow = this.following;
    $('snPrompt').textContent = follow
      ? `Sing each note and hold it in tune for ${settings.holdTime.toFixed(1)} s to move on to the next.`
      : 'Hear a note, then sing it. Every attempt is scored; sing again to improve, or press N for a new note.';
    $('snTarget').innerHTML = this.target ? `🎯 ${midiToName(this.target)}<small class="sound">${soundText(this.soundItem).replace(/vowels (\w) → \w/, 'vowel $1')}</small>` : '&nbsp;';
    $('snNew').innerHTML = `${follow && this.target ? '⏭ Skip note' : '▶ New note'} <kbd>N</kbd>`;
    $('snHear').disabled = !this.target;
    $('snStop').disabled = !this.active;
    $('snFollowBox').hidden = !follow;
    $('snResults').hidden = follow;
    $('snSpectrumBox').hidden = follow;
    if (!follow) this.redrawSpectrum();
    if (!this.target) this.setPhase('');
    this.renderCounter();
  }

  renderHold(held) {
    const H = settings.holdTime;
    $('snHoldFill').style.width = `${Math.min(100, (held / H) * 100)}%`;
    $('snHoldText').textContent = `${Math.min(held, H).toFixed(1)} / ${H.toFixed(1)} s`;
  }

  renderCounter() {
    $('snCounter').textContent = this.matched;
  }

  renderResults() {
    const n = this.attempts.length;
    if (!n) { $('snResults').innerHTML = ''; return; }
    const tol = settings.tolerance;
    const last = this.attempts[n - 1].result;
    const octaves = -last.shift / 1200;
    const octLine = octaves
      ? `<div class="line">Sung ${Math.abs(octaves)} octave${Math.abs(octaves) > 1 ? 's' : ''} ${octaves < 0 ? 'lower' : 'higher'} than the reference (accepted).</div>`
      : '';
    const history = this.attempts
      .map((a, i) => `<span class="chip-score ${a.result.ok ? 'ok' : 'no'}${i === n - 1 ? ' latest' : ''}">${a.result.score}</span>`)
      .join('');
    $('snResults').innerHTML = `
      <div class="notes">${noteCardHtml(last, `Attempt ${n}`, tol)}</div>${octLine}
      <div class="attempts"><span class="field-label">Scores on this note:</span> ${history}</div>`;
  }

  renderStats() {
    const s = this.stats;
    const avg = s.attempts ? Math.round(s.scoreSum / s.attempts) : 0;
    $('snStats').innerHTML = `
      <div class="summary">
        <div><b>${s.notes}</b>notes practised</div>
        <div><b>${s.attempts}</b>attempts</div>
        <div><b>${avg}</b>avg score</div>
        <div><b>${s.best}</b>best score</div>
        <div><b>${this.bestRun}</b>best following run</div>
      </div>`;
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

  // ---- Spectrum (pitch alignment) ----------------------------------------------

  spectrumLoop() {
    let last = 0;
    const tick = (now) => {
      if (now - last >= SPECTRUM_INTERVAL) {
        last = now;
        this.updateSpectrum();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Read the reference (while it plays) or the mic, and redraw the spectrum. */
  updateSpectrum() {
    const ctx = this.engine.ctx;
    if (!ctx || this.following || document.body.dataset.mode !== 'single') return;
    const sp = this.spec;
    const now = ctx.currentTime;
    const w = sp.refWindow;
    const playing = w && now >= w[0] && now <= w[1] + 0.15;
    // Anchor: nothing below the fundamental is musical (rumble, hum, handling noise).
    // f0 = the target while the reference plays, else the singer's detected pitch;
    // with no pitch, a floor two semitones under the lowest allowed note.
    const targetHz = 440 * 2 ** ((this.target - 69) / 12);
    const sungF0 = this.lastF0 && performance.now() - this.lastF0.at < F0_FRESH_MS ? this.lastF0.hz : null;
    const lowest = Math.min(...getAllowedNotes(), this.target);
    // (min with the target guards against the detector reporting an octave too high)
    const f0 = playing ? targetHz : sungF0 ? Math.min(sungF0, targetHz) : 440 * 2 ** ((lowest - 2 - 69) / 12);
    const minFreq = f0 * BELOW_F0_MARGIN;
    let analyser;
    let label;
    if (playing) {
      analyser = this.engine.analyser;
      label = `Reference: ${midiToName(this.target)}`;
    } else if (this.active && this.recorder.analyser) {
      analyser = this.recorder.analyser;
      label = this.live ? '🎤 Recording' : '🎤 Microphone';
    } else {
      return; // keep the last frame on screen
    }
    if (!sp.buf || sp.buf.length !== analyser.frequencyBinCount) sp.buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(sp.buf);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const profile = playing ? null : activeNoiseProfile(); // subtract room noise from the mic only
    const raw = logSpectrum(sp.buf, binHz);
    const s = profile ? subtractNoise(raw, profile) : raw;

    // Average the reference's steady part (power domain) for the pale "ghost" curve.
    if (playing && now >= w[0] + REF_SKIP && now <= w[1]) {
      sp.refSum ??= new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) sp.refSum[i] += 10 ** (raw[i] / 10);
      sp.refN++;
    } else if (!playing && sp.refN) {
      sp.ghost = cleanSpectrum(Float32Array.from(sp.refSum, (v) => 10 * Math.log10(v / sp.refN + 1e-20)), targetHz * BELOW_F0_MARGIN);
      sp.refSum = null;
      sp.refN = 0;
    }
    sp.last = {
      clean: cleanSpectrum(s, minFreq),
      raw: s,
      ghost: playing ? null : sp.ghost,
      noise: profile,
      target: this.target,
      sourceLabel: label,
      peaks: findPeaks(s, sp.buf, binHz, { minFreq }),
      minFreq,
    };
    this.redrawSpectrum();
  }

  /** Draw the last spectrum frame; the Unfiltered toggle shows the raw analysis (no smoothing or below-f0 cut). */
  redrawSpectrum() {
    const last = this.spec.last;
    if (!last) {
      drawSpectrum($('snSpectrum'), { live: null, target: this.target, sourceLabel: 'Press New note to start', peaks: [] });
      return;
    }
    const unfiltered = $('snRaw').checked;
    drawSpectrum($('snSpectrum'), {
      ...last,
      live: unfiltered ? last.raw : last.clean,
      minFreq: unfiltered ? undefined : last.minFreq,
      sourceLabel: unfiltered ? `${last.sourceLabel} · unfiltered` : last.sourceLabel,
      target: this.target,
    });
  }

  requestDraw() {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }

  draw() {
    const c = $('snCanvas');
    if (!this.target) { drawMessage(c, 'Press New note to start'); return; }
    const name = midiToName(this.target);
    const tol = settings.tolerance;

    // Sing by ear: the trace appears once the attempt (or the following run) has ended.
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
    // The axis fits only the current recording (live, else the newest attempt);
    // older gray attempts outside it are clipped, so each new attempt starts zoomed in.
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
