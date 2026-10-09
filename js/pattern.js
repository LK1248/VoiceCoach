// Patterns: hear a melodic pattern (scale, arpeggio, warm-up or random melody) and sing it
// back — or sing along with it — one fixed-length window per note; each note is graded.
import { midiToName } from './music.js?v=20261009205629';
import { pickInstrument } from './instruments.js?v=20261009205629';
import { GRADE_FROM, GRADE_TO, segmentCents, octaveShift, scoreNote, fmtCents } from './grading.js?v=20261009205629';
import { settings, vowelsFor, soundText, instrumentFor } from './settings.js?v=20261009205629';
import { createPlot, drawBand, drawTrace, drawPlayhead, drawMessage } from './plot.js?v=20261009205629';
import { buildPattern } from './patterns.js?v=20261009205629';

const $ = (id) => document.getElementById(id);
const COUNT_IN_BEAT = 0.6; // seconds
const VOICE_FRAMES = 3; // consecutive steady voiced frames (~70 ms) that count as "started singing"
const VOICE_PREROLL = 0.08; // seconds kept before the detected onset
const VOICE_TIMEOUT = 15; // seconds to wait for singing in detect mode
const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'];
const freshStats = () => ({ attempts: 0, scoreSum: 0, passes: 0, per: {} });

/** The range the whole pattern must fit in. */
export const patternRange = () => settings.patRange;

/**
 * Grade a take: note i is expected in [i·D, (i+1)·D). With octave tolerance one octave shift
 * (from the first note heard) applies to every note, so the sung intervals must still be right.
 * `drift` is how far the last note's error has moved from the first note's (cents).
 */
export function gradePattern(frames, targets, D, tol, octaveTolerant) {
  const segs = targets.map((tg, i) => segmentCents(frames, tg, (i + GRADE_FROM) * D, (i + GRADE_TO) * D));
  const first = segs.find((s) => s.raw.length >= 3);
  const shift = octaveTolerant && first ? octaveShift(first.raw) : 0;
  const notes = targets.map((tg, i) => scoreNote(tg, segs[i], tol, shift));
  const heard = notes.filter((n) => n.detected);
  return {
    notes,
    shift,
    drift: heard.length >= 2 ? heard[heard.length - 1].cents - heard[0].cents : null,
    inTune: notes.filter((n) => n.ok).length,
    score: Math.round(notes.reduce((a, n) => a + n.score, 0) / notes.length),
    pass: notes.every((n) => n.ok),
  };
}

