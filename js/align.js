// Free-timing grading for multi-note takes (Interval Singing, Patterns): instead of fixed time
// slots, the take is split into the singer's own notes (stable-pitch stretches) and those are
// matched, in order, to the target notes. Late starts, uneven tempo, held or rushed notes and
// a missed note don't throw the rest of the grading off.
import { median } from './music.js?v=20261121021911';
import { scoreNote } from './grading.js?v=20261121021911';

const GAP = 0.1; // s: a break in voicing longer than this starts a new stretch
const JUMP = 0.7; // semitones away from the stretch's recent pitch starts a new stretch
const CAP = 3; // semitones: errors beyond this cost no more (one wild stretch can't dominate)
const SKIP = 2.5; // cost per second of leaving a stretch unassigned (glides, noise, wrong notes)
const MISS = 1.0; // cost of a target note that gets no stretch at all
const ONSET_SKIP = 0.2; // share of each note's span left out of grading (the slide into the note)
const FRAME = 1024 / 48000; // s per pitch frame (approximate; used for stretch durations)

/** Split voiced frames into stretches of steady pitch. */
function stretches(frames) {
  const out = [];
  let cur = null;
  for (const f of frames) {
    if (!f.voiced) continue;
    const recent = cur ? median(cur.frames.slice(-5).map((g) => g.midi)) : null;
    if (cur && f.t - cur.t1 <= GAP && Math.abs(f.midi - recent) <= JUMP) {
      cur.frames.push(f);
      cur.t1 = f.t;
    } else {
      cur = { frames: [f], t0: f.t, t1: f.t };
      out.push(cur);
    }
  }
  for (const s of out) {
    s.pitch = median(s.frames.map((f) => f.midi));
    s.dur = s.t1 - s.t0 + FRAME;
  }
  return out;
}

/**
 * Match stretches to targets in order (dynamic programming): each stretch belongs to one
 * target or is skipped; targets keep their order; a target may get several stretches (a note
 * broken by a breath) or none (missed). `shift` (semitones) is added to the targets first.
 * Returns, per target, its stretches (possibly empty).
 */
function assign(st, targets, shift) {
  const N = targets.length;
  const cost = (s, i) => s.dur * Math.min(CAP, Math.abs(s.pitch - (targets[i] + shift)));
  // state: index of the last target used (-1 = none yet) → { c, back }
  let dp = new Map([[-1, { c: 0, labels: [] }]]);
  for (const s of st) {
    const next = new Map();
    const put = (k, c, labels) => { if (!next.has(k) || next.get(k).c > c) next.set(k, { c, labels }); };
    for (const [last, { c, labels }] of dp) {
      put(last, c + s.dur * SKIP, [...labels, -1]); // skip this stretch
      for (let i = Math.max(0, last); i < N; i++) {
        const missed = i > last ? Math.max(0, i - last - 1) : 0; // targets jumped over
        put(i, c + cost(s, i) + missed * MISS, [...labels, i]);
      }
    }
    dp = next;
  }
  let best = null;
  for (const [last, v] of dp) {
    const c = v.c + (N - 1 - last) * MISS; // targets after the last one used are missed
    if (!best || c < best.c) best = { c, labels: v.labels };
  }
  return targets.map((_, i) => st.filter((_, j) => best.labels[j] === i));
}

/**
 * Grade a take against `targets` (MIDI) with free timing. Returns
 * { notes: scoreNote results, shift (cents, as scoreNote expects), spans: [[t0, t1] | null] }.
 * With octave tolerance one octave shift for the whole take (from its overall pitch), so the
 * intervals between the notes must still be right.
 */
export function gradeTake(frames, targets, tol, octaveTolerant) {
  const st = stretches(frames);
  const voiced = frames.filter((f) => f.voiced).map((f) => f.midi);
  const semis = octaveTolerant && voiced.length ? 12 * Math.round((median(voiced) - median(targets)) / 12) : 0;
  const groups = st.length ? assign(st, targets, semis) : targets.map(() => []);
  const shift = -100 * semis;
  const spans = [];
  const notes = targets.map((target, i) => {
    const g = groups[i];
    if (!g.length) { spans.push(null); return scoreNote(target, { total: 1, raw: [] }, tol, shift); }
    const t0 = g[0].t0;
    const t1 = g[g.length - 1].t1;
    spans.push([t0, t1]);
    const from = t0 + ONSET_SKIP * (t1 - t0);
    const raw = g.flatMap((s) => s.frames).filter((f) => f.t >= from).map((f) => (f.midi - target) * 100);
    const total = frames.filter((f) => f.t >= from && f.t <= t1).length;
    return scoreNote(target, { total: Math.max(1, total), raw }, tol, shift);
  });
  return { notes, shift, spans };
}

/** Where each note sits on the time axis: measured spans after grading, nominal slots before. */
export const noteWindows = (n, D, spans) => Array.from({ length: n }, (_, i) => (spans ? spans[i] : [i * D, (i + 1) * D]));

/** Index of the note being sung at time t (by measured spans if graded, else nominal slots). */
export function noteIndexAt(t, n, D, spans) {
  if (!spans) return Math.max(0, Math.min(n - 1, Math.floor(t / D)));
  let idx = -1;
  spans.forEach((s, i) => { if (s && s[0] <= t + 1e-9) idx = i; });
  return idx >= 0 ? idx : Math.max(0, spans.findIndex(Boolean));
}

/**
 * When to stop recording a free-timing take: after some singing, once the singer has been
 * silent for a while — or at a hard limit.
 */
export const END_SILENCE = 1.0; // s of silence after singing that ends the take
export const takeLimit = (nominal) => 2 * nominal + 3; // s
