// Interval singing: hear two notes, sing them back, get graded on pitch
// accuracy, and compare the recording against the reference.
import { INTERVALS, midiToName, pickItem } from './music.js?v=20261002151213';
import { GRADE_FROM, GRADE_TO, segmentCents, octaveShift, scoreNote, fmtCents, noteCardHtml } from './grading.js?v=20261002151213';
import { settings, getRange, vowelsFor, soundText, instrumentFor } from './settings.js?v=20261002151213';

const $ = (id) => document.getElementById(id);
const COUNT_IN_BEAT = 0.6; // seconds
const VOICE_FRAMES = 3; // consecutive steady voiced frames (~70 ms) that count as "started singing"
const VOICE_PREROLL = 0.08; // seconds kept before the detected onset
const VOICE_TIMEOUT = 15; // seconds to wait for singing in detect mode
const freshStats = () => ({ attempts: 0, scoreSum: 0, passes: 0, per: {} });

/**
 * Grade the pitch frames of a take. Note i is expected in [i*D, (i+1)*D).
 * With octave tolerance, one octave shift (derived from note 1) is applied to
 * both notes so the sung *interval* must still be correct.
 */
export function grade(frames, item, D, tol, octaveTolerant) {
  const segs = [item.root, item.second].map((target, i) =>
    segmentCents(frames, target, (i + GRADE_FROM) * D, (i + GRADE_TO) * D));
  const shift = octaveTolerant ? octaveShift(segs[0].raw.length >= 3 ? segs[0].raw : segs[1].raw) : 0;
  const notes = [item.root, item.second].map((target, i) => scoreNote(target, segs[i], tol, shift));
  return {
    notes,
    shift,
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

  onSettings(field) {
    if ((field === 'showInterval' || field === 'vowel' || field === 'instrument') && this.item && !this.busy) this.showLabel(true);
    if ((field === 'tolerance' || field === 'octaveTolerant') && this.result) {
      // Re-grade the existing take with the new criteria (stats keep the original score).
      this.result = grade(this.frames, this.item, this.D, settings.tolerance, settings.octaveTolerant);
      this.renderResult();
    }
    if (!this.busy) this.draw();
  }

  onFrame(f) {
    $('sgLevel').style.width = `${Math.min(100, f.rms * 500)}%`;
    if (this.recording && f.t != null) this.frames.push(f);
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
    const arrow = item.dir === 'asc' ? '↑' : '↓';
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
    $('sgResults').innerHTML = '';
    this.setButtons();

    try {
      if (newItem || !this.item) this.item = pickItem(settings, getRange(), this.item);
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
        const name = settings.showInterval ? ` (${midiToName(this.item.root)})` : '';
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
  liveLoop() {
    const D = this.D;
    return new Promise((resolve) => {
      let finished = false;
      const update = () => {
        const t = this.recorder.elapsed;
        const idx = t < D ? 0 : 1;
        const target = [this.item.root, this.item.second][idx];
        const name = settings.showInterval ? `: ${midiToName(target)}` : '';
        this.setPhase(`🎤 Sing note ${idx + 1}${name}`, true);
        if (!finished && t >= 2 * D + 0.1) {
          finished = true;
          this.frameWatcher = null;
          resolve();
        }
      };
      this.frameWatcher = update;
      const redraw = () => {
        if (finished) return;
        this.draw(Math.min(this.recorder.elapsed, 2 * D));
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
    const rows = INTERVALS.filter((i) => s.per[i.semis])
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
      ${rows ? `<div class="bars">${rows}</div>` : '<div class="empty">Per-interval scores will appear here.</div>'}`;
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
    const total = 2 * D;
    const targets = [this.item.root, this.item.second];
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
    // Window divider + labels
    g.strokeStyle = col('--border');
    g.beginPath();
    g.moveTo(x(D), padT);
    g.lineTo(x(D), h - padB);
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = col('--muted');
    g.fillText('Note 1', x(D / 2), h - 5);
    g.fillText('Note 2', x(1.5 * D), h - 5);

    // Target bands (hidden while singing if the interval is hidden)
    const reveal = settings.showInterval || !this.busy;
    const tolS = settings.tolerance / 100;
    if (reveal) {
      targets.forEach((tg, i) => {
        g.fillStyle = col('--target');
        g.fillRect(x(i * D), y(tg + tolS), x((i + 1) * D) - x(i * D), y(tg - tolS) - y(tg + tolS));
        g.strokeStyle = col('--accent');
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(x(i * D), y(tg));
        g.lineTo(x((i + 1) * D), y(tg));
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = col('--accent');
        g.textAlign = 'left';
        g.fillText(midiToName(tg), x(i * D) + 4, y(tg + tolS) - 3);
      });
    }

    // Pitch trace
    const shiftSemis = this.result ? this.result.shift / 100 : 0;
    const display = (f) => {
      const target = targets[f.t < D ? 0 : 1];
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
      const target = targets[f.t < D ? 0 : 1];
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
