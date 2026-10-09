// Pitch of a voice singing over known backing music picked up by the same microphone
// (speakers instead of headphones). The backing is measured on its own first (max-hold
// spectra through the mic, one per slice of its repeating cycle); while singing, only what
// rises clearly above the matching profile counts, and the pitch is the fundamental whose
// harmonics best explain it (harmonic sum).
// Best effort: a sung note's harmonics that coincide with the chord's are masked unless the
// voice is clearly louder than the speakers at the microphone.
import { freqToMidi } from './music.js?v=20261009205629';

const MARGIN_DB = 6; // the voice must exceed the backing profile by this much to count
const FLOOR_DB = -95; // ...and this absolute level (analyser dBFS)
const SPREAD_BINS = 2; // the profile is widened by this many bins (spectral leakage, slight detuning)
const HARMONICS = 10;
const DECAY = 0.84; // weight of harmonic n is DECAY^(n-1): favours the true fundamental over its sub-octave
const CAP_DB = 30; // one very loud harmonic can't decide alone
const STEP_CENTS = 10;
const MIN_PRESENT = 3; // harmonics (of the first 6) that must be heard
const PRESENT_DB = 4;
const MIN_SALIENCE = 28;
const MAX_HARMONIC_HZ = 5000;

/** Empty backing profile for `bins` FFT bins. */
export const emptyProfile = (bins) => new Float32Array(bins).fill(-Infinity);

/** Fold one analyser frame (dB per bin) into the profile: per-bin maximum, widened by SPREAD_BINS. */
export function holdMax(profile, frame) {
  const n = frame.length;
  for (let i = 0; i < n; i++) {
    let m = frame[i];
    for (let k = 1; k <= SPREAD_BINS; k++) {
      if (i - k >= 0 && frame[i - k] > m) m = frame[i - k];
      if (i + k < n && frame[i + k] > m) m = frame[i + k];
    }
    if (m > profile[i]) profile[i] = m;
  }
}

/**
 * Detect the sung pitch in `frame` (dB per FFT bin) given the backing `profile`.
 * Returns { voiced, midi, freq, salience }.
 */
export function detectOverBacking(frame, profile, binHz, { fmin = 70, fmax = 1100 } = {}) {
  const n = frame.length;
  // Excess over the backing, per bin (dB, ≥ 0)
  const ex = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const e = frame[i] - Math.max(profile[i] + MARGIN_DB, FLOOR_DB);
    if (e > 0) { ex[i] = Math.min(e, CAP_DB); any = true; }
  }
  if (!any) return { voiced: false, midi: null, freq: 0, salience: 0 };
  const at = (f) => {
    const c = Math.round(f / binHz);
    if (c < 1 || c >= n - 1) return 0;
    return Math.max(ex[c - 1], ex[c], ex[c + 1]);
  };
  let best = 0;
  let bestF = 0;
  const steps = Math.floor((1200 * Math.log2(fmax / fmin)) / STEP_CENTS);
  for (let s = 0; s <= steps; s++) {
    const f0 = fmin * 2 ** ((s * STEP_CENTS) / 1200);
    let sal = 0;
    let w = 1;
    for (let h = 1; h <= HARMONICS && h * f0 < MAX_HARMONIC_HZ; h++) {
      sal += w * at(h * f0);
      w *= DECAY;
    }
    if (sal > best) { best = sal; bestF = f0; }
  }
  if (best < MIN_SALIENCE) return { voiced: false, midi: null, freq: 0, salience: best };
  let present = 0;
  for (let h = 1; h <= 6; h++) if (at(h * bestF) >= PRESENT_DB) present++;
  if (present < MIN_PRESENT) return { voiced: false, midi: null, freq: 0, salience: best };

  // Refine: each audible harmonic's interpolated peak frequency ÷ its number, weighted by its excess.
  let num = 0;
  let den = 0;
  for (let h = 1; h <= HARMONICS && h * bestF < MAX_HARMONIC_HZ; h++) {
    const c = Math.round((h * bestF) / binHz);
    const half = Math.max(1, Math.round((h * bestF * 0.012) / binHz)); // ±20 cents
    let pk = -1;
    for (let i = Math.max(1, c - half); i <= Math.min(n - 2, c + half); i++) {
      if (ex[i] > 0 && (pk < 0 || frame[i] > frame[pk])) pk = i;
    }
    if (pk < 0 || ex[pk] < PRESENT_DB) continue;
    const a = frame[pk - 1], b = frame[pk], cc = frame[pk + 1];
    const d = a - 2 * b + cc;
    const shift = d && Number.isFinite(d) ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / d)) : 0;
    num += ex[pk] * (((pk + shift) * binHz) / h);
    den += ex[pk];
  }
  const freq = den ? num / den : bestF;
  return { voiced: true, midi: freqToMidi(freq), freq, salience: best };
}
