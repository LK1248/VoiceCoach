// Shared pitch grading: the same per-note metric is used by every singing theme.
import { median, midiToName } from './music.js?v=20261121021911';

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

/** How far off a pitch error is, in words (beyond the tolerance). */
export const offAmount = (cents) => {
  const a = Math.abs(cents);
  return a <= 50 ? 'a little' : a <= 100 ? 'clearly' : 'more than a semitone';
};

/**
 * Audio-only feedback for one note: on pitch / sharp / flat and roughly how much, with a
 * small flat ← → sharp gauge (±100¢, clamped). No note names, no cents.
 */
export function audioVerdictHtml(n, title, tol) {
  if (!n.detected) {
    return `<div class="av-row"><span class="av-title">${title}</span><span class="av-word no">no clear pitch heard</span><span></span></div>`;
  }
  const ok = Math.abs(n.cents) <= tol;
  const word = ok ? '✓ on pitch' : `${n.cents > 0 ? '♯ sharp' : '♭ flat'}: ${offAmount(n.cents)}`;
  const pos = 50 + Math.max(-100, Math.min(100, n.cents)) / 2;
  const band = Math.min(100, tol); // ±tol on a ±100¢ scale
  return `<div class="av-row"><span class="av-title">${title}</span><span class="av-word ${ok ? 'ok' : 'no'}">${word}</span>
    <span class="gauge" title="flat ← → sharp"><span class="gauge-tol" style="left:${50 - band / 2}%;width:${band}%"></span><i class="${ok ? 'ok' : 'no'}" style="left:${pos}%"></i></span></div>`;
}

/** Header for a list of audio-only verdict rows (labels the gauges). */
export const audioVerdictHead = () => '<div class="av-row av-head"><span></span><span></span><span class="gauge-labels"><span>flat</span><span>sharp</span></span></div>';

/** "Reveal" link shown under audio-only feedback. */
export const revealButton = (act = 'reveal') => `<button class="link reveal-link" data-act="${act}" title="Show the notes, the cents and the pitch graph for this take">Reveal notes and graph</button>`;

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
