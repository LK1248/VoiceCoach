// Single Note theme: vertical note-range slider (two handles, highest note at
// the top) with a checkbox beside each note in the range. Moving a handle
// re-enables every note in the new range.
import { NOTE_MIN, NOTE_MAX, instrumentRange } from './instruments.js?v=20261002164634';
import { midiToName } from './music.js?v=20261002164634';
import { settings, settingChanged } from './settings.js?v=20261002164634';

const ROW = 16; // px per semitone

/** [lo, hi] MIDI range; follows the instrument's default until the user sets one. */
export const getSingleRange = () => settings.singleRange ?? instrumentRange(settings.instrument);

/** Notes the exercise may pick from: the range, minus unticked notes. */
export function getAllowedNotes() {
  const [lo, hi] = getSingleRange();
  const notes = [];
  for (let m = lo; m <= hi; m++) {
    if (!settings.singleAllowed || settings.singleAllowed.includes(m)) notes.push(m);
  }
  return notes;
}

const rowTop = (m) => (NOTE_MAX - m) * ROW;
const isBlack = (m) => midiToName(m).includes('#');

/** `onHear(midi)` plays a preview of a note (the ▶ button beside each note in range). */
export function initNoteRangeUI(root, { onHear } = {}) {
  root.innerHTML = `
    <div class="nr-track"><div class="nr-rail"></div><div class="nr-fill"></div>
      <div class="nr-thumb" data-end="hi" tabindex="0" role="slider" aria-label="Highest note"></div>
      <div class="nr-thumb" data-end="lo" tabindex="0" role="slider" aria-label="Lowest note"></div>
    </div>
    <div class="nr-list"></div>`;
  const track = root.querySelector('.nr-track');
  const fill = root.querySelector('.nr-fill');
  const thumbs = { hi: root.querySelector('[data-end="hi"]'), lo: root.querySelector('[data-end="lo"]') };
  const list = root.querySelector('.nr-list');
  root.style.height = `${(NOTE_MAX - NOTE_MIN + 1) * ROW}px`;

  for (let m = NOTE_MAX; m >= NOTE_MIN; m--) {
    const row = document.createElement('label');
    row.className = `nr-row${isBlack(m) ? ' black' : ''}`;
    row.style.top = `${rowTop(m)}px`;
    row.dataset.midi = m;
    row.innerHTML = `<input type="checkbox" value="${m}"><span>${midiToName(m)}</span>`
      + `<button type="button" class="nr-hear" title="Hear ${midiToName(m)}" aria-label="Hear ${midiToName(m)}">▶</button>`;
    list.append(row);
  }

  function render() {
    const [lo, hi] = getSingleRange();
    const allowed = new Set(getAllowedNotes());
    fill.style.top = `${rowTop(hi)}px`;
    fill.style.height = `${(hi - lo + 1) * ROW}px`;
    for (const [end, m] of [['hi', hi], ['lo', lo]]) {
      thumbs[end].style.top = `${rowTop(m) + ROW / 2}px`;
      thumbs[end].setAttribute('aria-valuetext', midiToName(m));
      thumbs[end].title = midiToName(m);
    }
    list.querySelectorAll('.nr-row').forEach((row) => {
      const m = +row.dataset.midi;
      const inRange = m >= lo && m <= hi;
      row.classList.toggle('out', !inRange);
      row.querySelector('input').checked = inRange && allowed.has(m);
    });
  }

  function setRange(lo, hi) {
    const [curLo, curHi] = getSingleRange();
    if (lo === curLo && hi === curHi) return;
    settings.singleRange = [lo, hi];
    settings.singleAllowed = null; // every note in the new range starts active
    render();
    settingChanged('singleRange');
  }

  const midiAt = (clientY) => {
    const r = track.getBoundingClientRect();
    const m = NOTE_MAX - Math.floor((clientY - r.top) / ROW);
    return Math.max(NOTE_MIN, Math.min(NOTE_MAX, m));
  };

  // Drag either handle; clicking the track moves the nearer handle there.
  let dragging = null;
  track.addEventListener('pointerdown', (e) => {
    const m = midiAt(e.clientY);
    const [lo, hi] = getSingleRange();
    dragging = e.target.dataset.end || (Math.abs(m - hi) <= Math.abs(m - lo) ? 'hi' : 'lo');
    track.setPointerCapture(e.pointerId);
    thumbs[dragging].focus();
    move(m);
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => { if (dragging) move(midiAt(e.clientY)); });
  track.addEventListener('pointerup', () => { dragging = null; });
  track.addEventListener('pointercancel', () => { dragging = null; });
  function move(m) {
    const [lo, hi] = getSingleRange();
    if (dragging === 'hi') setRange(lo, Math.max(m, lo));
    else setRange(Math.min(m, hi), hi);
  }

  // Keyboard: arrows move a focused handle by a semitone (Shift = octave).
  for (const [end, el] of Object.entries(thumbs)) {
    el.addEventListener('keydown', (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      const d = step * (e.shiftKey ? 12 : 1);
      const [lo, hi] = getSingleRange();
      if (end === 'hi') setRange(lo, Math.max(lo, Math.min(NOTE_MAX, hi + d)));
      else setRange(Math.max(NOTE_MIN, Math.min(hi, lo + d)), hi);
    });
  }

  // Preview buttons sit inside the row's <label>: don't let a click toggle the checkbox.
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.nr-hear');
    if (!btn) return;
    e.preventDefault();
    onHear?.(+btn.closest('.nr-row').dataset.midi);
  });

  list.addEventListener('change', () => {
    settings.singleAllowed = [...list.querySelectorAll('.nr-row:not(.out) input:checked')].map((c) => +c.value);
    settingChanged('singleAllowed');
  });

  render();
  return { render };
}
