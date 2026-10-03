// Vocal Range theme: the singer sirens up and down in a chosen register.
// The app measures the full range, the "usable" range (extremes held ~0.5 s),
// and the range within the chosen register, marks register switches (pitch
// cracks and sudden H1–H2 changes, i.e. chest ↔ head/falsetto flips) with how
// abrupt they were, and relates the session's ranges to conventional voice types.
import { midiToName, median } from './music.js?v=20261003002250';
import { settings, settingChanged } from './settings.js?v=20261003002250';
import { activeNoiseProfile, bindRoomNoiseControls } from './roomNoise.js?v=20261003002250';
import { logSpectrum, findPeaks, cleanSpectrum, subtractNoise, drawSpectrum } from './spectrum.js?v=20261003002250';
import { createPlot, drawTrace, drawMessage, drawPlayhead } from './plot.js?v=20261003002250';

const $ = (id) => document.getElementById(id);

const HOLD_SEC = 0.5; // a "held" note: this long...
const HOLD_SEMIS = 0.5; // ...within ± this of its average
const GAP_SEC = 0.2; // pitch gaps up to this long are bridged (breaths, consonants, detector dropouts)
const EXTREME_NEAR = 1.5; // a hold within this many semitones of the top/bottom counts as holding it (allows a brief overshoot)
const AUTO_STOP_SILENCE = 1.5; // s of silence that ends the siren...
const MIN_VOICED = 2.5; // ...once at least this much has been sung
const MAX_SEC = 60;
// Voicing for sirens (gentler than the other themes: siren extremes are often quiet or breathy)
const MIN_CLARITY = 0.6;
const MIN_RMS = 0.003; // about -50 dBFS
const MIN_MIDI = 36; // C2 (65 Hz): below a bass's range, above mains hum (50/60 Hz)
// A sung note always contains its fundamental. When the detector locks onto a wrong pitch
// (e.g. 1.5x or 2x the real one) that "fundamental" is missing while its double is a real
// harmonic, so H1–H2 plunges (measured -31 to -58 dB on such frames; real singing stayed above -17 dB).
const MIN_H12 = -25;
const REL_LEVEL = 0.25; // frames quieter than this share of the take's typical singing level are background
// Range comes from continuous stretches: consecutive frames (gap <= STRETCH_GAP) with no pitch jump
// > STRETCH_JUMP semitones, lasting >= MIN_STRETCH. Scattered hum detections and brief slips drop out.
const STRETCH_GAP = 0.05;
const STRETCH_JUMP = 1.5;
const MIN_STRETCH = 0.2;
const BRIDGE_SEC = 0.15; // a shorter stretch is kept if sustained singing is this close on both sides (a transition)
// A siren is continuous and a real crack is a few semitones, so a stretch that starts or ends
// this far from a longer neighbour (within SLIP_GAP) is a tracking error: octave slips, or locking
// onto a low noise / sub-harmonic (seen at ~1/5 of the sung pitch).
const SLIP_SEMIS = 9;
const SLIP_GAP = 0.5;
const GLITCH_SEMIS = 6; // frames this far from their neighbours' median are tracking errors (octave jumps)
// Cracks: a sudden pitch jump in the direction of the glide that holds afterwards
const CRACK_MIN = 1.0; // semitones within ~2 frames...
const CRACK_MAX = 9; // ...but octave-sized jumps are tracker errors
const CRACK_SPAN = 0.08; // s
// Timbre switches: H1–H2 changes level and stays changed (vowel-resonance bumps swing back)
const STEP_WIN = 0.3; // s compared on each side...
const STEP_GUARD = 0.1; // ...leaving out this much around the candidate
const STEP_DB = 6; // minimum change in H1–H2 (with a pitch crack confirming it)...
// ...or without one. Measured on real sirens: loudness swells and vowel-resonance crossings move
// H1–H2 by up to ~17 dB; actual register flips by ~30 dB.
const STEP_ALONE_DB = 18;
const CRACK_ALONE = 2; // a pitch crack without a timbre change must be at least this many semitones
const PERSIST_SEC = 0.4; // ...that must still be at least
const PERSIST_DB = 4; // this far from the old level over the following PERSIST_SEC
const MERGE_SEC = 0.5; // candidates closer than this are one switch
const MAX_PER_DIRECTION = 2; // strongest switch per direction, plus a second only if crack + timbre agree
const EDGE_SEC = 0.2; // ignore candidates this close to the start/end of a sung stretch
const SPECTRUM_INTERVAL = 50; // ms between spectrum snapshots while singing
const ABRUPT_SEC = 0.15; // timbre change faster than this is "abrupt", else "gradual"

/** Siren voicing rule: the raw detector pitch if confident and loud enough. */
const sirenPitch = (f) => (f.rawMidi != null && f.rawMidi >= MIN_MIDI && f.clarity >= MIN_CLARITY && f.rms >= MIN_RMS
  && !(f.h12 != null && f.h12 < MIN_H12) ? f.rawMidi : null);

/**
 * Keep only frames that belong to sustained singing: above the take's background level,
 * in continuous stretches of at least MIN_STRETCH, and not an octave-type slip away from
 * the singing next to them.
 */
