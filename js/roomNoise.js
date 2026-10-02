// Room-noise calibration shared by the spectrum views (Single Note, Vocal Range):
// one measured noise profile and one on/off state, with a Calibrate button,
// "Subtract room noise" checkbox and status line in each view, kept in sync.
import { LOG_FREQS, logSpectrum } from './spectrum.js?v=20261002184453';

const SETTLE_MS = 400; // let the analyser window clear before measuring
const CAL_MS = 1500; // how long room noise is measured
const READ_MS = 50;
const JUMP_DB = 12; // a frequency whose level jumps this much during calibration...
const JUMP_SHARE = 0.03; // ...at more than this share of frequencies means someone spoke/sang
const SILENT_DB = -110; // frequencies quieter than this are near digital silence: tiny flickers there aren't sounds

const state = { profile: null, on: false, calibrating: false, status: 'not calibrated', warn: false };
const views = [];

/** The noise profile to subtract from mic spectra, or null if not calibrated / switched off. */
export const activeNoiseProfile = () => (state.on && state.profile) || null;

function sync() {
  for (const v of views) {
    v.cal.disabled = state.calibrating;
    v.check.disabled = !state.profile;
    v.check.checked = !!state.profile && state.on;
    v.status.textContent = state.status;
    v.status.classList.toggle('warn', state.warn);
  }
  for (const v of views) v.onChange?.();
}

function setStatus(text, warn = false) {
  state.status = text;
  state.warn = warn;
  sync();
}

/**
 * Wire one view's controls. `beforeCalibrate()` lets the view stop what it is doing
 * (return false to refuse, e.g. mid-siren); `onChange()` redraws its spectrum.
 */
export function bindRoomNoiseControls({ cal, check, status, engine, recorder, beforeCalibrate, onChange }) {
  views.push({ cal, check, status, onChange });
  cal.onclick = () => calibrate(engine, recorder, beforeCalibrate);
  check.onchange = () => { state.on = check.checked; sync(); };
  sync();
}

/**
 * Measure the room's background noise spectrum (~1.5 s of quiet). Room noise is
 * steady (even hum or fan whine), so the measurement is rejected if many
 * frequencies jump in level meanwhile (a voice fills the gaps by 20 dB or more).
 */
async function calibrate(engine, recorder, beforeCalibrate) {
  if (state.calibrating || beforeCalibrate?.() === false) return;
  try {
    await recorder.init();
  } catch (err) {
    setStatus(err.name === 'NotAllowedError' ? 'microphone permission denied' : err.message, true);
    return;
  }
  state.calibrating = true;
  engine.stopAll();
  const an = recorder.analyser;
  const binHz = engine.ctx.sampleRate / an.fftSize;
  const buf = new Float32Array(an.frequencyBinCount);
  const sum = new Float64Array(LOG_FREQS.length);
  const frames = [];
  const start = performance.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const t = performance.now() - start;
      setStatus(`stay quiet… ${Math.max(0, (SETTLE_MS + CAL_MS - t) / 1000).toFixed(1)} s`);
      if (t < SETTLE_MS) return;
      an.getFloatFrequencyData(buf);
      const s = logSpectrum(buf, binHz);
      for (let i = 0; i < s.length; i++) sum[i] += 10 ** (s[i] / 10);
      frames.push(s);
      if (t >= SETTLE_MS + CAL_MS) { clearInterval(timer); resolve(); }
    }, READ_MS);
  });
  state.calibrating = false;
  let jumped = 0;
  for (let i = 0; i < LOG_FREQS.length; i++) {
    const vals = frames.map((fr) => fr[i]).sort((a, b) => a - b);
    const high = vals[Math.floor(vals.length * 0.85)];
    // 85th percentile vs median: sustained sound (a voice) counts, a single click doesn't.
    if (high > SILENT_DB && high - vals[vals.length >> 1] > JUMP_DB) jumped++;
  }
  if (jumped > JUMP_SHARE * LOG_FREQS.length) {
    setStatus('heard a sound during calibration: stay quiet and try again', true);
    return;
  }
  state.profile = Float32Array.from(sum, (v) => 10 * Math.log10(v / frames.length + 1e-20));
  state.on = true;
  setStatus(`calibrated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
}
