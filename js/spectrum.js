// Live spectrum (log frequency × dB) with the first spectral peaks marked and
// the target note's harmonics as guides. Used by Single Note → Pitch alignment.
import { midiToName, freqToMidi } from './music.js?v=20261002235214';

const FMIN = 50;
const FMAX = 8000;
const PEAKS = 4;
// Display grid: evenly spaced in log frequency (constant-Q), so every octave
// gets the same number of points and the same relative smoothing.
const PPO = 48; // points per octave (a quarter semitone apart)
const BAND_OCT = 1 / 36; // each point averages the power in a band this wide
const CENTS_PER_POINT = 1200 / PPO;
const PEAK_HALF_WIDTH_CENTS = 100; // a peak must be the highest within ± this
const VALLEY_WINDOW_CENTS = 250; // valleys either side are searched this far out (H3–H4 are 498¢ apart)
// Measured on the voice/piano samples: real harmonics rise 22–54 dB above the
// neighbouring valleys; spurious bumps (sub-harmonics, string effects) 4–14 dB.
const PEAK_PROMINENCE_DB = 15; // ...and rise this far above the valleys either side
const PEAK_RANGE_DB = 40; // ignore peaks more than this far below the loudest
const PEAK_MIN_DB = -85; // ignore peaks quieter than this (silence / room noise)
const HARMONICS = 8;
const DB_TOP = -20; // fixed level axis (dBFS)
const DB_BOT = -120;
// Display smoothing: baseline averaged over ±1/6 octave (two passes); peaks
// kept at full detail if they pass these (looser) criteria.
const BASELINE_HALF_POINTS = PPO / 6;
const DISPLAY_PEAK_PROMINENCE_DB = 6;
const DISPLAY_PEAK_MIN_DB = -120; // display keeps weak harmonics that the circled-peak search ignores
const DISPLAY_PEAK_RANGE_DB = 60; // weak upper harmonics (35–55 dB down in head voice/falsetto) stay visible

/** Centre frequencies of the log grid, FMIN..FMAX. */
export const LOG_FREQS = Float32Array.from(
  { length: Math.round(Math.log2(FMAX / FMIN) * PPO) + 1 },
  (_, i) => FMIN * 2 ** (i / PPO),
);

/**
 * Resample an FFT dB spectrum (linear bins) onto the log grid. Where a band
 * spans several bins their power is averaged; where it is narrower than a bin
 * (low frequencies) the bins are interpolated smoothly (Catmull-Rom).
 */
export function logSpectrum(db, binHz) {
  const n = db.length;
  const v = (j) => Math.max(db[Math.min(n - 1, Math.max(0, j))], -140);
  const half = 2 ** (BAND_OCT / 2);
  const out = new Float32Array(LOG_FREQS.length);
  for (let k = 0; k < LOG_FREQS.length; k++) {
    const f = LOG_FREQS[k];
    const lo = Math.ceil(f / half / binHz);
    const hi = Math.floor((f * half) / binHz);
    if (hi >= lo) {
      let p = 0;
      for (let i = lo; i <= hi; i++) p += 10 ** (v(i) / 10);
      out[k] = 10 * Math.log10(p / (hi - lo + 1));
    } else {
      const pos = f / binHz;
      const i = Math.floor(pos);
      const t = pos - i;
      const [p0, p1, p2, p3] = [v(i - 1), v(i), v(i + 1), v(i + 2)];
      out[k] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    }
  }
  return out;
}

/**
 * Indices of prominent peaks in a log-grid spectrum, lowest frequency first.
 * Defaults are the strict criteria used for the circled peaks.
 */
