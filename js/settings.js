// Shared exercise settings, persisted in localStorage, bound to the sidebar UI.
import { INTERVALS, midiToName } from './music.js?v=20261001224055';
import { INSTRUMENTS, NOTE_MIN, NOTE_MAX, VOWELS, RANDOM, instrumentRange } from './instruments.js?v=20261001224055';

const KEY = 'voiceCoach.settings.v1';

const DEFAULTS = {
  instrument: 'piano',
  vowel1: 'A', // vowels sung by the recorded voices on note 1 / note 2
  vowel2: 'A',
  intervals: INTERVALS.map((i) => i.semis),
  direction: 'asc', // 'asc' | 'desc' | 'random'
  root: 'random', // 'random' | MIDI number
  ranges: {}, // per-instrument custom random-root range: { [instrument]: [lo, hi] }
  noteDur: 1.0,
  showInterval: true,
  octaveTolerant: true,
  singStart: 'countdown', // Interval Singing: 'countdown' | 'detect' (start when singing is heard)
  singleMode: 'align', // Single Note: 'align' (repeat attempts on one note) | 'follow' (hold to advance)
  singleRange: null, // Single Note [lo, hi]; null = instrument default
  singleAllowed: null, // Single Note: allowed MIDI notes within the range; null = all
  holdTime: 2, // Single Note, pitch following: seconds to hold the note
  autoNext: false,
  keepAlive: true, // play inaudible noise so Bluetooth audio doesn't power down between notes // Interval ID: go to the next interval after a correct answer
  tolerance: 25, // cents
  singDur: 1.5, // seconds per sung note
};

const PRESETS = {
  all: INTERVALS.map((i) => i.semis),
  none: [],
  basic: [2, 4, 5, 7, 12],
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    const s = { ...structuredClone(DEFAULTS), ...saved };
    if (!INSTRUMENTS[s.instrument] && s.instrument !== RANDOM) s.instrument = DEFAULTS.instrument;
    return s;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings = load();
const listeners = [];

export const onSettingsChange = (fn) => listeners.push(fn);

/**
 * Vowels for the two notes of an item (used only by the recorded voices).
 * 'random' resolves to the vowels drawn when the item was picked.
 */
export const vowelsFor = (item) =>
  [settings.vowel1, settings.vowel2].map((v, i) => (v === 'random' ? item?.randomVowels?.[i] ?? 'A' : v));

/** Instrument that plays an item: the setting, or the one drawn for the item when Random. */
export const instrumentFor = (item) =>
  (settings.instrument === RANDOM ? item?.instrument ?? 'piano' : settings.instrument);

/** Whether recorded voices (and so vowels) can be in use. */
export const voicesPossible = () =>
  settings.instrument === RANDOM || !!INSTRUMENTS[settings.instrument].vocalset;

/**
 * Text like ' · Female voice, vowels O → I': the instrument when Random is
 * selected, and the vowels when a recorded voice plays; '' if neither.
 */
export const soundText = (item) => {
  const key = instrumentFor(item);
  const parts = [];
  if (settings.instrument === RANDOM) parts.push(INSTRUMENTS[key].label);
  if (INSTRUMENTS[key].vocalset) {
    const [a, b] = vowelsFor(item);
    parts.push(`vowels ${a} → ${b}`);
  }
  return parts.length ? ` · ${parts.join(', ')}` : '';
};

/** Vowels that may be needed for playback (all five if either note is random). */
export const vowelsInUse = () =>
  [settings.vowel1, settings.vowel2].includes('random') ? VOWELS.map((v) => v.key) : [...new Set([settings.vowel1, settings.vowel2])];

export const getRange = () => settings.ranges[settings.instrument] || instrumentRange(settings.instrument);

export const settingChanged = (field) => changed(field);

function changed(field) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn(field));
}

const $ = (id) => document.getElementById(id);

