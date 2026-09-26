// Instrument definitions. `sf` is the General MIDI soundfont name used to fetch
// per-note MP3 samples; `null` means synthesized in the browser.
// `range` is the default [min, max] MIDI range used for random roots.

export const INSTRUMENTS = {
  piano: { label: 'Piano', sf: 'acoustic_grand_piano', range: [48, 72] }, // C3–C5
  guitarNylon: { label: 'Guitar (nylon)', sf: 'acoustic_guitar_nylon', range: [40, 64] }, // E2–E4
  guitarSteel: { label: 'Guitar (steel)', sf: 'acoustic_guitar_steel', range: [40, 64] },
  male: { label: 'Male voice', sf: 'choir_aahs', range: [45, 64] }, // A2–E4
  female: { label: 'Female voice', sf: 'voice_oohs', range: [55, 76] }, // G3–E5
  tone: { label: 'Pure tone (synth)', sf: null, range: [48, 72] },
};

// Notes offered in the root / range pickers.
export const NOTE_MIN = 36; // C2
export const NOTE_MAX = 84; // C6