export function sungFrames(frames) {
  const voiced = frames.filter((f) => f.t != null && sirenPitch(f) != null);
  const confident = voiced.filter((f) => f.clarity >= 0.9).map((f) => f.rms);
  const floor = confident.length ? REL_LEVEL * median(confident) : 0;
  const loud = voiced.filter((f) => f.rms >= floor);
  const stretches = [];
  for (const f of loud) {
    const cur = stretches[stretches.length - 1];
    const prev = cur?.frames[cur.frames.length - 1];
    if (prev && f.t - prev.t <= STRETCH_GAP && Math.abs(sirenPitch(f) - sirenPitch(prev)) <= STRETCH_JUMP) cur.frames.push(f);
    else stretches.push({ frames: [f] });
  }
  for (const st of stretches) {
    st.t0 = st.frames[0].t;
    st.t1 = st.frames[st.frames.length - 1].t;
    st.dur = st.t1 - st.t0;
    st.pitch = median(st.frames.map(sirenPitch));
  }
  // Short stretches are dropped only when isolated (hum, stray blips). Between two sustained
  // stretches they are a transition, e.g. the unsteady moment of a register flip, and are kept.
  const long = stretches.filter((st) => st.dur >= MIN_STRETCH);
  const near = (st, side) => long.some((lg) => (side < 0 ? st.t0 - lg.t1 : lg.t0 - st.t1) >= 0
    && (side < 0 ? st.t0 - lg.t1 : lg.t0 - st.t1) <= BRIDGE_SEC);
  const kept = stretches.filter((st) => st.dur >= MIN_STRETCH || (near(st, -1) && near(st, 1)));
  // A slip is a big jump at the boundary with a longer neighbour: compare the pitches where the
  // two stretches meet, not their medians (a gliding stretch's median says little about its ends).
  const first = (st) => sirenPitch(st.frames[0]);
  const last = (st) => sirenPitch(st.frames[st.frames.length - 1]);
  const slip = (st) => kept.some((nb) => {
    if (nb === st || nb.dur <= st.dur) return false;
    const before = nb.t1 <= st.t0; // neighbour comes first
    const gap = before ? st.t0 - nb.t1 : nb.t0 - st.t1;
    const d = Math.abs(before ? first(st) - last(nb) : first(nb) - last(st));
    return gap <= SLIP_GAP && d >= SLIP_SEMIS;
  });
  return kept.filter((st) => !slip(st)).flatMap((st) => st.frames);
}

export const REGISTERS = [
  { key: 'chest', label: 'Chest', side: 'low', hint: 'Stay in chest voice as high as is comfortable. If it flips, keep going: the flip is marked, and only the part before it counts as chest.' },
  { key: 'head', label: 'Head', side: 'high', hint: 'Use head voice (full, not breathy). Near the bottom it may drop into chest: that switch is marked, and only the head-voice part counts.' },
  { key: 'falsetto', label: 'Falsetto', side: 'high', hint: 'Light, airy falsetto. Near the bottom it may drop into chest: that switch is marked, and only the falsetto part counts.' },
  { key: 'mix', label: 'Mix', side: null, hint: 'Keep a blended mix the whole way, smoothing over the break. A smooth result (no switch) is the goal.' },
  { key: 'whistle', label: 'Whistle', side: 'high', hint: 'Whistle register (very top). Pitch tracking stops around C6–D6, so the very highest notes may not register.' },
  { key: 'fry', label: 'Fry', side: null, hint: 'Vocal fry (creaky). Fry is irregular and below about 60 Hz pitch isn’t tracked, so results are rough.' },
];

export const SIREN_STYLES = {
  vowel: 'Sing on an open vowel ("ah" or "oo"): switches show most clearly.',
  nasal: 'Hum "ng" (as in "sing"), lips slightly apart.',
  trill: 'Lip trill ("brr"). Trills smooth over register switches, so switches may not show.',
};

// Approximate conventional ranges (MIDI) and typical passaggio (register transition) areas.
export const VOICE_TYPES = [
  { label: 'Bass', range: [40, 64], passaggio: 'C4–D4' }, // E2–E4
  { label: 'Baritone', range: [45, 67], passaggio: 'D4–E4' }, // A2–G4
  { label: 'Tenor', range: [48, 72], passaggio: 'F4–G4' }, // C3–C5
  { label: 'Countertenor', range: [52, 77], passaggio: 'sings in head/falsetto' }, // E3–F5
  { label: 'Contralto', range: [53, 77], passaggio: 'E4–F4, C5–D5' }, // F3–F5
  { label: 'Mezzo-soprano', range: [57, 81], passaggio: 'E4–F4, E5–F5' }, // A3–A5
  { label: 'Soprano', range: [60, 84], passaggio: 'E4–F4, F♯5–G5' }, // C4–C6
];
const KEY_LO = 36; // C2 — summary keyboard span
const KEY_HI = 84; // C6

const regInfo = (key) => REGISTERS.find((r) => r.key === key) ?? REGISTERS[0];
const fmtRange = (r) => (r ? `${midiToName(Math.round(r[0]))} – ${midiToName(Math.round(r[1]))}` : '—');
const span = (r) => (r ? Math.round(r[1]) - Math.round(r[0]) : 0);
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])]);

/** Median of each value with its ±k neighbours (nulls skipped). */
function medianFilter(values, k) {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - k), i + k + 1).filter((v) => v != null);
    return w.length ? median(w) : null;
  });
}

/**
 * Analyse one siren take. `frames`: recorder frames ({ t, rawMidi, clarity, rms, h12 }),
 * `holds`: held notes found live, `register`: chosen register key.
 */