export class PatternMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.recorder = recorder;
    this.status = status;
    this.item = null; // { targets, name, root, key, instrument, randomVowels }
    this.frames = [];
    this.take = null;
    this.result = null;
    this.busy = false;
    this.recording = false;
    this.anim = 0;
    this.step = { root: null, dir: 1 }; // "step" start mode: where the last round started
    this.stats = freshStats();

    $('ptStart').onclick = () => this.run(true);
    $('ptRetry').onclick = () => this.run(false);
    $('ptHear').onclick = () => this.hearReference();
    $('ptCmpRef').onclick = () => this.compare('ref');
    $('ptCmpMine').onclick = () => this.compare('mine');
    $('ptCmpBoth').onclick = () => this.compare('both');
    $('ptCmpStop').onclick = () => this.stopPlayback();
    $('ptResetStats').onclick = () => { this.stats = freshStats(); this.renderStats(); };
    new ResizeObserver(() => this.draw()).observe($('ptCanvas'));
    this.syncControls();
    this.renderStats();
    this.draw();
  }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (e.code === 'Space' || key === 'n') this.run(true);
    else if (key === 'a') this.hearReference();
    else if (key === 'r' && this.item) this.run(false);
  }

  activate() { this.syncControls(); this.draw(); }

  deactivate() { this.stopPlayback(); }

  onSettings(field) {
    if (field.startsWith('pat')) this.syncControls();
    if (['patFamily', 'patScale', 'patArp', 'patWarm', 'patQuality', 'patShape', 'patOctave', 'patStart', 'patRoot', 'patRange'].includes(field)) {
      this.step.root = null; // a different pattern or starting point: stepping starts over
    }
    if ((field === 'tolerance' || field === 'octaveTolerant') && this.result) {
      this.result = gradePattern(this.frames, this.item.targets, this.D, settings.tolerance, settings.octaveTolerant);
      this.renderResult();
    }
    if (!this.busy) { this.showLabel(!!this.result); this.draw(); }
  }

  /** Show only the settings that apply to the chosen pattern family / start mode. */
  syncControls() {
    const f = settings.patFamily;
    $('patScaleRow').hidden = !(f === 'scale' || f === 'random');
    $('patArpRow').hidden = f !== 'arpeggio';
    $('patWarmRow').hidden = f !== 'warmup';
    $('patShapeRow').hidden = !(f === 'scale' || f === 'arpeggio');
    $('patRandomRow').hidden = f !== 'random';
    $('patRootRow').hidden = settings.patStart === 'random';
    $('ptPrompt').textContent = settings.patFlow === 'along'
      ? 'Sing along with the pattern as it plays (use headphones, so the microphone hears only you).'
      : 'Listen to the pattern, then sing it back: one note per beat.';
  }

  onFrame(f) {
    $('ptLevel').style.width = `${Math.min(100, f.rms * 500)}%`;
    if (this.recording && f.t != null) this.frames.push(f);
    this.voiceWatcher?.(f);
    this.frameWatcher?.();
  }

  setButtons() {
    $('ptStart').disabled = this.busy;
    $('ptRetry').disabled = this.busy || !this.item;
    $('ptHear').disabled = this.busy || !this.item;
    $('ptCompare').hidden = this.busy || !this.take;
  }

  setPhase(text, live = false) {
    const el = $('ptPhase');
    el.innerHTML = text || '&nbsp;';
    el.classList.toggle('live', live);
  }

  showLabel(reveal) {
    const { item } = this;
    const el = $('ptLabel');
    if (!item) { el.innerHTML = '&nbsp;'; return; }
    const notes = reveal || settings.patShowNotes
      ? item.targets.map((m) => midiToName(m)).join(' ')
      : `${midiToName(item.targets[0])} … (${item.targets.length} notes)`;
    el.innerHTML = `${item.name} · in ${midiToName(item.key).replace(/-?\d+$/, '')}<small class="sound">${soundText(item).replace(/vowels (\w) → \w/, 'vowel $1')}</small>
      <div class="pattern-notes">${notes}</div>`;
  }

  /** Draw a new pattern from the settings and place it in the range. */
  pickItem() {
    const { offsets, name } = buildPattern(settings);
    const span = Math.max(...offsets);
    const [lo, hi] = patternRange();
    const maxRoot = Math.max(lo, hi - span); // a pattern wider than the range starts at its bottom
    const clamp = (m) => Math.max(lo, Math.min(maxRoot, m));
    let root;
    if (settings.patStart === 'fixed') {
      root = settings.patRoot;
    } else if (settings.patStart === 'step') {
      // A semitone further each round; turns around at the ends of the range.
      const st = this.step;
      if (st.root == null) {
        st.dir = 1;
        root = clamp(settings.patRoot);
      } else {
        if (st.root + st.dir > maxRoot) st.dir = -1;
        else if (st.root + st.dir < lo) st.dir = 1;
        root = clamp(st.root + st.dir);
      }
      st.root = root;
    } else {
      const cands = [];
      for (let m = lo; m <= maxRoot; m++) if (m !== this.item?.key || lo === maxRoot) cands.push(m);
      root = cands[Math.floor(Math.random() * cands.length)];
    }
    const targets = offsets.map((o) => root + o);
    const v = VOWEL_KEYS[Math.floor(Math.random() * VOWEL_KEYS.length)];
    return { targets, name, key: root, randomVowels: [v, v], instrument: pickInstrument(targets) };
  }

  playReference(when, gain = 1) {
    const { item } = this;
    return this.engine
      .playSequence(instrumentFor(item), item.targets, {
        dur: this.D ?? settings.patDur, gap: 0, when, gain, vowels: item.targets.map(() => vowelsFor(item)[0]),
      })
      .then((r) => { this.status.fallback(r.fallback); return r; });
  }

  async run(newItem) {
    if (this.busy) return;
    this.busy = true;
    this.stopPlayback();
    this.take = null;
    this.result = null;
    $('ptResults').innerHTML = '';
    this.setButtons();

    try {
      if (newItem || !this.item) this.item = this.pickItem();
      if (!this.item.targets.length) throw new Error('This pattern has no notes. Check the settings.');
      const N = this.item.targets.length;
      this.D = settings.patDur;
      this.frames = [];

      this.setPhase('Requesting microphone…');
      await this.recorder.init();
      this.showLabel(false);
      this.draw();
      // Round-trip device delay (e.g. Bluetooth): when the user hears a sound, and when the mic delivers it.
      const lag = this.engine.outputLatency + this.recorder.inputLatency;
      const along = settings.patFlow === 'along';

      if (!along) {
        this.setPhase('👂 Listen…');
        const r = await this.playReference();
        this.animatePlayhead([r.start], N * this.D, true);
        await this.engine.waitUntil(r.end + 0.35 + lag);
        this.anim++;
      }

      if (!along && settings.singStart === 'detect') {
        const name = settings.patShowNotes ? ` (${midiToName(this.item.targets[0])})` : '';
        this.setPhase(`🎤 Start singing the first note${name} when ready…`, true);
        const onset = await this.waitForVoice();
        this.frames = this.recorder.start(onset - Math.round(VOICE_PREROLL * this.recorder.sr));
      } else {
        const t0 = this.engine.ctx.currentTime + 0.05;
        for (let i = 0; i < 3; i++) this.engine.click(t0 + i * COUNT_IN_BEAT, i === 0);
        const downbeat = t0 + 3 * COUNT_IN_BEAT;
        if (along) await this.playReference(downbeat); // scheduled now, sounds on the downbeat
        for (let i = 0; i < 3; i++) {
          await this.engine.waitUntil(t0 + i * COUNT_IN_BEAT);
          this.setPhase(`Get ready… ${3 - i}`);
        }
        // Start the take when the mic delivers audio from the moment the user *hears* the downbeat.
        await this.engine.waitUntil(downbeat + lag);
        this.frames = this.recorder.start();
      }
      this.recording = true;
      await this.liveLoop();
      this.recording = false;
      this.take = this.recorder.stop();

      this.result = gradePattern(this.frames, this.item.targets, this.D, settings.tolerance, settings.octaveTolerant);
      this.recordStats(this.result);
      this.showLabel(true);
      this.setPhase('Done — review your take below.');
      this.renderResult();
    } catch (err) {
      if (this.recording) this.recorder.stop();
      this.recording = false;
      this.engine.stopAll();
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

  /** Resolve with the absolute sample index where steady singing began. */
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

  /**
   * Resolve when every note window is recorded. Completion is checked on each incoming mic
   * frame (keeps working in a background tab); animation frames only redraw.
   */
  liveLoop() {
    const D = this.D;
    const { targets } = this.item;
    const total = targets.length * D;
    return new Promise((resolve) => {
      let finished = false;
      const update = () => {
        const t = this.recorder.elapsed;
        const idx = Math.min(targets.length - 1, Math.floor(t / D));
        const name = settings.patShowNotes ? `: ${midiToName(targets[idx])}` : '';
        this.setPhase(`🎤 Note ${idx + 1} of ${targets.length}${name}`, true);
        if (!finished && t >= total + 0.1) {
          finished = true;
          this.frameWatcher = null;
          resolve();
        }
      };
      this.frameWatcher = update;
      const redraw = () => {
        if (finished) return;
        this.draw(Math.min(this.recorder.elapsed, total));
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
    const p = (s.per[this.item.name] ??= { sum: 0, n: 0 });
    p.sum += r.score;
    p.n++;
    this.renderStats();
  }

  async hearReference() {
    if (!this.item || this.busy) return;
    this.stopPlayback();
    const r = await this.playReference();
    this.animatePlayhead([r.start], this.item.targets.length * (this.D ?? settings.patDur));
  }

  /** The reference is timed to the sung windows, so it lines up with the take. */
  async compare(kind) {
    if (!this.take) return;
    this.stopPlayback();
    const when = this.engine.ensure().currentTime + 0.1;
    if (kind === 'ref') await this.playReference(when);
    if (kind === 'mine') this.engine.playBuffer(this.take, when);
    if (kind === 'both') {
      await this.playReference(when, 0.5);
      this.engine.playBuffer(this.take, when);
    }
    this.animatePlayhead([when], this.item.targets.length * this.D);
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
    const N = r.notes.length;
    const chips = r.notes.map((n) => {
      const name = midiToName(n.target);
      return n.detected
        ? `<span class="chip-score ${n.ok ? 'ok' : 'no'}" title="steadiness ${Math.round(n.stability * 100)}% · score ${n.score}"><b>${name}</b> ${fmtCents(n.cents)}</span>`
        : `<span class="chip-score no" title="No clear pitch detected"><b>${name}</b> —</span>`;
    }).join('');
    const driftLine = r.drift == null ? '' : `<div class="line">Drift from the first note to the last: ${fmtCents(r.drift)}${
      Math.abs(r.drift) <= settings.tolerance ? ' (you stayed in key)' : r.drift > 0 ? ' (you ended sharp of where you started)' : ' (you ended flat of where you started)'}</div>`;
    const octaves = -r.shift / 1200;
    const octLine = octaves
      ? `<div class="line">Sung ${Math.abs(octaves)} octave${Math.abs(octaves) > 1 ? 's' : ''} ${octaves < 0 ? 'lower' : 'higher'} than the reference (accepted).</div>`
      : '';
    $('ptResults').innerHTML = `
      <div class="feedback"><div class="verdict ${r.pass ? 'ok' : 'no'}">Score ${r.score}/100 — ${r.inTune} of ${N} notes within tolerance${r.pass ? ' ✓' : ''}</div></div>
      <div class="attempts pattern-chips">${chips}</div>${driftLine}${octLine}`;
  }

  renderStats() {
    const s = this.stats;
    const avg = s.attempts ? Math.round(s.scoreSum / s.attempts) : 0;
    const rows = Object.entries(s.per)
      .map(([name, p]) => {
        const a = Math.round(p.sum / p.n);
        return `<span>${name}</span><div class="bar"><div style="width:${a}%"></div></div><span class="num">avg ${a}</span>`;
      })
      .join('');
    $('ptStats').innerHTML = `
      <div class="summary">
        <div><b>${s.attempts}</b>attempts</div>
        <div><b>${avg}</b>avg score</div>
        <div><b>${s.passes}</b>all notes in tune</div>
      </div>
      ${rows ? `<div class="bars wide">${rows}</div>` : '<div class="empty">Per-pattern scores will appear here.</div>'}`;
  }

  /** Target bands and the sung pitch trace. `now` = playhead / live time in seconds. */
  draw(now = null) {
    const c = $('ptCanvas');
    if (!this.item) { drawMessage(c, 'Your pitch trace will appear here'); return; }
    const { targets } = this.item;
    const D = this.D ?? settings.patDur;
    const total = targets.length * D;
    const p = createPlot(c, { lo: Math.min(...targets) - 3, hi: Math.max(...targets) + 3, t0: 0, t1: total });
    if (!p) return;
    const tol = settings.tolerance;
    const targetAt = (t) => targets[Math.max(0, Math.min(targets.length - 1, Math.floor(t / D)))];

    // Note windows; the bands and names stay hidden while singing unless "Show note names" is on.
    const reveal = settings.patShowNotes || !this.busy;
    p.g.strokeStyle = p.col('--border');
    p.g.lineWidth = 1;
    for (let i = 1; i < targets.length; i++) {
      p.g.beginPath(); p.g.moveTo(p.x(i * D), p.top); p.g.lineTo(p.x(i * D), p.bottom); p.g.stroke();
    }
    const roomForNames = (p.right - p.left) / targets.length >= 26;
    if (reveal) targets.forEach((tg, i) => drawBand(p, tg, tol, i * D, (i + 1) * D, roomForNames ? midiToName(tg) : ''));

    // Sung pitch (hidden while singing with "Hide pitch graph while singing")
    if (!(settings.patHideTrace && this.recording)) {
      const shift = this.result ? this.result.shift / 100 : 0;
      const pitchOf = (f) => {
        if (this.result) return f.midi + shift;
        return settings.octaveTolerant ? f.midi - 12 * Math.round((f.midi - targetAt(f.t)) / 12) : f.midi;
      };
      const good = p.col('--good');
      const bad = p.col('--bad');
      drawTrace(p, this.frames, { pitchOf, colorOf: (f, m) => (Math.abs(m - targetAt(f.t)) * 100 <= tol ? good : bad) });
    } else {
      p.g.fillStyle = p.col('--muted');
      p.g.textAlign = 'center';
      p.g.fillText('Pitch graph hidden while you sing', (p.left + p.right) / 2, p.top + 14);
    }
    if (now != null) drawPlayhead(p, now);
  }
}
