// Audio playback: sampled instruments (loaded on demand) with a synth fallback.
import { INSTRUMENTS } from './instruments.js?v=20260930221223';
import { midiToName, midiToFreq } from './music.js?v=20260930221223';

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';
const VOICE_BASE = 'samples/voices/';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map(); // url -> Promise<AudioBuffer>
    this.manifest = null; // Promise of samples/voices/manifest.json
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

  fetchBuffer(url) {
    if (!this.buffers.has(url)) {
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          return r.arrayBuffer();
        })
        .then((b) => this.ensure().decodeAudioData(b));
      p.catch(() => this.buffers.delete(url)); // allow retry later
      this.buffers.set(url, p);
    }
    return this.buffers.get(url);
  }

  loadManifest() {
    if (!this.manifest) {
      this.manifest = fetch(`${VOICE_BASE}manifest.json`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for voice manifest`);
        return r.json();
      });
      this.manifest.catch(() => { this.manifest = null; });
    }
    return this.manifest;
  }

  /**
   * Resolve the sample for a note: { buf, rate, loop } or null for the synth.
   * Recorded voices use the nearest recorded pitch, retuned via playbackRate
   * from its measured f0, and loop their steady part so notes can be any length.
   */
  async loadSample(instKey, midi, vowel = 'A') {
    const inst = INSTRUMENTS[instKey];
    if (inst.vocalset) {
      const manifest = await this.loadManifest();
      const notes = manifest.voices[inst.vocalset].notes[vowel.toLowerCase()];
      const e = notes.reduce((a, b) => (Math.abs(b.midi - midi) < Math.abs(a.midi - midi) ? b : a));
      const buf = await this.fetchBuffer(VOICE_BASE + e.file);
      return { buf, rate: 2 ** ((midi - e.f0) / 12), loop: [e.loopStart, Math.min(e.loopEnd, buf.duration)] };
    }
    if (inst.sf) {
      const buf = await this.fetchBuffer(`${SF_BASE}/${inst.sf}-mp3/${midiToName(midi, true)}.mp3`);
      return { buf, rate: 1, loop: null };
    }
    return null;
  }

  /** Load [midi, vowel] pairs; resolves to the number of failures. */
  async preload(instKey, notes, onProgress) {
    let done = 0;
    let failed = 0;
    await Promise.all(
      notes.map(([m, v]) =>
        this.loadSample(instKey, m, v)
          .then(() => done++, () => failed++)
          .finally(() => onProgress?.(done, failed, notes.length)),
      ),
    );
    return failed;
  }

  /**
   * Schedule notes one after another. Returns { start, end, fallback } in
   * AudioContext time; `fallback` is true if any sample failed and a synth
   * tone was used instead.
   */
  async playSequence(instKey, midis, { dur = 1, gap = 0.08, when, gain = 1, vowels = [] } = {}) {
    const ctx = this.ensure();
    const inst = INSTRUMENTS[instKey];
    const samples = await Promise.all(
      midis.map((m, i) => this.loadSample(instKey, m, vowels[i]).catch(() => null)),
    );
    const fallback = !!(inst.sf || inst.vocalset) && samples.some((s) => !s);
    let t = when ?? ctx.currentTime + 0.06;
    const start = t;
    midis.forEach((m, i) => {
      this.playNote(samples[i], m, t, dur, gain * (inst.gain ?? 1));
      t += dur + gap;
    });
    return { start, end: t - gap, fallback };
  }

  playNote(sample, midi, when, dur, gain = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.master);
    let src;
    if (sample) {
      src = ctx.createBufferSource();
      src.buffer = sample.buf;
      src.playbackRate.value = sample.rate;
      if (sample.loop) {
        src.loop = true;
        [src.loopStart, src.loopEnd] = sample.loop;
      }
      g.gain.setValueAtTime(gain, when);
    } else {
      src = ctx.createOscillator();
      src.type = 'triangle';
      src.frequency.value = midiToFreq(midi);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.08 * gain, when + 0.02); // ~RMS of the samples
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