function peakIndices(s, { count = Infinity, prominence = PEAK_PROMINENCE_DB, range = PEAK_RANGE_DB, minFreq = FMIN, minDb = PEAK_MIN_DB } = {}) {
  const n = s.length;
  const start = Math.max(1, firstIndexAbove(minFreq));
  let top = -Infinity;
  for (let i = start; i < n; i++) top = Math.max(top, s[i]);
  const floor = Math.max(top - range, minDb);
  const k = Math.round(PEAK_HALF_WIDTH_CENTS / CENTS_PER_POINT);
  const wv = Math.round(VALLEY_WINDOW_CENTS / CENTS_PER_POINT);
  const found = [];
  for (let i = start; i < n - 1 && found.length < count; i++) {
    if (s[i] < floor) continue;
    let isMax = true;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k) && isMax; j++) if (j !== i && s[j] > s[i]) isMax = false;
    if (!isMax) continue;
    let leftMin = s[i];
    let rightMin = s[i];
    for (let j = Math.max(0, i - wv); j < i; j++) leftMin = Math.min(leftMin, s[j]);
    for (let j = i + 1; j <= Math.min(n - 1, i + wv); j++) rightMin = Math.min(rightMin, s[j]);
    if (s[i] - Math.max(leftMin, rightMin) < prominence) continue;
    found.push(i);
    i += k; // next peak must be clearly separate
  }
  return found;
}

/**
 * The first `count` prominent peaks of a log-grid spectrum, lowest frequency
 * first: [{ freq, db }]. Each frequency is refined on the raw FFT bins.
 */
export function findPeaks(s, raw, binHz, { count = PEAKS, minFreq = FMIN } = {}) {
  // `raw` (FFT bins) refines the frequency; without it (averaged spectra) the grid frequency is used.
  return peakIndices(s, { count, minFreq }).map((i) => ({ freq: raw ? refineOnBins(raw, binHz, LOG_FREQS[i]) : LOG_FREQS[i], db: s[i] }));
}

/**
 * Spectral centroid ("brightness") in Hz of a log-grid dB spectrum above `minFreq`:
 * the power-weighted mean frequency (each grid point stands for a band proportional to f).
 */
export function spectralCentroid(s, minFreq = FMIN) {
  let num = 0;
  let den = 0;
  for (let i = firstIndexAbove(minFreq); i < s.length; i++) {
    const f = LOG_FREQS[i];
    const w = 10 ** (s[i] / 10) * f; // power × bandwidth (∝ f)
    num += w * f;
    den += w;
  }
  return den ? num / den : null;
}

const erbRate = (f) => 21.4 * Math.log10(1 + 0.00437 * f);
const erbRateToHz = (e) => (10 ** (e / 21.4) - 1) / 0.00437;
const PERCEPTUAL_RANGE_DB = 60; // points this far below the loudest are treated as inaudible

/**
 * Perceptual brightness in Hz (compare spectralCentroid): the centroid on the ERB-rate scale
 * (the ear's frequency resolution) of a loudness-like pattern, power per ERB raised to 0.3
 * (Stevens' law), after Marozeau & de Cheveigné (2007) and Zwicker's sharpness. Weak high
 * partials count for more than in the power-weighted Hz centroid.
 */
export function perceptualCentroid(s, minFreq = FMIN) {
  const i0 = firstIndexAbove(minFreq);
  let max = -Infinity;
  for (let i = i0; i < s.length; i++) max = Math.max(max, s[i]);
  let num = 0;
  let den = 0;
  for (let i = i0; i < s.length; i++) {
    if (s[i] < max - PERCEPTUAL_RANGE_DB) continue;
    const f = LOG_FREQS[i];
    const erb = 24.7 * (4.37 * f / 1000 + 1); // Hz
    // loudness per ERB × ERB-rate span of this grid point (band ∝ f, d(ERB-rate)/df ∝ 1/erb)
    const w = (10 ** (s[i] / 10) * erb) ** 0.3 * (f / erb);
    num += w * erbRate(f);
    den += w;
  }
  return den ? erbRateToHz(num / den) : null;
}

/** First log-grid index at or above f. */
const firstIndexAbove = (f) => Math.max(0, Math.ceil(Math.log2(f / FMIN) * PPO - 1e-9));

function movingAverage(s, half) {
  const n = s.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { sum += s[j]; cnt++; }
    out[i] = sum / cnt;
  }
  return out;
}

/**
 * Display version of a log-grid spectrum: a heavily smoothed baseline between
 * peaks, with each prominent peak kept at full detail down to where it meets
 * the baseline (so the merged curve stays continuous).
 */