export function analyseSiren(frames, holds, register) {
  const voiced = sungFrames(frames);
  if (voiced.length < 20) return null;

  // 1. Drop tracking glitches (octave jumps etc.): far from their neighbours' median.
  const raw = voiced.map(sirenPitch);
  const local = medianFilter(raw, 4);
  const v = voiced.filter((f, i) => Math.abs(raw[i] - local[i]) <= GLITCH_SEMIS);
  const t = v.map((f) => f.t);
  const pitch = medianFilter(v.map(sirenPitch), 2);
  const h12 = medianFilter(v.map((f) => f.h12), 2);
  const n = v.length;

  // 2. Turning point (top of the siren) and full range.
  let turn = 0;
  for (let i = 1; i < n; i++) if (pitch[i] > pitch[turn]) turn = i;
  const full = [Math.min(...pitch), Math.max(...pitch)];
  const turnT = t[turn];
  const dirAt = (ti) => (ti <= turnT ? 1 : -1); // +1 rising half, -1 falling half

  // Sung stretches; gaps up to GAP_SEC are bridged. Candidates near stretch edges are onsets/endings.
  const seg = [];
  let segStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || t[i] - t[i - 1] > GAP_SEC) {
      const s = [t[segStart], t[i - 1]];
      for (let j = segStart; j < i; j++) seg[j] = s;
      segStart = i;
    }
  }
  const interior = (i) => t[i] - seg[i][0] > EDGE_SEC && seg[i][1] - t[i] > EDGE_SEC;
  /** Median of a series over [a, b) within frame i's sung stretch (>= 4 frames, else null). */
  const medianIn = (series, i, a, b) => {
    const vals = [];
    for (let j = 0; j < n; j++) {
      if (t[j] >= a && t[j] < b && series[j] != null && seg[j] === seg[i]) vals.push(series[j]);
    }
    return vals.length >= 4 ? median(vals) : null;
  };

  // 3a. Cracks: a 1–9 semitone jump within ~2 frames, in the glide's direction, that holds afterwards.
  const cands = [];
  for (let i = 2; i < n - 6; i++) {
    if (!interior(i) || t[i] - t[i - 2] > CRACK_SPAN) continue;
    const d = pitch[i] - pitch[i - 2];
    if (Math.abs(d) < CRACK_MIN || Math.abs(d) > CRACK_MAX || Math.sign(d) !== dirAt(t[i])) continue;
    const after = median(pitch.slice(i + 2, i + 7));
    if (Math.abs(after - pitch[i - 2]) < 0.7 * Math.abs(d)) continue; // fell back: a glitch
    cands.push({ i, crack: d, strength: Math.abs(d) * 4 });
  }

  // 3b. Timbre switches: H1–H2 moves >= STEP_DB between the STEP_WIN before and after,
  // stays moved for PERSIST_SEC, and goes the way the glide implies (lighter going up).
  const steps = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!interior(i)) continue;
    // The whole comparison span must lie on one side of the turning point: around the
    // top the glide reverses, so the same pitches (and resonances) recur and fake persistence.
    const spanStart = t[i] - STEP_GUARD - STEP_WIN;
    const spanEnd = t[i] + STEP_GUARD + STEP_WIN + PERSIST_SEC;
    if (spanStart < turnT && spanEnd > turnT) continue;
    const before = medianIn(h12, i, t[i] - STEP_GUARD - STEP_WIN, t[i] - STEP_GUARD);
    const after = medianIn(h12, i, t[i] + STEP_GUARD, t[i] + STEP_GUARD + STEP_WIN);
    const later = medianIn(h12, i, t[i] + STEP_GUARD + STEP_WIN, t[i] + STEP_GUARD + STEP_WIN + PERSIST_SEC);
    if (before == null || after == null || later == null) continue;
    const step = after - before;
    if (Math.abs(step) < STEP_DB || Math.sign(step) !== dirAt(t[i])) continue;
    if (Math.sign(later - before) !== Math.sign(step) || Math.abs(later - before) < PERSIST_DB) continue;
    steps[i] = step;
  }
  for (let i = 0; i < n; i++) {
    const st = steps[i];
    if (st == null) continue;
    let best = true; // keep the largest step within the merge window
    for (let j = 0; j < n && best; j++) {
      if (j !== i && Math.abs(t[j] - t[i]) < MERGE_SEC / 2 && steps[j] != null && Math.abs(steps[j]) > Math.abs(st)) best = false;
    }
    if (best) cands.push({ i, step: st, strength: Math.abs(st) });
  }
  cands.sort((a, b) => t[a.i] - t[b.i]);

  // 4. Merge into switch events, keep the strongest per direction, and rate them.
  let events = [];
  for (const c of cands) {
    const last = events[events.length - 1];
    if (last && t[c.i] - last.t < MERGE_SEC) {
      if (c.crack != null) { last.crack = c.crack; last.t = t[c.i]; last.i = c.i; }
      if (c.step != null) last.step = c.step;
      last.strength += c.strength;
      continue;
    }
    events.push({ t: t[c.i], i: c.i, crack: c.crack ?? null, step: c.step ?? null, strength: c.strength });
  }
  for (const e of events) {
    e.dir = e.t <= turnT ? 'up' : 'down';
    // timbre change measured around the event, if not already
    if (e.step == null) {
      const b = medianIn(h12, e.i, e.t - STEP_GUARD - STEP_WIN, e.t - STEP_GUARD);
      const a = medianIn(h12, e.i, e.t + STEP_GUARD, e.t + STEP_GUARD + STEP_WIN);
      e.timbre = b != null && a != null ? a - b : null;
    } else {
      e.timbre = e.step;
    }
  }
  // Evidence rules: crack + agreeing timbre change (>= STEP_DB the right way), or a big
  // timbre change alone (>= STEP_ALONE_DB), or a big crack alone (>= CRACK_ALONE).
  const agrees = (e) => e.timbre != null && Math.sign(e.timbre) === (e.dir === 'up' ? 1 : -1);
  events = events.filter((e) => {
    if (e.crack != null && agrees(e) && Math.abs(e.timbre) >= STEP_DB) return true;
    if (e.crack == null) return Math.abs(e.step) >= STEP_ALONE_DB;
    return Math.abs(e.crack) >= CRACK_ALONE;
  });
  for (const e of events) {
    // where the register is cut: just before a crack's jump (smoothing spreads it over ~2 frames)
    e.cutT = e.crack != null ? t[Math.max(0, e.i - 2)] : e.t;
    e.clear = e.crack != null && agrees(e) && Math.abs(e.timbre) >= STEP_DB;
    if (e.clear) e.strength += 20;
  }
  // Per direction: confirmed switches (crack + timbre agree) outrank unconfirmed ones. Keep up to
  // MAX_PER_DIRECTION confirmed ones if any; otherwise only the single strongest unconfirmed one.
  events = ['up', 'down'].flatMap((d) => {
    const ranked = events.filter((e) => e.dir === d).sort((a, b) => b.strength - a.strength);
    const clear = ranked.filter((e) => e.clear);
    return clear.length ? clear.slice(0, MAX_PER_DIRECTION) : ranked.slice(0, 1);
  });
  events.sort((a, b) => a.t - b.t);
  for (const e of events) {
    e.midi = pitch[Math.max(0, e.i - 2)]; // pitch just before the switch
    const b = medianIn(h12, e.i, e.t - STEP_GUARD - STEP_WIN, e.t - STEP_GUARD);
    const a = medianIn(h12, e.i, e.t + STEP_GUARD, e.t + STEP_GUARD + STEP_WIN);
    if (e.step == null) e.step = b != null && a != null ? a - b : null;
    if (e.crack != null) {
      e.kind = 'crack';
    } else {
      // time for H1–H2 to move from 20% to 80% of the way across the step
      let t20 = null;
      let t80 = null;
      for (let j = 0; j < n; j++) {
        if (h12[j] == null || Math.abs(t[j] - e.t) > 0.5 || seg[j] !== seg[e.i]) continue;
        const frac = (h12[j] - b) / (a - b || 1);
        if (t20 == null && frac >= 0.2) t20 = t[j];
        if (t80 == null && frac >= 0.8) t80 = t[j];
      }
      e.width = t20 != null && t80 != null ? Math.max(0, t80 - t20) : null;
      e.kind = e.width != null && e.width < ABRUPT_SEC ? 'abrupt' : 'gradual';
    }
  }

  // 5. Range within the chosen register: cut at the switches.
  const side = regInfo(register).side;
  const ups = events.filter((e) => e.dir === 'up');
  const downs = events.filter((e) => e.dir === 'down');
  const firstUp = ups[0]?.cutT ?? null;
  const lastDown = downs[downs.length - 1]?.cutT ?? null;
  const inRegister = t.map((ti) => {
    if (side === 'low') return ti <= turnT ? firstUp == null || ti < firstUp : lastDown == null || ti > lastDown;
    if (side === 'high') return ti <= turnT ? firstUp == null || ti >= firstUp : lastDown == null || ti <= lastDown;
    return true;
  });
  const regPitch = pitch.filter((_, i) => inRegister[i]);
  const regRange = regPitch.length ? [Math.min(...regPitch), Math.max(...regPitch)] : null;

  // 6. Usable range: held notes at the extremes.
  const topHold = holds.filter((h) => h.midi >= full[1] - EXTREME_NEAR).sort((x, y) => y.midi - x.midi)[0] ?? null;
  const bottomHold = holds.filter((h) => h.midi <= full[0] + EXTREME_NEAR).sort((x, y) => x.midi - y.midi)[0] ?? null;

  return {
    register,
    full,
    regRange,
    usable: [bottomHold?.midi ?? null, topHold?.midi ?? null],
    topHeld: !!topHold,
    bottomHeld: !!bottomHold,
    events,
    frames: v.map((f, i) => ({ t: f.t, midi: pitch[i], voiced: true, inRegister: inRegister[i], h12: h12[i] })),
    holds,
  };
}

