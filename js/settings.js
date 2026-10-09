// Shared exercise settings, persisted in localStorage, bound to the sidebar UI.
import { INTERVALS, DEGREES, midiToName } from './music.js?v=20261009205629';
import { INSTRUMENTS, NOTE_MIN, NOTE_MAX, VOWELS, RANDOM, BACKING, instrumentRange } from './instruments.js?v=20261009205629';
import { SCALES, ARPEGGIOS, WARMUPS, FAMILIES } from './patterns.js?v=20261009205629';

const KEY = 'voiceCoach.settings.v1';

const DEFAULTS = {
  instrument: 'piano',
  vowel1: 'A', // vowels sung by the recorded voices on note 1 / note 2
  vowel2: 'A',
  intervals: INTERVALS.map((i) => i.semis),
  direction: 'asc', // 'asc' | 'desc' | 'random' | 'harm' (Interval ID only: both notes together)
  root: 'random', // 'random' | MIDI number
  ranges: {}, // per-instrument custom random-root range: { [instrument]: [lo, hi] }
  noteDur: 1.0,
  randomDur: false, // Interval ID: each note gets its own random length, MIN_NOTE_DUR…noteDur
  showInterval: true,
  octaveTolerant: true,
  singStart: 'countdown', // Interval Singing: 'countdown' | 'detect' (start when singing is heard)
  singleMode: 'align', // Single Note: 'align' (repeat attempts on one note) | 'follow' (hold to advance)
  singleRange: null, // Single Note [lo, hi]; null = instrument default
  singleAllowed: null, // Single Note: allowed MIDI notes within the range; null = all
  holdTime: 2, // Single Note, pitch following: seconds to hold the note
  hidePitch: false, // Single Note: hide the pitch graph while singing (shown afterwards)
  autoNext: false,
  hideSpectrum: true, // Interval ID: hide the spectrum until answered (peak gaps reveal the interval)
  harmSolo: false, // Interval ID, notes played together: also show each note's spectrum alone
  rangeRegister: 'chest', // Vocal Range: register of the siren
  sirenStyle: 'vowel', // Vocal Range: 'vowel' | 'nasal' | 'trill'
  keepAlive: true, // play inaudible noise so Bluetooth audio doesn't power down between notes // Interval ID: go to the next interval after a correct answer
  // Patterns
  patFamily: 'scale', // 'scale' | 'arpeggio' | 'warmup' | 'random'
  patScale: 'major', // scales and random melodies
  patArp: 'maj',
  patOctave: false, // arpeggios: add the octave on top
  patWarm: 'five',
  patQuality: 'major', // warm-ups: 'major' | 'minor'
  patShape: 'updown', // scales and arpeggios: 'up' | 'down' | 'updown' | 'downup'
  patCount: 5, // random melody: number of notes
  patLeap: 5, // random melody: largest leap (semitones)
  patStart: 'random', // tonic: 'random' | 'fixed' | 'step' (a semitone further each round)
  patRoot: 48, // tonic for 'fixed'; where 'step' begins
  patRange: [48, 72], // the whole pattern stays inside
  patFlow: 'listen', // 'listen' (hear it, then sing) | 'along' (sing with it; headphones)
  patDur: 0.8, // seconds per note
  patShowNotes: true, // show note names and target bands while singing
  patHideTrace: false, // hide the sung pitch until the take is finished
  // With Chords
  chInst: 'piano', // backing instrument
  chQuality: 'major', // 'major' | 'minor' | 'random'
  chKey: 'random', // 'random' | pitch class 0–11
  chStyle: 'block', // 'block' (re-struck chord) | 'arp'
  chBeat: 0.6, // seconds per beat (arpeggio note; a block chord is struck every 4 beats)
  chVol: 0.5, // backing volume
  chTarget: 'play', // how the note is given: 'play' (played first) | 'name' | 'degree'
  chDegrees: [1, 2, 3, 4, 5, 6, 7], // scale degrees that may be asked for
  chRange: [48, 72], // notes that may be asked for
  chMode: 'align', // 'align' | 'follow'
  chHold: 2, // pitch following: seconds to hold the note
  chListen: 'phones', // 'phones' | 'speakers' (chord measured through the mic and subtracted)
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
export const MIN_NOTE_DUR = 0.4; // s: shortest note length (the slider's minimum)

/**
 * Interval ID: the lengths (s) of an item's two notes. With "Random length" each note has its
 * own, drawn when the item was picked (so replays match), between the minimum and the slider
 * value; notes played together share the first one.
 */
export const noteDursFor = (item) => {
  if (!settings.randomDur) return [settings.noteDur, settings.noteDur];
  const durs = (item?.randomDurs ?? [1, 1]).map((u) => MIN_NOTE_DUR + u * (settings.noteDur - MIN_NOTE_DUR));
  return item?.dir === 'harm' ? [durs[0], durs[0]] : durs;
};
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
  for (const key of ['direction', 'singStart', 'singleMode', 'sirenStyle', 'patQuality', 'patShape', 'patStart', 'patFlow',
    'chQuality', 'chStyle', 'chTarget', 'chMode', 'chListen']) {
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

  // Patterns
  const labels = (obj) => Object.entries(obj).map(([k, v]) => [k, v.label ?? v]);
  const noteOptions = [];
  for (let m = NOTE_MIN; m <= NOTE_MAX; m++) noteOptions.push([m, midiToName(m)]);
  bindSelect('patFamily', labels(FAMILIES));
  bindSelect('patScale', labels(SCALES));
  bindSelect('patArp', labels(ARPEGGIOS));
  bindSelect('patWarm', labels(WARMUPS));
  bindSelect('patRoot', noteOptions, Number);
  bindRangePair('patRange', 'patLo', 'patHi', noteOptions);
  bindSlider('patDur', (v) => `${v.toFixed(1)} s`);
  bindSlider('patCount', (v) => `${v} notes`);
  bindSlider('patLeap', (v) => `${v} semitones`);
  bindCheck('patOctave');
  bindCheck('patShowNotes');
  bindCheck('patHideTrace');

  // With Chords
  bindSelect('chInst', Object.entries(BACKING));
  bindSelect('chKey', [['random', '🎲 Random'], ...['C', 'C# / Db', 'D', 'Eb', 'E', 'F', 'F# / Gb', 'G', 'Ab', 'A', 'Bb', 'B'].map((n, i) => [i, n])],
    (v) => (v === 'random' ? v : Number(v)));
  bindRangePair('chRange', 'chLo', 'chHi', noteOptions);
  bindSlider('chBeat', (v) => `${v.toFixed(1)} s`);
  bindSlider('chVol', (v) => `${Math.round(v * 100)}%`);
  bindSlider('chHold', (v) => `${v.toFixed(1)} s`);
  const degList = $('chDegreeList');
  DEGREES.forEach((name, i) => {
    const label = document.createElement('label');
    label.className = 'chip';
    label.innerHTML = `<input type="checkbox" value="${i + 1}"><span><b>${i + 1}</b> ${name}</span>`;
    label.querySelector('input').checked = settings.chDegrees.includes(i + 1);
    degList.append(label);
  });
  degList.onchange = () => {
    settings.chDegrees = [...degList.querySelectorAll('input:checked')].map((cb) => +cb.value);
    changed('chDegrees');
  };

  // Sliders and checkboxes
  bindSlider('noteDur', (v) => `${v.toFixed(1)} s`);
  bindSlider('tolerance', (v) => `±${v} cents`);
  bindSlider('singDur', (v) => `${v.toFixed(2)} s`);
  bindSlider('holdTime', (v) => `${v.toFixed(1)} s`);
  bindCheck('showInterval');
  bindCheck('octaveTolerant');
  bindCheck('autoNext');
  bindCheck('randomDur');
  bindCheck('hidePitch');
  bindCheck('hideSpectrum');
  bindCheck('harmSolo');
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

function bindSelect(key, options, parse = (v) => v) {
  const el = $(key);
  for (const [value, label] of options) el.add(new Option(label, value));
  el.value = String(settings[key]);
  if (el.selectedIndex < 0) { el.selectedIndex = 0; settings[key] = parse(el.value); } // saved value no longer offered
  el.onchange = () => { settings[key] = parse(el.value); changed(key); };
}

/** Two note pickers bound to a [low, high] setting (kept in order). */
function bindRangePair(key, loId, hiId, noteOptions) {
  const lo = $(loId);
  const hi = $(hiId);
  for (const [value, label] of noteOptions) { lo.add(new Option(label, value)); hi.add(new Option(label, value)); }
  const sync = () => { [lo.value, hi.value] = settings[key]; };
  sync();
  lo.onchange = hi.onchange = () => {
    const a = +lo.value;
    const b = +hi.value;
    settings[key] = a <= b ? [a, b] : [b, a];
    sync();
    changed(key);
  };
}

function bindCheck(key) {
  const el = $(key);
  el.checked = settings[key];
  el.onchange = () => { settings[key] = el.checked; changed(key); };
}
