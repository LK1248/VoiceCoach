// Interval singing: hear two notes, sing them back, get graded on pitch
// accuracy, and compare the recording against the reference.
import { INTERVALS, midiToName, pickItem } from './music.js?v=20261121021911';
import { levelPercent } from './recorder.js?v=20261121021911';
import { gradeTake, noteWindows, noteIndexAt, END_SILENCE, takeLimit } from './align.js?v=20261121021911';
import { fmtCents, noteCardHtml, audioVerdictHtml, audioVerdictHead, offAmount, revealButton } from './grading.js?v=20261121021911';
import { settings, getRange, vowelsFor, soundText, instrumentFor } from './settings.js?v=20261121021911';

const $ = (id) => document.getElementById(id);
const COUNT_IN_BEAT = 0.6; // seconds
const VOICE_FRAMES = 3; // consecutive steady voiced frames (~70 ms) that count as "started singing"
const VOICE_PREROLL = 0.08; // seconds kept before the detected onset
const VOICE_TIMEOUT = 15; // seconds to wait for singing in detect mode
const freshStats = () => ({ attempts: 0, scoreSum: 0, passes: 0, per: {} });

/**
 * Grade the pitch frames of a take with free timing: the take is split into the singer's own
 * notes and matched to the two targets (align.js). With octave tolerance one octave shift
 * applies to both notes, so the sung *interval* must still be correct.
 */
export function grade(frames, item, D, tol, octaveTolerant) {
  const { notes, shift, spans } = gradeTake(frames, [item.root, item.second], tol, octaveTolerant);
  return {
    notes,
    shift,
    spans,
    intervalErr: notes.every((n) => n.detected) ? notes[1].cents - notes[0].cents : null,
    score: Math.round((notes[0].score + notes[1].score) / 2),
    pass: notes.every((n) => n.ok),
  };
}


