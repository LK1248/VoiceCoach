// Microphone capture: raw PCM via an AudioWorklet (sample-accurate timing for
// grading and playback alignment) plus live pitch frames.
import { detectPitch } from './pitch.js?v=20260930215851';
import { freqToMidi } from './music.js?v=20260930215851';

const CHUNK = 1024;
const WINDOW = 2048;
const HISTORY_SEC = 1.5; // how far back a recording can be back-dated

const WORKLET_SRC = `
class RecProc extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === ${CHUNK}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('rec-proc', RecProc);
`;

export class MicRecorder {
  constructor(engine) {
    this.engine = engine;
    this.ready = false;
    this.recording = false;
    this.window = new Float32Array(WINDOW);
    this.abs = 0; // total samples received since init
    this.startAbs = 0; // absolute sample where the current recording starts
    this.history = []; // recent chunks { start, data }, so a recording can be back-dated
    this.recentFrames = []; // recent pitch frames, same purpose
    this.chunks = [];
    this.onFrame = null; // ({ abs, t, midi, voiced, rms }) => void
  }

  async init() {
    if (this.ready) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is unavailable. Open the app via http://localhost or https.');
    }
    const ctx = this.engine.ensure();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.sr = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'rec-proc');
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the node pulled by the graph without monitoring the mic
    src.connect(this.node).connect(mute).connect(ctx.destination);
    this.node.port.onmessage = (e) => this._chunk(e.data);
    this.ready = true;
  }

  _chunk(c) {
    this.window.copyWithin(0, c.length);
    this.window.set(c, WINDOW - c.length);
    const chunkStart = this.abs;
    this.abs += c.length;
    const keepFrom = this.abs - HISTORY_SEC * this.sr;
    this.history.push({ start: chunkStart, data: c });
    while (this.history[0].start + CHUNK < keepFrom) this.history.shift();
    if (this.recording) this.chunks.push(c);

    const p = detectPitch(this.window, this.sr);
    const voiced = p.freq > 0 && p.clarity > 0.8 && p.rms > 0.01;
    const center = this.abs - WINDOW / 2; // centre of the analysis window
    const frame = {
      abs: center,
      t: this.recording ? (center - this.startAbs) / this.sr : null,
      midi: voiced ? freqToMidi(p.freq) : null,
      voiced,
      rms: p.rms,
    };
    this.recentFrames.push(frame);
    while (this.recentFrames[0].abs < keepFrom) this.recentFrames.shift();
    this.onFrame?.(frame);
  }

  get elapsed() {
    return this.recording ? (this.abs - this.startAbs) / this.sr : 0;
  }

  /**
   * Start recording. `fromAbs` (an absolute sample index up to HISTORY_SEC in
   * the past) back-dates the start using the history buffer. Returns the pitch
   * frames already captured since the start, with `t` filled in.
   */
  start(fromAbs = this.abs) {
    const past = this.history.filter((h) => h.start + h.data.length > fromAbs);
    this.startAbs = past.length ? past[0].start : this.abs; // chunk-aligned
    this.chunks = past.map((h) => h.data);
    this.recording = true;
    return this.recentFrames
      .filter((f) => f.abs >= this.startAbs)
      .map((f) => ({ ...f, t: (f.abs - this.startAbs) / this.sr }));
  }

  stop() {
    this.recording = false;
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = this.engine.ctx.createBuffer(1, Math.max(1, n), this.sr);
    let o = 0;
    for (const c of this.chunks) {
      out.copyToChannel(c, 0, o);
      o += c.length;
    }
    return out;
  }
}
