// Microphone capture: raw PCM via an AudioWorklet (sample-accurate timing for
// grading and playback alignment) plus live pitch frames.
import { detectPitch } from './pitch.js';
import { freqToMidi } from './music.js';

const CHUNK = 1024;
const WINDOW = 2048;

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
    this.samples = 0;
    this.chunks = [];
    this.onFrame = null; // ({ t, midi, voiced, rms }) => void
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
    let t = null;
    if (this.recording) {
      this.chunks.push(c);
      this.samples += c.length;
      t = (this.samples - WINDOW / 2) / this.sr; // centre of the analysis window
    }
    const p = detectPitch(this.window, this.sr);
    const voiced = p.freq > 0 && p.clarity > 0.8 && p.rms > 0.01;
    this.onFrame?.({ t, midi: voiced ? freqToMidi(p.freq) : null, voiced, rms: p.rms });
  }

  get elapsed() {
    return this.recording || this.samples ? this.samples / this.sr : 0;
  }

  start() {
    this.chunks = [];
    this.samples = 0;
    this.recording = true;
  }

  stop() {
    this.recording = false;
    const out = this.engine.ctx.createBuffer(1, Math.max(1, this.samples), this.sr);
    let o = 0;
    for (const c of this.chunks) {
      out.copyToChannel(c, 0, o);
      o += c.length;
    }
    return out;
  }
}
