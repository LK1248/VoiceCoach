// Microphone capture: raw PCM via an AudioWorklet (sample-accurate timing for
// grading and playback alignment) plus live pitch frames.
import { detectPitch } from './pitch.js?v=20261121021911';
import { makeSpectrumAnalyser } from './audio.js?v=20261121021911';
import { freqToMidi } from './music.js?v=20261121021911';

const CHUNK = 1024;
const WINDOW = 2048;
const HISTORY_SEC = 1.5; // how far back a recording can be back-dated
// Voicing gate. A fixed level threshold fails with quiet microphones, so the level is judged
// against the room: the noise floor is tracked as a running minimum of the frame level that
// creeps up slowly (doubling takes ~30 s, so it survives long notes and drops at once in any
// pause), and a frame is voiced when it is clearly periodic and stands above that floor.
const MIN_CLARITY = 0.8;
const MIN_RMS = 0.001; // about -60 dBFS: absolute minimum
const FLOOR_RATIO = 2.5; // ...and this many times (8 dB) above the noise floor
const FLOOR_RISE = 1.0005; // per frame (~21 ms)
// Rumble filter for pitch detection: 4th-order Butterworth high-pass at 60 Hz (two biquads).
// Some microphones pick up strong sub-60 Hz rumble that, with quiet singing, swamps the voice's
// periodicity. Recordings, the level meter and Vocal Range's raw values stay unfiltered.
const RUMBLE_HZ = 60;
const RUMBLE_Q = [0.5412, 1.3066];

/** RBJ high-pass biquad coefficients, normalised. */
function highpass(f0, q, sr) {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Mic level as a 0–100 meter position: −60 dBFS … −10 dBFS, so quiet microphones still show. */
export const levelPercent = (rms) => Math.max(0, Math.min(100, (20 * Math.log10(rms + 1e-9) + 60) * 2));
const HANN = Float32Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));