/** Rank voice types by how well a range fits: share of the type's range covered, minus overflow. */
export function matchVoiceTypes(range) {
  if (!range) return [];
  const [lo, hi] = [Math.round(range[0]), Math.round(range[1])];
  return VOICE_TYPES.map((vt) => {
    const [a, b] = vt.range;
    const covered = Math.max(0, Math.min(hi, b) - Math.max(lo, a));
    const outside = Math.max(0, a - lo) + Math.max(0, hi - b);
    return { ...vt, score: covered / (b - a) - 0.05 * outside };
  }).sort((x, y) => y.score - x.score);
}

export class RangeMode {
  constructor(engine, recorder, status) {
    this.engine = engine;
    this.recorder = recorder;
    this.status = status;
    this.running = false;
    this.frames = [];
    this.result = null;
    this.session = {}; // per register: { full, regRange, usable, switches, attempts }
    this.live = null;

    // Sidebar: register list (styles are radio buttons bound in settings.js)
    const sel = $('rangeRegister');
    REGISTERS.forEach((r, i) => {
      sel.add(new Option(r.label, r.key));
      if (i === 3) { // separator before the rarer ones
        const sep = new Option('──────────', '');
        sep.disabled = true;
        sel.add(sep);
      }
    });
    sel.value = settings.rangeRegister;
    sel.onchange = () => { settings.rangeRegister = sel.value; settingChanged('rangeRegister'); };

    $('rgStart').onclick = () => (this.running ? this.finish() : this.start());
    $('rgClear').onclick = () => { this.session = {}; this.renderSummary(); };
    $('rgSave').onclick = () => this.saveTake();
    $('rgPlay').onclick = () => this.playTake();
    $('rgRaw').onchange = () => this.drawSpectrumAt(this.cursorT);
    bindRoomNoiseControls({
      cal: $('rgNoiseCal'), check: $('rgNoiseOn'), status: $('rgNoiseStatus'),
      engine, recorder,
      beforeCalibrate: () => !this.running, // not in the middle of a siren
      onChange: () => this.drawSpectrumAt(this.cursorT),
    });
    new ResizeObserver(() => this.draw()).observe($('rgCanvas'));
    new ResizeObserver(() => this.drawSpectrumAt(this.cursorT)).observe($('rgSpectrum'));
    // Inspect any moment of a finished siren: hover/tap the pitch graph.
    const inspect = (e) => {
      if (this.running || !this.geom || !this.snapshots.length) return;
      const rect = $('rgCanvas').getBoundingClientRect();
      const { left, right, t0, t1 } = this.geom;
      const t = t0 + ((e.clientX - rect.left - left) / (right - left)) * (t1 - t0);
      this.setCursor(Math.max(t0, Math.min(t1, t)));
    };
    $('rgCanvas').addEventListener('pointermove', inspect);
    $('rgCanvas').addEventListener('pointerdown', inspect);
    this.snapshots = []; // { t, live, peaks, f0, minFreq, h12 } every SPECTRUM_INTERVAL while singing
    this.cursorT = null;
    new ResizeObserver(() => this.renderSummary()).observe($('rgSummary'));
    this.renderPrompt();
    this.renderSummary();
    this.setHeld(false, false);
  }

