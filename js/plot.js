// Pitch-over-time plotting on a canvas: semitone grid, target bands, traces.
import { midiToName } from './music.js?v=20261003002250';

/**
 * Prepare a HiDPI canvas and draw the semitone grid for pitches [lo, hi] over
 * times [t0, t1]. Returns helpers, or null if the canvas isn't laid out yet.
 */
export function createPlot(canvas, { lo, hi, t0, t1 }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = '11px system-ui, sans-serif';
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const padL = 42, padR = 10, padT = 8, padB = 20;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (w - padL - padR);
  const y = (m) => padT + ((hi - m) / (hi - lo)) * (h - padT - padB);
  const p = { g, w, h, x, y, col, lo, hi, t0, t1, top: padT, bottom: h - padB, left: padL, right: w - padR };

  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    g.strokeStyle = col('--grid');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, y(m));
    g.lineTo(w - padR, y(m));
    g.stroke();
    // Label every natural note when there's room; otherwise only C and G (or just C).
    const pxPerSemi = (h - padT - padB) / (hi - lo);
    const pc = ((m % 12) + 12) % 12;
    const labelled = pxPerSemi >= 11 ? !midiToName(m).includes('#') : pxPerSemi >= 5 ? pc === 0 || pc === 7 : pc === 0;
    if (labelled) {
      g.fillStyle = col('--muted');
      g.fillText(midiToName(m), padL - 6, y(m));
    }
  }
  g.textBaseline = 'alphabetic';
  return p;
}

/** Shaded tolerance band (± tolCents) around `target` between times ta and tb. */
export function drawBand(p, target, tolCents, ta, tb, label) {
  const { g, x, y, col } = p;
  const tolS = tolCents / 100;
  g.fillStyle = col('--target');
  g.fillRect(x(ta), y(target + tolS), x(tb) - x(ta), y(target - tolS) - y(target + tolS));
  g.strokeStyle = col('--accent');
  g.lineWidth = 1;
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(x(ta), y(target));
  g.lineTo(x(tb), y(target));
  g.stroke();
  g.setLineDash([]);
  if (label) {
    g.fillStyle = col('--accent');
    g.textAlign = 'left';
    g.fillText(label, x(ta) + 4, y(target + tolS) - 3);
  }
}

/**
 * Draw a pitch trace. `pitchOf(f)` maps a frame to the displayed MIDI pitch;
 * `colorOf(f)` (optional) colours each segment. Gaps > maxGap break the line.
 * Out-of-range pitches are pinned to the edge, or with `clip` cut off at it.
 */
export function drawTrace(p, frames, { color, width = 2.5, pitchOf = (f) => f.midi, colorOf, maxGap = 0.08, clip = false }) {
  const { g, x, y, lo, hi, t0, t1 } = p;
  if (clip) {
    g.save();
    g.beginPath();
    g.rect(p.left, p.top, p.right - p.left, p.bottom - p.top);
    g.clip();
  }
  g.lineWidth = width;
  g.lineCap = 'round';
  let prev = null;
  for (const f of frames) {
    if (!f.voiced || f.t < t0 || f.t > t1) { prev = null; continue; }
    const m = clip ? pitchOf(f) : Math.max(lo, Math.min(hi, pitchOf(f)));
    if (prev && f.t - prev.t < maxGap) {
      g.strokeStyle = colorOf ? colorOf(f, m) : color;
      g.beginPath();
      g.moveTo(x(prev.t), y(prev.m));
      g.lineTo(x(f.t), y(m));
      g.stroke();
    }
    prev = { t: f.t, m };
  }
  if (clip) g.restore();
}

export function drawPlayhead(p, t) {
  const { g, x, col, top, bottom } = p;
  g.strokeStyle = col('--text');
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x(t), top);
  g.lineTo(x(t), bottom);
  g.stroke();
}

export function drawMessage(canvas, text) {
  const p = createPlot(canvas, { lo: 0, hi: 0, t0: 0, t1: 1 });
  if (!p) return;
  p.g.clearRect(0, 0, p.w, p.h);
  p.g.fillStyle = p.col('--muted');
  p.g.textAlign = 'center';
  p.g.fillText(text, p.w / 2, p.h / 2);
}