/** Power of one frequency in a Hann-windowed buffer (Goertzel). */
function tonePower(buf, freq, sr) {
  const w = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] * HANN[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

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
    this.filtered = new Float32Array(WINDOW); // the same window through the rumble filter
    this.hp = null; // filter stages (coefficients + state), set up once the sample rate is known
    this.abs = 0; // total samples received since init
    this.startAbs = 0; // absolute sample where the current recording starts
    this.history = []; // recent chunks { start, data }, so a recording can be back-dated
    this.recentFrames = []; // recent pitch frames, same purpose
    this.chunks = [];
    this.onFrame = null; // ({ abs, t, midi, voiced, rms }) => void
    this.floor = Infinity; // tracked noise-floor level (rms)
    this.deviceId = null; // chosen microphone; null = the browser's default
    this.onDevice = null; // () => void, after a microphone has been opened
  }

  /** Open a microphone: the chosen one, or the default if it is gone. */
  async openStream() {
    const want = this.deviceId ? { ...MIC_CONSTRAINTS, deviceId: { exact: this.deviceId } } : MIC_CONSTRAINTS;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: want });
    } catch (err) {
      if (!this.deviceId || !['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw err;
      this.deviceId = null; // unplugged since it was chosen
      return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    }
  }

  /** Label and id of the microphone in use (null before the first use). */
  get device() {
    const track = this.stream?.getAudioTracks()[0];
    return track ? { label: track.label, id: track.getSettings?.().deviceId ?? null } : null;
  }

  /** Choose the microphone (null = default). Switches at once if one is already open. */
  async setDevice(id) {
    this.deviceId = id || null;
    if (!this.ready) return;
    const stream = await this.openStream();
    this.micSource.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.micSource = this.engine.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.source);
    this.floor = Infinity; // a different microphone has a different noise floor
    this.onDevice?.();
  }

  async init() {
    if (this.ready) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is unavailable. Open the app via http://localhost or https.');
    }
    const ctx = this.engine.ensure();
    // iOS Safari: route as a play-and-record session (better with headsets).
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    this.stream = await this.openStream();
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.sr = ctx.sampleRate;
    // Everything listens to `source`, a pass-through node, so the microphone behind it can change.
    this.micSource = ctx.createMediaStreamSource(this.stream);
    const src = (this.source = ctx.createGain());
    this.micSource.connect(src);
    this.node = new AudioWorkletNode(ctx, 'rec-proc');
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the node pulled by the graph without monitoring the mic
    src.connect(this.node).connect(mute).connect(ctx.destination);
    // Spectrum view feed: 4th-order Butterworth high-pass at 65 Hz (two biquads)
    // to cut rumble and mains hum below the singing range. Display only;
    // pitch detection and recordings use the unfiltered signal.
    this.analyser = makeSpectrumAnalyser(ctx);
    let feed = src;
    for (const q of [0.541, 1.307]) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 65;
      hp.Q.value = q;
      feed = feed.connect(hp);
    }
    feed.connect(this.analyser);
    this.node.port.onmessage = (e) => this._chunk(e.data);
    this.ready = true;
    this.onDevice?.();
  }

  /** Run a chunk through the rumble filter (state carries over between chunks). */
  _filter(c) {
    this.hp ??= RUMBLE_Q.map((q) => ({ ...highpass(RUMBLE_HZ, q, this.sr), x1: 0, x2: 0, y1: 0, y2: 0 }));
    const out = Float32Array.from(c);
    for (const st of this.hp) {
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
        st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
        out[i] = y;
      }
    }
    return out;
  }

  _chunk(c) {
    this.window.copyWithin(0, c.length);
    this.window.set(c, WINDOW - c.length);
    this.filtered.copyWithin(0, c.length);
    this.filtered.set(this._filter(c), WINDOW - c.length);
    const chunkStart = this.abs;
    this.abs += c.length;
    const keepFrom = this.abs - HISTORY_SEC * this.sr;
    this.history.push({ start: chunkStart, data: c });
    while (this.history[0].start + CHUNK < keepFrom) this.history.shift();
    if (this.recording) this.chunks.push(c);

    const p = detectPitch(this.window, this.sr); // raw: Vocal Range's own voicing rule and H1–H2
    const q = detectPitch(this.filtered, this.sr); // rumble removed: the shared voicing decision
    // Digital silence (e.g. before the microphone delivers audio) must not set the noise floor.
    if (q.rms > 1e-6) this.floor = Math.min(q.rms, Math.max(this.floor * FLOOR_RISE, 1e-5));
    const voiced = q.freq > 0 && q.clarity > MIN_CLARITY && q.rms > Math.max(MIN_RMS, FLOOR_RATIO * this.floor);
    const center = this.abs - WINDOW / 2; // centre of the analysis window
    const frame = {
      abs: center,
      t: this.recording ? (center - this.startAbs) / this.sr : null,
      midi: voiced ? freqToMidi(q.freq) : null,
      voiced,
      rms: p.rms,
      // Raw detector output, for themes that apply their own voicing rule (Vocal Range).
      rawMidi: p.freq > 0 ? freqToMidi(p.freq) : null,
      clarity: p.clarity,
      // H1–H2 (dB): level of the fundamental over the 2nd harmonic. Rises sharply
      // when the voice flips from chest (M1) to head/falsetto (M2).
      h12: p.freq > 0 && 2 * p.freq < this.sr / 2
        ? 10 * Math.log10((tonePower(this.window, p.freq, this.sr) + 1e-20) / (tonePower(this.window, 2 * p.freq, this.sr) + 1e-20))
        : null,
    };
    this.recentFrames.push(frame);
    while (this.recentFrames[0].abs < keepFrom) this.recentFrames.shift();
    this.onFrame?.(frame);
  }

  /** Seconds the mic signal lags reality (e.g. Bluetooth), where the browser reports it. */
  get inputLatency() {
    return this.stream?.getAudioTracks()[0]?.getSettings?.().latency || 0;
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
