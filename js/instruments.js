// Instrument definitions. `sf` is the General MIDI soundfont name used to fetch
// per-note MP3 samples; `vocalset` selects a recorded singer from
// samples/voices (with selectable vowels); neither means a plain synth tone.
// `range` is the default [min, max] MIDI range used for random roots.
// `gain` evens out loudness between sample sources.
// `playable` is the range that sounds natural (used when Random picks an
// instrument for given notes); defaults to `range`.

export const INSTRUMENTS = {
  piano: { label: 'Piano', sf: 'acoustic_grand_piano', range: [48, 72], playable: [21, 108] }, // C3–C5
  guitarNylon: { label: 'Guitar (nylon)', sf: 'acoustic_guitar_nylon', range: [40, 64], playable: [40, 76] }, // E2–E4
  guitarSteel: { label: 'Guitar (steel)', sf: 'acoustic_guitar_steel', range: [40, 64], playable: [40, 76] },
  // Recorded notes are C3–D4 (male) and C4–D5 (female); ranges extend ±2 semitones.
  male: { label: 'Male voice', vocalset: 'male', range: [46, 64], gain: 0.5 }, // A#2–E4
  female: { label: 'Female voice', vocalset: 'female', range: [58, 76], gain: 0.5 }, // A#3–E5
  choirAah: { label: 'Choir "aah" (sampled)', sf: 'choir_aahs', range: [48, 72], playable: [43, 79] },
  voiceOoh: { label: 'Voice "ooh" (sampled)', sf: 'voice_oohs', range: [55, 76], playable: [53, 79] },
  tone: { label: 'Pure tone (synth)', sf: null, range: [48, 72], playable: [21, 108] },
};

export const VOWELS = [
  { key: 'A', hint: 'as in "ahh"' },
  { key: 'E', hint: 'as in "bear"' },
  { key: 'I', hint: 'as in "greed"' },
  { key: 'O', hint: 'as in "oh"' },
  { key: 'U', hint: 'as in "moon"' },
];

// "Random" instrument: a real instrument is drawn per exercise item.
export const RANDOM = 'random';
export const RANDOM_RANGE = [48, 72]; // C3–C5: default range while Random is selected

/** Default note range for an instrument selection (including Random). */
export const instrumentRange = (key) => (key === RANDOM ? RANDOM_RANGE : INSTRUMENTS[key].range);

/**
 * Draw a random instrument whose natural range covers all of `midis`
 * (so e.g. the male voice isn't stretched to C5); any instrument if none fits.
 */
export function pickInstrument(midis) {
  const lo = Math.min(...midis);
  const hi = Math.max(...midis);
  const keys = Object.keys(INSTRUMENTS);
  const fits = keys.filter((k) => {
    const [a, b] = INSTRUMENTS[k].playable ?? INSTRUMENTS[k].range;
    return a <= lo && hi <= b;
  });
  const pool = fits.length ? fits : keys;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Notes offered in the root / range pickers.
export const NOTE_MIN = 36; // C2
export const NOTE_MAX = 84; // C6
