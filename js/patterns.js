// Melodic patterns for the Patterns theme: scales, arpeggios, vocal warm-ups and random
// melodies, as semitone offsets from the tonic.

export const SCALES = {
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  natMinor: { label: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmMinor: { label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  melMinor: { label: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  majPent: { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minPent: { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { label: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  wholeTone: { label: 'Whole-tone', steps: [0, 2, 4, 6, 8, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const ARPEGGIOS = {
  maj: { label: 'Major triad', steps: [0, 4, 7] },
  min: { label: 'Minor triad', steps: [0, 3, 7] },
  dim: { label: 'Diminished triad', steps: [0, 3, 6] },
  aug: { label: 'Augmented triad', steps: [0, 4, 8] },
  dom7: { label: 'Dominant 7th', steps: [0, 4, 7, 10] },
  maj7: { label: 'Major 7th', steps: [0, 4, 7, 11] },
  min7: { label: 'Minor 7th', steps: [0, 3, 7, 10] },
};

// Warm-ups: scale degrees (1 = tonic, 8 = octave) of the major or natural minor scale.
export const WARMUPS = {
  five: { label: 'Five-note scale (1-2-3-4-5-4-3-2-1)', degrees: [1, 2, 3, 4, 5, 4, 3, 2, 1] },
  triad: { label: 'Triad (1-3-5-3-1)', degrees: [1, 3, 5, 3, 1] },
  octaveArp: { label: 'Octave arpeggio (1-3-5-8-5-3-1)', degrees: [1, 3, 5, 8, 5, 3, 1] },
  brokenOctave: { label: 'Fifth and octave (1-5-8-5-1)', degrees: [1, 5, 8, 5, 1] },
  thirds: { label: 'Scale in thirds (1-3-2-4-3-5…)', degrees: [1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 8] },
  returning: { label: 'Back to the tonic (1-2-1-3-1-4…)', degrees: [1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1, 8] },
  nine: { label: 'Nine-note scale (1…9…1)', degrees: [1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4, 3, 2, 1] },
};

export const SHAPES = {
  up: 'Up',
  down: 'Down',
  updown: 'Up & down',
  downup: 'Down & up',
};

export const FAMILIES = {
  scale: 'Scale',
  arpeggio: 'Arpeggio',
  warmup: 'Vocal warm-up',
  random: 'Random melody',
};

const degreeOffset = (steps, d) => steps[(d - 1) % steps.length] + 12 * Math.floor((d - 1) / steps.length);

function shaped(up, shape) {
  const down = [...up].reverse();
  if (shape === 'down') return down;
  if (shape === 'updown') return [...up, ...down.slice(1)];
  if (shape === 'downup') return [...down, ...up.slice(1)];
  return up;
}

/**
 * Build the pattern chosen in the settings: { offsets, name } with `offsets` in semitones
 * above the tonic (all ≥ 0). Random melodies are drawn here, so keep the result to repeat it.
 */
export function buildPattern(s) {
  if (s.patFamily === 'arpeggio') {
    const a = ARPEGGIOS[s.patArp] ?? ARPEGGIOS.maj;
    const up = s.patOctave ? [...a.steps, 12] : a.steps;
    return { offsets: shaped(up, s.patShape), name: `${a.label}, ${SHAPES[s.patShape].toLowerCase()}` };
  }
  if (s.patFamily === 'warmup') {
    const w = WARMUPS[s.patWarm] ?? WARMUPS.five;
    const steps = (s.patQuality === 'minor' ? SCALES.natMinor : SCALES.major).steps;
    return { offsets: w.degrees.map((d) => degreeOffset(steps, d)), name: `${w.label.replace(/ \(.*/, '')}, ${s.patQuality}` };
  }
  const sc = SCALES[s.patScale] ?? SCALES.major;
  if (s.patFamily === 'random') {
    // Notes of the scale within one octave above the tonic; starts on the tonic, never
    // repeats a note twice in a row, and never leaps more than patLeap semitones.
    const pool = [...sc.steps, 12];
    const offsets = [0];
    while (offsets.length < s.patCount) {
      const prev = offsets[offsets.length - 1];
      const next = pool.filter((o) => o !== prev && Math.abs(o - prev) <= s.patLeap);
      if (!next.length) break; // leap limit smaller than the scale's smallest step
      offsets.push(next[Math.floor(Math.random() * next.length)]);
    }
    return { offsets, name: `Random melody, ${sc.label.toLowerCase()}` };
  }
  return { offsets: shaped([...sc.steps, 12], s.patShape), name: `${sc.label} scale, ${SHAPES[s.patShape].toLowerCase()}` };
}