export function cleanSpectrum(s, minFreq = FMIN) {
  const base = movingAverage(movingAverage(s, BASELINE_HALF_POINTS), BASELINE_HALF_POINTS);
  const out = Float32Array.from(base);
  for (const p of peakIndices(s, { prominence: DISPLAY_PEAK_PROMINENCE_DB, range: DISPLAY_PEAK_RANGE_DB, minFreq, minDb: DISPLAY_PEAK_MIN_DB })) {
    if (s[p] <= base[p]) continue;
    for (let i = p; i >= 0 && s[i] > base[i]; i--) out[i] = s[i];
    for (let i = p + 1; i < s.length && s[i] > base[i]; i++) out[i] = s[i];
  }
  return out;
}

/**
 * Spectral subtraction: remove `over` × the room-noise power from each point.
 * What remains is never taken below a *smooth* floor (the noise profile
 * averaged over ±1/3 octave, minus `floorDb`), so tonal room noise (hum, fan
 * whine) is flattened rather than just lowered, and can't read as a peak.
 * Components well above the noise are unchanged.
 */
export function subtractNoise(s, noise, { over = 2, floorDb = 20 } = {}) {
  const floor = movingAverage(noise, PPO / 3);
  return Float32Array.from(s, (v, i) => {
    const p = 10 ** (v / 10) - over * 10 ** (noise[i] / 10);
    return Math.max(p > 0 ? 10 * Math.log10(p) : -Infinity, floor[i] - floorDb);
  });
}

/** Highest raw FFT bin within ±1/24 octave of f, parabolically interpolated. */
function refineOnBins(raw, binHz, f) {
  const lo = Math.max(1, Math.floor((f / 2 ** (1 / 24)) / binHz));
  const hi = Math.min(raw.length - 2, Math.ceil((f * 2 ** (1 / 24)) / binHz));
  let best = lo;
  for (let i = lo; i <= hi; i++) if (raw[i] > raw[best]) best = i;
  const a = raw[best - 1], b = raw[best], c = raw[best + 1];
  const den = a - 2 * b + c;
  const shift = den && Number.isFinite(den) ? (0.5 * (a - c)) / den : 0;
  return (best + Math.max(-0.5, Math.min(0.5, shift))) * binHz;
}

/**
 * Draw the spectrum. `live` and `ghost` are log-grid dB arrays (either may be null).
 * `target` (MIDI) adds dashed guides at its harmonics.
 */
