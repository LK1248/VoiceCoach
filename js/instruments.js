// Instrument definitions. `sf` is the General MIDI soundfont name used to fetch
// per-note MP3 samples; `vocalset` selects a recorded singer from
// samples/voices (with selectable vowels); neither means a plain synth tone.
// `range` is the default [min, max] MIDI range used for random roots.
// `gain` evens out loudness between sample sources.

export const INSTRUMENTS = {
  piano: { label: 'Piano', sf: 'acoustic_grand_piano', range: [48, 72] }, // C3–C5
  guitarNylon: { label: 'Guitar (nylon)', sf: 'acoustic_guitar_nylon', range: [40, 64] }, // E2–E4
  guitarSteel: { label: 'Guitar (steel)', sf: 'acoustic_guitar_steel', range: [40, 64] },
  // Recorded notes are C3–D4 (male) and C4–D5 (female); ranges extend ±2 semitones.
  male: { label: 'Male voice', vocalset: 'male', range: [46, 64], gain: 0.5 }, // A#2–E4
  female: { label: 'Female voice', vocalset: 'female', range: [58, 76], gain: 0.5 }, // A#3–E5
  choirAah: { label: 'Choir "aah" (sampled)', sf: 'choir_aahs', range: [48, 72] },
  voiceOoh: { label: 'Voice "ooh" (sampled)', sf: 'voice_oohs', range: [55, 76] },
  tone: { label: 'Pure tone (synth)', sf: null, range: [48, 72] },
};

export const VOWELS = [
  { key: 'A', hint: 'as in "ahh"' },
  { key: 'E', hint: 'as in "bear"' },
  { key: 'I', hint: 'as in "greed"' },
  { key: 'O', hint: 'as in "oh"' },
  { key: 'U', hint: 'as in "moon"' },
];

// Notes offered in the root / range pickers.
export const NOTE_MIN = 36; // C2
export const NOTE_MAX = 84; // C6
