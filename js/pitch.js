// Monophonic pitch detection using the McLeod Pitch Method (normalized
// square difference function), on a 2x-downsampled window for speed.

const MIN_FREQ = 60;
const MAX_FREQ = 1200;

export function detectPitch(input, sampleRate) {
  let rms = 0;
  for (let i = 0; i < input.length; i++) rms += input[i] * input[i];
  rms = Math.sqrt(rms / input.length);
  if (rms < 0.005) return { freq: 0, clarity: 0, rms };

  // Downsample by 2 (average pairs) — plenty of resolution for the voice range.
  const n = input.length >> 1;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = (input[2 * i] + input[2 * i + 1]) * 0.5;
  const sr = sampleRate / 2;

  const minLag = Math.max(2, Math.floor(sr / MAX_FREQ));
  const maxLag = Math.min(n >> 1, Math.ceil(sr / MIN_FREQ));
  const nsdf = new Float32Array(maxLag + 2);
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    let acf = 0;
    let m = 0;
    for (let i = 0; i < n - tau; i++) {
      const a = buf[i];
      const b = buf[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Skip the initial positive lobe around lag 0.
  let tau = 1;
  while (tau < maxLag && nsdf[tau] > 0) tau++;
  if (tau < minLag) tau = minLag;

  // Collect the highest peak of each positive lobe.
  const peaks = [];
  let curMax = -1;
  let curTau = -1;
  for (; tau <= maxLag; tau++) {
    if (nsdf[tau] > 0) {
      if (nsdf[tau] > curMax) { curMax = nsdf[tau]; curTau = tau; }
    } else if (curTau > 0) {
      peaks.push(curTau);
      curMax = -1;
      curTau = -1;
    }
  }
  if (curTau > 0) peaks.push(curTau);
  if (!peaks.length) return { freq: 0, clarity: 0, rms };

  let highest = 0;
  for (const p of peaks) highest = Math.max(highest, nsdf[p]);
  const threshold = 0.9 * highest;
  const best = peaks.find((p) => nsdf[p] >= threshold);

  // Parabolic interpolation around the chosen peak.
  const y0 = nsdf[best - 1];
  const y1 = nsdf[best];
  const y2 = nsdf[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (y0 - y2) / (2 * denom) : 0;
  return { freq: sr / (best + shift), clarity: y1, rms };
}