export function initSettingsUI() {
  // Instrument
  const inst = $('instrument');
  for (const [key, def] of Object.entries(INSTRUMENTS)) inst.add(new Option(def.label, key));
  inst.add(new Option('🎲 Random', RANDOM));
  inst.value = settings.instrument;
  const syncVowelBox = () => { $('vowelBox').hidden = !voicesPossible(); };
  syncVowelBox();
  inst.onchange = () => {
    settings.instrument = inst.value;
    syncRange();
    syncVowelBox();
    changed('instrument');
  };

  // Vowels (recorded voices)
  for (const key of ['vowel1', 'vowel2']) {
    const seg = $(`${key}Seg`);
    for (const v of [...VOWELS, { key: 'random', hint: 'a random vowel for each new interval', label: '🎲' }]) {
      const label = document.createElement('label');
      label.title = v.hint;
      label.innerHTML = `<input type="radio" name="${key}" value="${v.key}"><span>${v.label ?? v.key}</span>`;
      const input = label.querySelector('input');
      input.checked = settings[key] === v.key;
      input.onchange = () => { settings[key] = v.key; changed('vowel'); };
      seg.append(label);
    }
  }

  // Intervals
  const list = $('intervalList');
  for (const iv of INTERVALS) {
    const label = document.createElement('label');
    label.className = 'chip';
    label.innerHTML = `<input type="checkbox" value="${iv.semis}"><span><b>${iv.short}</b> ${iv.name}</span>`;
    list.append(label);
  }
  const syncIntervals = () => {
    list.querySelectorAll('input').forEach((cb) => { cb.checked = settings.intervals.includes(+cb.value); });
  };
  syncIntervals();
  list.onchange = () => {
    settings.intervals = [...list.querySelectorAll('input:checked')].map((cb) => +cb.value);
    changed('intervals');
  };
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      settings.intervals = [...PRESETS[btn.dataset.preset]];
      syncIntervals();
      changed('intervals');
    };
  });

  // Radio groups
  for (const key of ['direction', 'singStart', 'singleMode']) {
    document.querySelectorAll(`input[name="${key}"]`).forEach((r) => {
      r.checked = r.value === settings[key];
      r.onchange = () => { settings[key] = r.value; changed(key); };
    });
  }

  // Root note + random range
  const root = $('root');
  const lo = $('rangeMin');
  const hi = $('rangeMax');
  root.add(new Option('🎲 Random', 'random'));
  for (let m = NOTE_MIN; m <= NOTE_MAX; m++) {
    root.add(new Option(midiToName(m), m));
    lo.add(new Option(midiToName(m), m));
    hi.add(new Option(midiToName(m), m));
  }
  root.value = String(settings.root);
  const syncRootMode = () => { $('rangeBox').hidden = settings.root !== 'random'; };
  syncRootMode();
  root.onchange = () => {
    settings.root = root.value === 'random' ? 'random' : +root.value;
    syncRootMode();
    changed('root');
  };

  function syncRange() {
    const [a, b] = getRange();
    lo.value = a;
    hi.value = b;
    $('rangeReset').hidden = !settings.ranges[settings.instrument];
  }
  syncRange();
  const onRange = () => {
    let a = +lo.value;
    let b = +hi.value;
    if (a > b) [a, b] = [b, a];
    settings.ranges[settings.instrument] = [a, b];
    syncRange();
    changed('range');
  };
  lo.onchange = onRange;
  hi.onchange = onRange;
  $('rangeReset').onclick = () => {
    delete settings.ranges[settings.instrument];
    syncRange();
    changed('range');
  };

  // Sliders and checkboxes
  bindSlider('noteDur', (v) => `${v.toFixed(1)} s`);
  bindSlider('tolerance', (v) => `±${v} cents`);
  bindSlider('singDur', (v) => `${v.toFixed(2)} s`);
  bindSlider('holdTime', (v) => `${v.toFixed(1)} s`);
  bindCheck('showInterval');
  bindCheck('octaveTolerant');
  bindCheck('autoNext');
  bindCheck('keepAlive');
}

function bindSlider(key, fmt) {
  const el = $(key);
  const out = $(`${key}Val`);
  el.value = settings[key];
  out.textContent = fmt(settings[key]);
  el.oninput = () => {
    settings[key] = +el.value;
    out.textContent = fmt(settings[key]);
    changed(key);
  };
}

function bindCheck(key) {
  const el = $(key);
  el.checked = settings[key];
  el.onchange = () => { settings[key] = el.checked; changed(key); };
}
