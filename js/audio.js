// Audio playback: sampled instruments (loaded on demand) with a synth fallback.
import { INSTRUMENTS } from './instruments.js';
import { midiToName, midiToFreq } from './music.js';

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map(); // "sf:midi" -> Promise<AudioBuffer>
    this.active = new Set();
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  load(instKey, midi) {
    const inst = INSTRUMENTS[instKey];
    if (!inst.sf) return Promise.resolve(null);
    const key = `${inst.sf}:${midi}`;
    if (!this.buffers.has(key)) {
      const url = `${SF_BASE}/${inst.sf}-mp3/${midiToName(midi, true)}.mp3`;
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          return r.arrayBuffer();
        })
        .then((b) => this.ensure().decodeAudioData(b));
      p.catch(() => this.buffers.delete(key)); // allow retry later
      this.buffers.set(key, p);
    }
    return this.buffers.get(key);
  }

  /** Load a list of notes; resolves to the number of failures. */
  async preload(instKey, midis, onProgress) {
    let done = 0;
    let failed = 0;
    await Promise.all(
      midis.map((m) =>
        this.load(instKey, m)
          .then(() => done++, () => failed++)
          .finally(() => onProgress?.(done, failed, midis.length)),
      ),
    );
    return failed;
  }

  /**
   * Schedule notes one after another. Returns { start, end, fallback } in
   * AudioContext time; `fallback` is true if any sample failed and a synth
   * tone was used instead.
   */
  async playSequence(instKey, midis, { dur = 1, gap = 0.08, when, gain = 1 } = {}) {
    const ctx = this.ensure();
    const bufs = await Promise.all(midis.map((m) => this.load(instKey, m).catch(() => null)));
    const fallback = !!INSTRUMENTS[instKey].sf && bufs.some((b) => !b);
    let t = when ?? ctx.currentTime + 0.06;
    const start = t;
    midis.forEach((m, i) => {
      this.playNote(bufs[i], m, t, dur, gain);
      t += dur + gap;
    });
    return { start, end: t - gap, fallback };
  }

  playNote(buf, midi, when, dur, gain = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.master);
    let src;
    if (buf) {
      src = ctx.createBufferSource();
      src.buffer = buf;
      g.gain.setValueAtTime(gain, when);
    } else {
      src = ctx.createOscillator();
      src.type = 'triangle';
      src.frequency.value = midiToFreq(midi);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.35 * gain, when + 0.02);
    }
    g.gain.setTargetAtTime(0, when + dur, 0.06);
    src.connect(g);
    src.start(when);
    src.stop(when + dur + 0.5);
    this._track(src);
  }

  playBuffer(buffer, when, gain = 1) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain;
    src.buffer = buffer;
    src.connect(g).connect(this.master);
    src.start(when ?? ctx.currentTime + 0.05);
    this._track(src);
    return src;
  }

  click(when, accent = false) {
    const ctx = this.ensure();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.25, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.1);
    this._track(osc);
  }

  _track(src) {
    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  stopAll() {
    for (const s of this.active) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.active.clear();
  }

  /** Resolve once the AudioContext clock reaches `t`. */
  waitUntil(t) {
    const ms = Math.max(0, (t - this.ctx.currentTime) * 1000);
    return new Promise((r) => setTimeout(r, ms));
  }
}
