import { pickInstrument } from './instruments.js?v=20261002235214';

// Music theory helpers: note names, frequencies, intervals.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// `key`: keyboard shortcut — major/perfect intervals on the digit row, minor
// intervals and the tritone on the letters between them (like black keys).
export const INTERVALS = [
  { semis: 1, short: 'm2', name: 'Minor 2nd', key: 'w' },
  { semis: 2, short: 'M2', name: 'Major 2nd', key: '2' },
  { semis: 3, short: 'm3', name: 'Minor 3rd', key: 'e' },
  { semis: 4, short: 'M3', name: 'Major 3rd', key: '3' },
  { semis: 5, short: 'P4', name: 'Perfect 4th', key: '4' },
  { semis: 6, short: 'TT', name: 'Tritone', key: 't' },
  { semis: 7, short: 'P5', name: 'Perfect 5th', key: '5' },
  { semis: 8, short: 'm6', name: 'Minor 6th', key: 'y' },
  { semis: 9, short: 'M6', name: 'Major 6th', key: '6' },
  { semis: 10, short: 'm7', name: 'Minor 7th', key: 'u' },
  { semis: 11, short: 'M7', name: 'Major 7th', key: '7' },
  { semis: 12, short: 'P8', name: 'Octave', key: '8' },
];

export const intervalBySemis = (s) => INTERVALS.find((i) => i.semis === s);

export const midiToName = (m, flats = false) =>
  (flats ? FLAT_NAMES : SHARP_NAMES)[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'];
const randChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Pick a new exercise item from the current settings.
 * Returns { root, second, interval, dir } where root/second are MIDI numbers.
 */
export function pickItem(s, range, previous) {
  const active = INTERVALS.filter((i) => s.intervals.includes(i.semis));
  if (!active.length) throw new Error('Select at least one interval.');

  for (let attempt = 0; attempt < 8; attempt++) {
    const interval = randChoice(active);
    const dir = s.direction === 'random' ? (Math.random() < 0.5 ? 'asc' : 'desc') : s.direction;
    const sign = dir === 'asc' ? 1 : -1;

    let root;
    if (s.root === 'random') {
      const [lo, hi] = range;
      const cands = [];
      for (let m = lo; m <= hi; m++) {
        const other = m + sign * interval.semis;
        if (other >= lo && other <= hi) cands.push(m);
      }
      // Range narrower than the interval: fall back to any root in range.
      if (!cands.length) for (let m = lo; m <= hi; m++) cands.push(m);
      root = randChoice(cands);
    } else {
      root = Number(s.root);
    }
    // Vowels drawn now so replays of this item use the same ones (when a note's vowel is set to Random).
    const randomVowels = [randChoice(VOWEL_KEYS), randChoice(VOWEL_KEYS)];
    const second = root + sign * interval.semis;
    // Likewise the instrument, used when the instrument setting is Random.
    const item = { root, second, interval, dir, randomVowels, instrument: pickInstrument([root, second]) };
    // Avoid repeating the exact same item twice in a row when there's a choice.
    if (!previous || previous.root !== item.root || previous.second !== item.second) return item;
  }
  return pickItem(s, range, null);
}

export const median = (arr) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
