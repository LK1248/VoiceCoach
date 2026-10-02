// Shared pitch grading: the same per-note metric is used by every singing theme.
import { median, midiToName } from './music.js?v=20261002164634';

export const GRADE_FROM = 0.25; // ignore the first 25% of a note window (onset / glide)
export const GRADE_TO = 0.95;

/** Voiced-frame deviations (cents) from `target` within [t0, t1] of a take. */
export function segmentCents(frames, target, t0, t1) {
  const win = frames.filter((f) => f.t >= t0 && f.t <= t1);
  const raw = win.filter((f) => f.voiced).map((f) => (f.midi - target) * 100);
  return { total: win.length, raw };
}

/** Whole-octave correction (cents) that brings these deviations nearest to 0. */
export const octaveShift = (raw) => (raw.length ? -1200 * Math.round(median(raw) / 1200) : 0);

/**
 * Score one sung note: median deviation (accuracy, −2 pts per cent beyond
 * tolerance) weighted by steadiness (share of frames within tolerance of the median).
 */
export function scoreNote(target, { total, raw }, tol, shift = 0) {
  const detected = raw.length >= 3 && raw.length >= 0.3 * total;
  if (!detected) return { target, detected: false, score: 0, ok: false };
  const cents = raw.map((c) => c + shift);
  const med = median(cents);
  const stability = cents.filter((c) => Math.abs(c - med) <= tol).length / cents.length;
  const accuracy = Math.max(0, 100 - 2 * Math.max(0, Math.abs(med) - tol));
  return {
    target,
    detected: true,
    cents: med,
    stability,
    score: Math.round(accuracy * (0.7 + 0.3 * stability)),
    ok: Math.abs(med) <= tol,
  };
}

export const fmtCents = (c) => `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(Math.round(c))}¢`;

/** Result card for one graded note. */
export function noteCardHtml(n, title, tol) {
  if (!n.detected) {
    return `<div class="note no"><div class="line">${title} · target ${midiToName(n.target)}</div>
      <div class="score">—</div><div class="line">No clear pitch detected. Sing louder or closer to the mic.</div></div>`;
  }
  const word = Math.abs(n.cents) <= tol ? 'on pitch' : n.cents > 0 ? 'sharp' : 'flat';
  return `<div class="note ${n.ok ? 'ok' : 'no'}"><div class="line">${title} · target ${midiToName(n.target)}</div>
    <div class="score">${fmtCents(n.cents)} <small>${word}</small></div>
    <div class="line">steadiness ${Math.round(n.stability * 100)}% · score ${n.score}</div></div>`;
}