export class SingMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.recorder = recorder;
    this.status = status;
    this.item = null;
    this.frames = [];
    this.take = null;
    this.result = null;
    this.busy = false;
    this.recording = false;
    this.anim = 0;
    this.stats = freshStats();

    $('sgStart').onclick = () => this.run(true);
    $('sgRetry').onclick = () => this.run(false);
    $('sgHear').onclick = () => this.hearReference();
    $('cmpRef').onclick = () => this.compare('ref');
    $('cmpMine').onclick = () => this.compare('mine');
    $('cmpBoth').onclick = () => this.compare('both');
    $('cmpSeq').onclick = () => this.compare('seq');
    $('cmpStop').onclick = () => this.stopPlayback();
    $('sgResetStats').onclick = () => { this.stats = freshStats(); this.renderStats(); };
    $('sgResults').onclick = (e) => { if (e.target.closest('[data-act="reveal"]')) this.reveal(); };

    new ResizeObserver(() => this.draw()).observe($('sgCanvas'));
    this.renderStats();
    this.draw();
  }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space' || key === 'n') this.run(true);
    else if (key === 'a') this.hearReference();
    else if (key === 'r' && this.item) this.run(false); // Try again (same interval)
  }

  /** Audio only, and this take hasn't been revealed. */
  get hidden() { return settings.audioOnly && !this.revealed; }

  reveal() {
    this.revealed = true;
    $('view-sing').classList.add('revealed');
    this.showLabel(true);
    this.renderResult();
    this.draw();
  }

  onSettings(field) {
    if (field === 'audioOnly') {
      if (this.item && !this.busy) this.showLabel(!!this.result);
      if (this.result) this.renderResult();
      this.renderStats();
    }
    if ((field === 'showInterval' || field === 'vowel' || field === 'instrument') && this.item && !this.busy) this.showLabel(true);
    if ((field === 'tolerance' || field === 'octaveTolerant') && this.result) {
      // Re-grade the existing take with the new criteria (stats keep the original score).
      this.result = grade(this.frames, this.item, this.D, settings.tolerance, settings.octaveTolerant);
      this.renderResult();
    }
    if (!this.busy) this.draw();
  }

  onFrame(f) {
    $('sgLevel').style.width = `${levelPercent(f.rms)}%`;
    if (this.recording && f.t != null) {
      this.frames.push(f);
      if (f.voiced) { this.lastVoicedT = f.t; this.voicedSec += 1024 / this.recorder.sr; }
    }
    this.voiceWatcher?.(f);
    this.frameWatcher?.();
  }

  setButtons() {
    $('sgStart').disabled = this.busy;
    $('sgRetry').disabled = this.busy || !this.item;
    $('sgHear').disabled = this.busy || !this.item;
    $('sgCompare').hidden = this.busy || !this.take;
  }

  setPhase(text, live = false) {
    const el = $('sgPhase');
    el.innerHTML = text || '&nbsp;';
    el.classList.toggle('live', live);
  }

  showLabel(reveal) {
    const { item } = this;
    const el = $('sgInterval');
    if (!item) { el.innerHTML = '&nbsp;'; return; }
    if (this.hidden) { el.textContent = '🎧 Interval ?'; return; }
    const arrow = item.interval.semis === 0 ? '' : item.dir === 'desc' ? '↓' : '↑';
    el.textContent = reveal || settings.showInterval
      ? `${arrow} ${item.interval.name}  ·  ${midiToName(item.root)} → ${midiToName(item.second)}${soundText(item)}`
      : `${arrow} ? ? ?`;
  }

  async run(newItem) {
    if (this.busy) return;
    this.busy = true;
    this.stopPlayback();
    this.take = null;
    this.result = null;
    this.revealed = false;
    $('view-sing').classList.remove('revealed');
    $('sgResults').innerHTML = '';
    this.setButtons();

    try {
      // Harmonic (both notes together) is Interval ID only: sing it as ascending.
      if (newItem || !this.item)
        this.item = pickItem({ ...settings, direction: settings.direction === 'harm' ? 'asc' : settings.direction }, getRange(), this.item);
      this.D = settings.singDur;
      this.frames = [];

      this.setPhase('Requesting microphone…');
      await this.recorder.init();

      this.showLabel(false);
      this.setPhase('👂 Listen…');
      this.draw();
      // Reference notes have exactly the length of the sung windows.
      const r = await this.playReference();
      // Round-trip device delay (e.g. Bluetooth): when the user hears a sound, and when the mic delivers it.
      const lag = this.engine.outputLatency + this.recorder.inputLatency;
      await this.engine.waitUntil(r.end + 0.35 + lag);

      if (settings.singStart === 'detect') {
        const name = settings.showInterval && !settings.audioOnly ? ` (${midiToName(this.item.root)})` : '';
        this.setPhase(`🎤 Start singing note 1${name} when ready…`, true);
        const onset = await this.waitForVoice();
        this.frames = this.recorder.start(onset - Math.round(VOICE_PREROLL * this.recorder.sr));
      } else {
        // Count-in
        const t0 = this.engine.ctx.currentTime + 0.05;
        for (let i = 0; i < 3; i++) this.engine.click(t0 + i * COUNT_IN_BEAT, i === 0);
        for (let i = 0; i < 3; i++) {
          await this.engine.waitUntil(t0 + i * COUNT_IN_BEAT);
          this.setPhase(`Get ready… ${3 - i}`);
        }
        // Start the take when the mic delivers audio from the moment the user *hears* the downbeat.
        await this.engine.waitUntil(t0 + 3 * COUNT_IN_BEAT + lag);
        this.frames = this.recorder.start();
      }
      this.recording = true;
      await this.liveLoop();
      this.recording = false;
      this.take = this.recorder.stop();

      this.result = grade(this.frames, this.item, this.D, settings.tolerance, settings.octaveTolerant);
      this.recordStats(this.result);
      this.showLabel(true);
      this.setPhase('Done — review your take below.');
      this.renderResult();
    } catch (err) {
      if (this.recording) this.recorder.stop();
      this.recording = false;
      const msg = err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : err.message;
      this.setPhase(`⚠️ ${msg}`);
    } finally {
      this.frameWatcher = null;
      this.voiceWatcher = null;
      this.busy = false;
      this.setButtons();
      this.draw();
    }
  }

  /**
   * Resolve with the absolute sample index where steady singing began:
   * VOICE_FRAMES consecutive voiced frames within a semitone of each other.
   */
  waitForVoice() {
    return new Promise((resolve, reject) => {
      let run = [];
      const done = () => { this.voiceWatcher = null; clearTimeout(timer); };
      const timer = setTimeout(() => {
        done();
        reject(new Error('No singing detected. Press Try again when you are ready.'));
      }, VOICE_TIMEOUT * 1000);
      this.voiceWatcher = (f) => {
        if (!f.voiced) { run = []; return; }
        if (run.length && Math.abs(f.midi - run[run.length - 1].midi) > 1) run = [];
        run.push(f);
        if (run.length >= VOICE_FRAMES) {
          done();
          resolve(run[0].abs);
        }
      };
    });
  }

  playReference() {
    return this.engine
      .playSequence(instrumentFor(this.item), [this.item.root, this.item.second], {
        dur: settings.singDur, gap: 0, vowels: vowelsFor(this.item),
      })
      .then((r) => { this.status.fallback(r.fallback); return r; });
  }

  /**
   * Resolve when both note windows are recorded. Completion is checked on each
   * incoming mic frame (keeps working in a background tab, where
   * requestAnimationFrame pauses); animation frames only redraw.
   */
  /**
   * Resolve when the take is over: once the singer has sung and then been silent for
   * END_SILENCE (free timing), or at a hard limit.
   */
  liveLoop() {
    const D = this.D;
    this.lastVoicedT = 0;
    this.voicedSec = 0;
    const names = settings.showInterval && !settings.audioOnly ? `: ${midiToName(this.item.root)} → ${midiToName(this.item.second)}` : '';
    return new Promise((resolve) => {
      let finished = false;
      const update = () => {
        const t = this.recorder.elapsed;
        this.setPhase(`🎤 Sing both notes${names}, at your own pace — stop when you're done`, true);
        const done = t >= takeLimit(2 * D) || (this.voicedSec >= 0.3 && t - this.lastVoicedT >= END_SILENCE);
        if (!finished && done) {
          finished = true;
          this.frameWatcher = null;
          resolve();
        }
      };
      this.frameWatcher = update;
      const redraw = () => {
        if (finished) return;
        this.draw(this.recorder.elapsed);
        requestAnimationFrame(redraw);
      };
      update();
      redraw();
    });
  }

  recordStats(r) {
    const s = this.stats;
    s.attempts++;
    s.scoreSum += r.score;
    if (r.pass) s.passes++;
    const p = (s.per[this.item.interval.semis] ??= { sum: 0, n: 0 });
    p.sum += r.score;
    p.n++;
    this.renderStats();
  }

  async hearReference() {
    if (!this.item || this.busy) return;
    this.stopPlayback();
    await this.playReference();
  }

  /** Reference is re-timed to the sung windows so it lines up with the take. */
  async compare(kind) {
    if (!this.take) return;
    this.stopPlayback();
    const D = this.D;
    const ref = (when, gain = 1) =>
      this.engine.playSequence(instrumentFor(this.item), [this.item.root, this.item.second], { dur: D, gap: 0, when, gain, vowels: vowelsFor(this.item) });
    const when = this.engine.ensure().currentTime + 0.1;
    let heads = [when];
    if (kind === 'ref') await ref(when);
    if (kind === 'mine') this.engine.playBuffer(this.take, when);
    if (kind === 'both') {
      await ref(when, 0.5);
      this.engine.playBuffer(this.take, when);
    }
    if (kind === 'seq') {
      await ref(when);
      const w2 = when + 2 * D + 0.5;
      this.engine.playBuffer(this.take, w2);
      heads = [when, w2];
    }
    this.animatePlayhead(heads, 2 * D);
  }

  animatePlayhead(starts, len) {
    const token = ++this.anim;
    const ctx = this.engine.ctx;
    const tick = () => {
      if (token !== this.anim) return;
      const now = ctx.currentTime;
      const s = starts.find((st) => now >= st && now <= st + len);
      this.draw(s != null ? now - s : null);
      if (now < starts[starts.length - 1] + len) requestAnimationFrame(tick);
      else this.draw();
    };
    tick();
  }

  stopPlayback() {
    this.engine.stopAll();
    this.anim++;
    this.draw();
  }

  renderResult() {
    const r = this.result;
    const tol = settings.tolerance;
    if (this.hidden) {
      // Audio only: sharp/flat per note and whether the interval was too wide or narrow.
      let iv = '';
      if (r.intervalErr != null) {
        const wide = r.intervalErr * (this.item.dir === 'asc' ? 1 : -1); // + = too wide
        iv = `<div class="av-row"><span class="av-title">Interval</span><span class="av-word ${Math.abs(wide) <= tol ? 'ok' : 'no'}">${
          Math.abs(wide) <= tol ? '✓ the right size' : `too ${wide > 0 ? 'wide' : 'narrow'}: ${offAmount(wide)}`}</span><span></span></div>`;
      }
      $('sgResults').innerHTML = `
        <div class="feedback"><div class="verdict ${r.pass ? 'ok' : 'no'}">${r.pass ? 'Both notes on pitch ✓' : 'Keep practising'}</div></div>
        <div class="audio-verdicts">${audioVerdictHead()}${r.notes.map((n, i) => audioVerdictHtml(n, `Note ${i + 1}`, tol)).join('')}${iv}</div>
        ${revealButton()}`;
      return;
    }
    const noteHtml = r.notes.map((n, i) => noteCardHtml(n, `Note ${i + 1}`, tol)).join('');

    let intervalLine = '';
    if (r.intervalErr != null) {
      const sung = (this.item.interval.semis * 100 + (this.item.dir === 'asc' ? 1 : -1) * r.intervalErr) / 100;
      intervalLine = `<div class="line">Sung interval: ${Math.abs(sung).toFixed(2)} semitones (${fmtCents(r.intervalErr * (this.item.dir === 'asc' ? 1 : -1))} vs ${this.item.interval.name}; + = too wide)</div>`;
    }
    const octaves = -r.shift / 1200;
    const octLine = octaves
      ? `<div class="line">Sung ${Math.abs(octaves)} octave${Math.abs(octaves) > 1 ? 's' : ''} ${octaves < 0 ? 'lower' : 'higher'} than the reference (accepted).</div>`
      : '';
    $('sgResults').innerHTML = `
      <div class="feedback"><div class="verdict ${r.pass ? 'ok' : 'no'}">Score ${r.score}/100 — ${r.pass ? 'both notes within tolerance ✓' : 'keep practising'}</div></div>
      <div class="notes">${noteHtml}</div>${intervalLine}${octLine}`;
  }

  renderStats() {
    const s = this.stats;
    const avg = s.attempts ? Math.round(s.scoreSum / s.attempts) : 0;
    // Audio only: the per-interval rows would give away what was played.
    const rows = settings.audioOnly ? '' : INTERVALS.filter((i) => s.per[i.semis])
      .map((i) => {
        const p = s.per[i.semis];
        const a = Math.round(p.sum / p.n);
        return `<span>${i.name}</span><div class="bar"><div style="width:${a}%"></div></div><span class="num">avg ${a}</span>`;
      })
      .join('');
    $('sgStats').innerHTML = `
      <div class="summary">
        <div><b>${s.attempts}</b>attempts</div>
        <div><b>${avg}</b>avg score</div>
        <div><b>${s.passes}</b>passed</div>
      </div>
      ${rows ? `<div class="bars">${rows}</div>` : `<div class="empty">${settings.audioOnly ? 'Per-interval scores are hidden in audio-only mode.' : 'Per-interval scores will appear here.'}</div>`}`;
  }

  /** Draw target bands and the sung pitch trace. `now` = playhead/live time in seconds. */
  draw(now = null) {
    const c = $('sgCanvas');
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    g.font = '11px system-ui, sans-serif';

    if (!this.item) {
      g.fillStyle = col('--muted');
      g.textAlign = 'center';
      g.fillText('Your pitch trace will appear here', w / 2, h / 2);
      return;
    }

    const D = this.D ?? settings.singDur;
    const targets = [this.item.root, this.item.second];
    // Free timing: the axis grows with the take; after grading, the bands sit where each note was sung.
    const lastT = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    const total = Math.max(2 * D, lastT + 0.2, now ?? 0);
    const spans = this.result?.spans ?? null;
    const wins = noteWindows(2, D, spans);
    const idxAt = (t) => noteIndexAt(t, 2, D, spans);
    const lo = Math.min(...targets) - 4;
    const hi = Math.max(...targets) + 4;
    const padL = 42, padR = 10, padT = 8, padB = 20;
    const x = (t) => padL + (t / total) * (w - padL - padR);
    const y = (m) => padT + ((hi - m) / (hi - lo)) * (h - padT - padB);

    // Semitone grid
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      g.strokeStyle = col('--grid');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(padL, y(m));
      g.lineTo(w - padR, y(m));
      g.stroke();
      if (!midiToName(m).includes('#')) {
        g.fillStyle = col('--muted');
        g.fillText(midiToName(m), padL - 6, y(m));
      }
    }
    // Note labels under each note's window
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = col('--muted');
    wins.forEach((wn, i) => { if (wn) g.fillText(`Note ${i + 1}`, x((wn[0] + wn[1]) / 2), h - 5); });

    // Target bands (hidden while singing if the interval is hidden)
    const reveal = settings.showInterval || !this.busy;
    const tolS = settings.tolerance / 100;
    if (reveal) {
      targets.forEach((tg, i) => {
        const wn = wins[i];
        if (!wn) return; // not sung
        g.fillStyle = col('--target');
        g.fillRect(x(wn[0]), y(tg + tolS), x(wn[1]) - x(wn[0]), y(tg - tolS) - y(tg + tolS));
        g.strokeStyle = col('--accent');
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(x(wn[0]), y(tg));
        g.lineTo(x(wn[1]), y(tg));
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = col('--accent');
        g.textAlign = 'left';
        g.fillText(midiToName(tg), x(wn[0]) + 4, y(tg + tolS) - 3);
      });
    }

    // Pitch trace
    const shiftSemis = this.result ? this.result.shift / 100 : 0;
    const display = (f) => {
      const target = targets[idxAt(f.t)];
      if (this.result) return f.midi + shiftSemis;
      if (settings.octaveTolerant) return f.midi - 12 * Math.round((f.midi - target) / 12);
      return f.midi;
    };
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    let prev = null;
    for (const f of this.frames) {
      if (!f.voiced) { prev = null; continue; }
      const m = Math.max(lo, Math.min(hi, display(f)));
      const target = targets[idxAt(f.t)];
      const inTol = Math.abs(m - target) <= tolS;
      if (prev && f.t - prev.t < 0.08) {
        g.strokeStyle = inTol ? col('--good') : col('--bad');
        g.beginPath();
        g.moveTo(x(prev.t), y(prev.m));
        g.lineTo(x(f.t), y(m));
        g.stroke();
      }
      prev = { t: f.t, m };
    }

    // Playhead
    if (now != null) {
      g.strokeStyle = col('--text');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x(now), padT);
      g.lineTo(x(now), h - padB);
      g.stroke();
    }
  }
}