  onKey(e) {
    if (e.code === 'Space' || e.key.toLowerCase() === 'n') (this.running ? this.finish() : this.start());
  }

  activate() { this.renderPrompt(); this.draw(); this.renderSummary(); }

  deactivate() { if (this.running) this.finish(); }

  onSettings(field) {
    if (field === 'rangeRegister' || field === 'sirenStyle') this.renderPrompt();
  }

  renderPrompt() {
    const reg = regInfo(settings.rangeRegister);
    $('rgPrompt').innerHTML = `<b>${reg.label}</b> siren: slide slowly from your lowest note to your highest (about 2–4 s per octave),
      hold the top note ~½ s, then slide back down and hold the bottom note.
      <div class="hint">${reg.hint} ${SIREN_STYLES[settings.sirenStyle] ?? ''} Don't push past comfort: stop if it strains.</div>`;
  }

  setPhase(text, live = false) {
    const el = $('rgPhase');
    el.innerHTML = text || '&nbsp;';
    el.classList.toggle('live', live);
  }

  setHeld(top, bottom) {
    $('rgTopHeld').classList.toggle('ok', top);
    $('rgBottomHeld').classList.toggle('ok', bottom);
    $('rgTopHeld').textContent = `${top ? '✓' : '○'} Top held`;
    $('rgBottomHeld').textContent = `${bottom ? '✓' : '○'} Bottom held`;
  }

  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      await this.recorder.init();
    } catch (err) {
      this.setPhase(`⚠️ ${err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : err.message}`);
      this.starting = false;
      return;
    }
    this.starting = false;
    this.engine.stopAll();
    this.result = null;
    this.take = null;
    $('rgSave').hidden = true;
    $('rgPlay').hidden = true;
    this.snapshots = [];
    this.cursorT = null;
    $('rgResults').innerHTML = '';
    this.register = settings.rangeRegister;
    this.style = settings.sirenStyle;
    this.frames = this.recorder.start();
    this.running = true;
    this.live = { voicedSec: 0, lastVoicedT: 0, run: null, holds: [], recent: [], lo: Infinity, hi: -Infinity };
    this.setHeld(false, false);
    $('rgStart').innerHTML = '■ Finish <kbd>Space</kbd>';
    this.setPhase('🎤 Start low, slide slowly up…', true);
    this.draw();
  }

  onFrame(f) {
    $('rgLevel').style.width = `${Math.min(100, f.rms * 500)}%`;
    if (!this.running || f.t == null) return;
    this.frames.push(f);
    // spectrum snapshots ride on the mic frames (keeps working in a background tab)
    if (performance.now() - (this.lastSnap ?? 0) >= SPECTRUM_INTERVAL) {
      this.lastSnap = performance.now();
      this.captureSpectrum();
    }
    const L = this.live;
    const pm = sirenPitch(f);
    if (pm != null) {
      if (L.lastVoicedT) L.voicedSec += Math.min(0.05, f.t - L.lastVoicedT);
      L.lastVoicedT = f.t;
      // live extremes from a short running median (ignores single-frame glitches)
      L.recent.push(pm);
      if (L.recent.length > 5) L.recent.shift();
      const m = median(L.recent);
      L.lo = Math.min(L.lo, m);
      L.hi = Math.max(L.hi, m);
      // holds: a run of pitch within ±HOLD_SEMIS of its average
      const r = L.run;
      if (r && f.t - r.lastT <= GAP_SEC && Math.abs(pm - r.sum / r.n) <= HOLD_SEMIS) {
        r.sum += pm; r.n++; r.lastT = f.t;
        if (r.lastT - r.t0 >= HOLD_SEC) {
          const hold = { midi: r.sum / r.n, t0: r.t0, t1: r.lastT };
          if (r.hold) Object.assign(r.hold, hold); else { r.hold = hold; L.holds.push(hold); }
        }
      } else {
        L.run = { t0: f.t, lastT: f.t, sum: pm, n: 1, hold: null };
      }
      const turned = L.hi - m > 3;
      this.setPhase(turned ? '🎤 …and slide back down to your lowest note' : '🎤 Slide slowly up…', true);
    }
    const top = L.holds.some((h) => h.midi >= L.hi - EXTREME_NEAR);
    const bottom = L.holds.some((h) => h.midi <= L.lo + EXTREME_NEAR);
    this.setHeld(top, bottom);
    if ((L.voicedSec >= MIN_VOICED && f.t - L.lastVoicedT > AUTO_STOP_SILENCE) || f.t > MAX_SEC) {
      this.finish();
      return;
    }
    this.requestDraw();
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    this.take = this.recorder.stop();
    $('rgSave').hidden = false;
    $('rgPlay').hidden = false;
    $('rgStart').innerHTML = '▶ Start siren <kbd>N</kbd>';
    this.result = analyseSiren(this.frames, this.live.holds, this.register);
    if (!this.result) {
      this.setPhase('No clear singing detected. Sing a little louder or closer to the mic, and try again.');
      this.draw();
      return;
    }
    this.setHeld(this.result.topHeld, this.result.bottomHeld);
    this.setPhase('Done. Results below; sing another siren to refine your range.');
    this.addToSession(this.result);
    this.renderResult();
    this.renderSummary();
    this.draw();
  }

  /** Download the last siren as a 16-bit mono WAV (for sharing / offline analysis). */
  saveTake() {
    if (!this.take) return;
    const data = this.take.getChannelData(0);
    const sr = this.take.sampleRate;
    const buf = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    a.download = `siren-${this.register}-${this.style}-${stamp}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  addToSession(r) {
    const s = (this.session[r.register] ??= { full: null, regRange: null, usable: [null, null], switches: [], attempts: 0 });
    s.attempts++;
    s.full = union(s.full, r.full);
    s.regRange = union(s.regRange, r.regRange);
    if (r.usable[0] != null) s.usable[0] = s.usable[0] == null ? r.usable[0] : Math.min(s.usable[0], r.usable[0]);
    if (r.usable[1] != null) s.usable[1] = s.usable[1] == null ? r.usable[1] : Math.max(s.usable[1], r.usable[1]);
    s.switches.push(...r.events.map((e) => ({ midi: e.midi, dir: e.dir, clear: e.clear })));
  }

  renderResult() {
    const r = this.result;
    const reg = regInfo(r.register);
    const usable = r.usable[0] != null && r.usable[1] != null
      ? `${fmtRange(r.usable)} (${span(r.usable)} semitones)`
      : `${r.usable[0] != null ? midiToName(Math.round(r.usable[0])) : '?'} – ${r.usable[1] != null ? midiToName(Math.round(r.usable[1])) : '?'}
         <span class="hint">hold the ${[r.usable[1] == null && 'top', r.usable[0] == null && 'bottom'].filter(Boolean).join(' and ')} note${r.usable[0] == null && r.usable[1] == null ? 's' : ''} ~½ s to measure</span>`;
    const sw = r.events.map((e) => {
      const how = e.kind === 'crack'
        ? `crack: pitch jumped ${Math.abs(e.crack).toFixed(1)} st`
        : `${e.kind}${e.width != null ? ` (${e.width.toFixed(2)} s)` : ''}`;
      const timbre = e.step != null ? `, H1–H2 ${e.step > 0 ? '+' : '−'}${Math.abs(e.step).toFixed(0)} dB` : '';
      return `<li class="${e.clear ? 'clear' : 'possible'}">${e.dir === 'up' ? '↑' : '↓'} <b>${midiToName(Math.round(e.midi))}</b>: ${how}${timbre}${e.clear ? '' : ' <span class="hint">(possible)</span>'}</li>`;
    }).join('');
    const up = r.events.find((e) => e.dir === 'up');
    const down = [...r.events].reverse().find((e) => e.dir === 'down');
    let gap = '';
    if (up && down) {
      const d = up.midi - down.midi;
      gap = `<div class="line">You switched back ${Math.abs(d) < 0.5 ? 'at about the same pitch'
        : `${Math.abs(d).toFixed(1)} semitones ${d > 0 ? 'lower' : 'higher'}`} on the way down than on the way up${d > 0.5 ? ' (the usual pattern)' : ''}.</div>`;
    }
    $('rgResults').innerHTML = `
      <div class="range-facts">
        <div><span class="field-label">Full range</span><b>${fmtRange(r.full)}</b> <span class="hint">${span(r.full)} semitones</span></div>
        <div><span class="field-label">Usable (held)</span><b>${usable}</b></div>
        ${reg.side ? `<div><span class="field-label">${reg.label} range</span><b>${fmtRange(r.regRange)}</b> <span class="hint">${r.events.length ? 'up to the switch' : 'no switch, whole siren'}</span></div>` : ''}
      </div>
      <div class="line"><b>Register switches</b></div>
      ${r.events.length ? `<ul class="switches">${sw}</ul>${gap}` : '<div class="line">No switch detected: a smooth transition, or you stayed in one register.</div>'}`;
  }

  requestDraw() {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }

  /** Pitch-over-time graph of the siren: holds shaded, switches marked, other-register parts pale. */
  draw() {
    const c = $('rgCanvas');
    const r = this.result;
    const frames = r
      ? r.frames
      : this.frames.filter((f) => f.t != null && sirenPitch(f) != null).map((f) => ({ t: f.t, midi: sirenPitch(f), voiced: true }));
    if (!frames.length) { drawMessage(c, this.running ? 'Listening…' : 'Press Start siren'); return; }
    const ms = frames.map((f) => f.midi);
    const lo = Math.floor(Math.min(...ms)) - 2;
    const hi = Math.ceil(Math.max(...ms)) + 2;
    const tEnd = frames[frames.length - 1].t;
    const p = createPlot(c, { lo, hi, t0: 0, t1: Math.max(6, tEnd + (this.running ? 2 : 0.3)) });
    if (!p) return;
    this.geom = { left: p.left, right: p.right, t0: p.t0, t1: p.t1 };
    const { g, x, y, col } = p;
    // held notes
    const holds = r ? r.holds : this.live?.holds ?? [];
    g.fillStyle = col('--good-soft');
    for (const h of holds) g.fillRect(x(h.t0), y(h.midi + 0.6), x(h.t1) - x(h.t0), y(h.midi - 0.6) - y(h.midi + 0.6));
    // trace: parts outside the chosen register drawn pale
    drawTrace(p, frames, { width: 3, maxGap: GAP_SEC, colorOf: (f) => (f.inRegister === false ? col('--pale') : col('--text')) });
    if (!r) return;
    // full-range extremes
    g.setLineDash([4, 4]);
    g.strokeStyle = col('--accent');
    g.lineWidth = 1;
    for (const m of r.full) { g.beginPath(); g.moveTo(p.left, y(m)); g.lineTo(p.right, y(m)); g.stroke(); }
    g.setLineDash([]);
    // switch markers
    g.font = 'bold 11px system-ui, sans-serif';
    g.textAlign = 'center';
    for (const e of r.events) {
      const colr = e.clear ? col('--bad') : col('--warn');
      g.strokeStyle = colr;
      g.fillStyle = colr;
      g.lineWidth = 2;
      g.beginPath(); g.arc(x(e.t), y(e.midi), 7, 0, 2 * Math.PI); g.stroke();
      const label = `${e.dir === 'up' ? '↑' : '↓'} ${midiToName(Math.round(e.midi))} ${e.kind}`;
      const ly = e.dir === 'up' ? y(e.midi) - 14 : y(e.midi) + 22;
      g.fillText(label, Math.min(p.right - 40, Math.max(p.left + 40, x(e.t))), Math.max(p.top + 10, Math.min(p.bottom - 4, ly)));
    }
    if (this.cursorT != null) drawPlayhead(p, this.cursorT);
  }

  // ---- Spectrum ---------------------------------------------------------------

  /** Snapshot the mic spectrum (called from onFrame every SPECTRUM_INTERVAL while singing) and draw it. */
  captureSpectrum() {
    const an = this.recorder.analyser;
    const ctx = this.engine.ctx;
    if (!an || !ctx) return;
    if (!this.specBuf || this.specBuf.length !== an.frequencyBinCount) this.specBuf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this.specBuf);
    const binHz = ctx.sampleRate / an.fftSize;
    const s = logSpectrum(this.specBuf, binHz);
    // the analyser window is centred about half its length before "now"
    const t = this.recorder.elapsed - an.fftSize / 2 / ctx.sampleRate;
    // fundamental: the sung pitch at that moment (anchors the harmonic guides and the "below f0" cut)
    const near = this.frames.filter((f) => f.t != null && Math.abs(f.t - t) < 0.1 && sirenPitch(f) != null);
    const f0 = near.length ? median(near.map(sirenPitch)) : null;
    const h12s = near.map((f) => f.h12).filter((v) => v != null);
    const minFreq = f0 != null ? 440 * 2 ** ((f0 - 1 - 69) / 12) : undefined;
    const profile = activeNoiseProfile();
    const snap = {
      t,
      s, // unsubtracted, unfiltered
      peaks: f0 != null ? findPeaks(s, this.specBuf, binHz, { minFreq }) : [],
      peaksSub: f0 != null && profile ? findPeaks(subtractNoise(s, profile), this.specBuf, binHz, { minFreq }) : null,
      f0,
      minFreq,
      h12: h12s.length ? median(h12s) : null,
    };
    this.snapshots.push(snap);
    this.drawSnapshot(snap);
  }

  drawSnapshot(snap) {
    const label = snap.f0 != null
      ? `${snap.t.toFixed(2)} s · ${midiToName(Math.round(snap.f0))} · H1–H2 ${snap.h12 != null ? `${snap.h12 >= 0 ? '+' : '−'}${Math.abs(snap.h12).toFixed(0)} dB` : '—'}`
      : `${snap.t.toFixed(2)} s · no pitch`;
    const unfiltered = $('rgRaw').checked;
    const profile = activeNoiseProfile();
    const s = profile ? subtractNoise(snap.s, profile) : snap.s;
    drawSpectrum($('rgSpectrum'), {
      live: unfiltered ? s : cleanSpectrum(s, snap.minFreq),
      noise: profile,
      target: snap.f0,
      sourceLabel: unfiltered ? `${label} · unfiltered` : label,
      peaks: (profile && snap.peaksSub) || snap.peaks,
      minFreq: unfiltered ? undefined : snap.minFreq,
    });
  }

  /** Show the spectrum nearest time t (finished siren). */
  drawSpectrumAt(t) {
    if (!this.snapshots?.length) {
      drawSpectrum($('rgSpectrum'), { live: null, sourceLabel: 'Live spectrum appears while you sing' });
      return;
    }
    if (t == null) { this.drawSnapshot(this.snapshots[this.snapshots.length - 1]); return; }
    let best = this.snapshots[0];
    for (const s of this.snapshots) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    this.drawSnapshot(best);
  }

  setCursor(t) {
    this.cursorT = t;
    this.draw();
    this.drawSpectrumAt(t);
  }

  /** Play the take back with the cursor and spectrum following along. */
  playTake() {
    if (!this.take || this.running) return;
    this.engine.stopAll();
    const ctx = this.engine.ensure();
    const start = ctx.currentTime + 0.1;
    this.engine.playBuffer(this.take, start);
    const token = (this.playToken = (this.playToken ?? 0) + 1);
    const tick = () => {
      if (token !== this.playToken) return;
      const t = ctx.currentTime - start - this.engine.outputLatency;
      if (t > this.take.duration) return;
      if (t >= 0) this.setCursor(t);
      requestAnimationFrame(tick);
    };
    tick();
  }

  /** Session summary: per-register bars on a keyboard, conventional voice types below. */
  renderSummary() {
    const c = $('rgSummary');
    const regs = REGISTERS.filter((rg) => this.session[rg.key]);
    const rowH = 24;
    const typeH = 18;
    const keysH = 26;
    const h = keysH + 14 + Math.max(1, regs.length) * rowH + 16 + VOICE_TYPES.length * typeH + 8;
    c.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    if (!w) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const padL = 150;
    const padR = 10;
    const x = (m) => padL + ((m - KEY_LO) / (KEY_HI - KEY_LO + 1)) * (w - padL - padR);
    const cell = x(KEY_LO + 1) - x(KEY_LO);
    g.font = '11px system-ui, sans-serif';

    // keyboard strip
    for (let m = KEY_LO; m <= KEY_HI; m++) {
      g.fillStyle = midiToName(m).includes('#') ? col('--text') : col('--panel');
      g.globalAlpha = midiToName(m).includes('#') ? 0.55 : 1;
      g.fillRect(x(m), 0, cell, keysH - 8);
      g.globalAlpha = 1;
      g.strokeStyle = col('--border');
      g.strokeRect(x(m) + 0.5, 0.5, cell, keysH - 8);
      if (m % 12 === 0) { g.fillStyle = col('--muted'); g.textAlign = 'left'; g.fillText(midiToName(m), x(m) + 1, keysH + 4); }
    }

    // register rows
    let yy = keysH + 14;
    g.textBaseline = 'middle';
    if (!regs.length) {
      g.fillStyle = col('--muted');
      g.textAlign = 'left';
      g.fillText('Sing a siren to see your range here.', padL, yy + rowH / 2);
      yy += rowH;
    }
    for (const rg of regs) {
      const s = this.session[rg.key];
      const mid = yy + rowH / 2;
      g.fillStyle = col('--text');
      g.textAlign = 'left';
      g.fillText(`${rg.label} (${s.attempts}×)`, 4, mid);
      // full range (light), register range (solid)
      g.fillStyle = col('--accent-soft');
      g.fillRect(x(s.full[0]), mid - 7, x(s.full[1] + 1) - x(s.full[0]), 14);
      if (s.regRange) {
        g.fillStyle = col('--accent');
        g.fillRect(x(s.regRange[0]), mid - 4, x(s.regRange[1] + 1) - x(s.regRange[0]), 8);
      }
      // held extremes (green dots)
      g.fillStyle = col('--good');
      for (const m of s.usable) if (m != null) { g.beginPath(); g.arc(x(m + 0.5), mid, 4, 0, 2 * Math.PI); g.fill(); }
      // switches ▲ (up) / ▼ (down)
      for (const sw of s.switches) {
        const sx = x(sw.midi + 0.5);
        g.fillStyle = sw.clear ? col('--bad') : col('--warn');
        g.beginPath();
        if (sw.dir === 'up') { g.moveTo(sx, mid - 12); g.lineTo(sx - 4, mid - 6); g.lineTo(sx + 4, mid - 6); }
        else { g.moveTo(sx, mid + 12); g.lineTo(sx - 4, mid + 6); g.lineTo(sx + 4, mid + 6); }
        g.fill();
      }
      yy += rowH;
    }

    // voice types
    yy += 16;
    const yours = this.voiceRange();
    const ranked = matchVoiceTypes(yours);
    const best = ranked[0];
    const near = new Set(ranked.filter((v) => best && v.score >= best.score - 0.1).map((v) => v.label));
    for (const vt of VOICE_TYPES) {
      const mid = yy + typeH / 2;
      const isBest = best && vt.label === best.label;
      g.fillStyle = isBest ? col('--accent') : near.has(vt.label) ? col('--text') : col('--muted');
      g.textAlign = 'left';
      g.font = `${isBest ? 'bold ' : ''}11px system-ui, sans-serif`;
      g.fillText(`${vt.label}`, 4, mid);
      g.fillStyle = isBest ? col('--accent') : near.has(vt.label) ? col('--accent-soft') : col('--grid');
      g.fillRect(x(vt.range[0]), mid - 3, x(vt.range[1] + 1) - x(vt.range[0]), 6);
      yy += typeH;
    }
    g.font = '11px system-ui, sans-serif';
    if (yours) {
      g.strokeStyle = col('--accent');
      g.setLineDash([3, 3]);
      for (const m of [yours[0], yours[1] + 1]) { g.beginPath(); g.moveTo(x(m), keysH + 8); g.lineTo(x(m), h - 4); g.stroke(); }
      g.setLineDash([]);
    }

    // text verdict
    const box = $('rgVoiceType');
    if (!yours) { box.innerHTML = ''; return; }
    const also = ranked.slice(1).filter((v) => v.score >= best.score - 0.1).map((v) => v.label);
    box.innerHTML = `Range used for comparison: <b>${fmtRange(yours)}</b>.
      Closest conventional voice type: <b>${best.label}</b>${also.length ? `; also consistent with ${also.join(', ')}` : ''}.
      <div class="hint">A rough guide only: voice type also depends on where your voice is comfortable, where it switches
      (typical transitions: ${VOICE_TYPES.map((v) => `${v.label} ${v.passaggio}`).join(' · ')}), and its timbre. Training extends range.</div>`;
  }

  /** Range used for voice typing: chest/head/mix register ranges if sung, else every full range. */
  voiceRange() {
    let r = null;
    for (const key of ['chest', 'head', 'mix']) r = union(r, this.session[key]?.regRange ?? null);
    if (!r) for (const s of Object.values(this.session)) r = union(r, s.full);
    return r && [Math.round(r[0]), Math.round(r[1])];
  }
}