export function drawSpectrum(canvas, {
  live, ghost, noise, target, sourceLabel, peaks, minFreq,
  ghostLabel = 'pale: reference (last played)', hideFreqLabels = false, hidePeakLegend = false,
}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  g.font = '11px system-ui, sans-serif';

  const padL = 42, padR = 10, padT = 22, padB = 20;
  const x = (f) => padL + (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * (w - padL - padR);

  // Level axis: fixed, so peaks can be compared from frame to frame.
  const dbTop = DB_TOP;
  const dbBot = DB_BOT;
  const y = (db) => padT + ((dbTop - Math.max(dbBot, Math.min(dbTop, db))) / (dbTop - dbBot)) * (h - padT - padB);

  // Grid
  g.strokeStyle = col('--grid');
  g.lineWidth = 1;
  g.fillStyle = col('--muted');
  g.textAlign = 'center';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000]) {
    g.beginPath(); g.moveTo(x(f), padT); g.lineTo(x(f), h - padB); g.stroke();
    if (!hideFreqLabels) g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x(f), h - 5);
  }
  if (!hideFreqLabels) g.fillText('Hz', w - padR - 8, h - 5);
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let db = dbBot; db <= dbTop; db += 10) {
    g.beginPath(); g.moveTo(padL, y(db)); g.lineTo(w - padR, y(db)); g.stroke();
    if ((db - dbBot) % 20 === 0) g.fillText(`${db}`, padL - 6, y(db));
  }
  g.save();
  g.translate(10, padT + (h - padT - padB) / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.fillText('dB', 0, 0);
  g.restore();

  // Region below the fundamental (noise only: peaks there are ignored)
  if (minFreq > FMIN) {
    g.fillStyle = col('--grid');
    g.globalAlpha = 0.6;
    g.fillRect(padL, padT, x(minFreq) - padL, h - padT - padB);
    g.globalAlpha = 1;
    g.fillStyle = col('--muted');
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    if (x(minFreq) - padL > 50) g.fillText('below f0', (padL + x(minFreq)) / 2, (padT + h - padB) / 2);
  }

  // Target harmonics (H5 = major third above two octaves, highlighted)
  if (target != null) {
    const f0 = 440 * 2 ** ((target - 69) / 12);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    for (let n = 1; n <= HARMONICS; n++) {
      const f = n * f0;
      if (f < FMIN || f > FMAX) continue;
      g.strokeStyle = n === 5 ? col('--bad') : col('--accent');
      g.globalAlpha = n === 5 ? 0.7 : 0.35;
      g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(x(f), padT); g.lineTo(x(f), h - padB); g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      g.fillStyle = n === 5 ? col('--bad') : col('--accent');
      g.fillText(n === 5 ? 'H5 (M3)' : `H${n}`, x(f), padT - 8);
    }
  }

  // Curves: one point per log-grid frequency (evenly spaced across the plot).
  const curve = (arr) => Array.from(arr, (v, i) => [x(LOG_FREQS[i]), y(v)]);
  const stroke = (pts, color, width, fill) => {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
    if (fill) {
      g.lineTo(pts[pts.length - 1][0], h - padB);
      g.lineTo(pts[0][0], h - padB);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }
  };
  if (noise) {
    g.setLineDash([2, 3]);
    stroke(curve(noise), col('--muted'), 1);
    g.setLineDash([]);
  }
  if (ghost) stroke(curve(ghost), col('--pale'), 2);
  if (live) stroke(curve(live), col('--text'), 1.5, col('--target'));

  // Peaks: numbered circles on the curve; details in a legend box (top right).
  if (peaks?.length) {
    const f1 = peaks[0].freq;
    const lines = [];
    g.textBaseline = 'middle';
    peaks.forEach((p, i) => {
      const px = x(p.freq), py = y(p.db);
      g.strokeStyle = col('--bad');
      g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, 6, 0, 2 * Math.PI); g.stroke();
      g.font = 'bold 11px system-ui, sans-serif';
      g.fillStyle = col('--bad');
      g.textAlign = 'left';
      g.fillText(`${i + 1}`, px + 8, Math.max(padT + 6, py - 8));
      const m = freqToMidi(p.freq);
      const cents = Math.round((m - Math.round(m)) * 100);
      const ratio = p.freq / f1;
      const mult = i && Math.abs(ratio - Math.round(ratio)) < 0.04 ? `  ×${Math.round(ratio)}` : '';
      lines.push(`${i + 1}  ${Math.round(p.freq)} Hz  ${midiToName(Math.round(m))} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢${mult}`);
    });
    g.font = '11px system-ui, sans-serif';
    if (hidePeakLegend) lines.length = 0; // circles stay; frequencies/notes would give the answer away
    const lw = lines.length ? Math.max(...lines.map((l) => g.measureText(l).width)) + 14 : 0;
    const lh = 15;
    const bx = w - padR - lw - 4, by = padT + 4;
    if (lines.length) {
      g.fillStyle = col('--panel');
      g.globalAlpha = 0.9;
      g.fillRect(bx, by, lw, lines.length * lh + 6);
      g.globalAlpha = 1;
      g.strokeStyle = col('--border');
      g.lineWidth = 1;
      g.strokeRect(bx + 0.5, by + 0.5, lw - 1, lines.length * lh + 5);
      g.fillStyle = col('--text');
      lines.forEach((l, i) => g.fillText(l, bx + 7, by + 3 + lh / 2 + i * lh));
    }
  }

  // Legend
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = col('--text');
  g.fillText(sourceLabel || '', padL + 4, padT + 12);
  g.fillStyle = col('--muted');
  let ly = padT + 26;
  if (ghost) { g.fillText(ghostLabel, padL + 4, ly); ly += 14; }
  if (noise) g.fillText('dotted: room noise (subtracted)', padL + 4, ly);
}
