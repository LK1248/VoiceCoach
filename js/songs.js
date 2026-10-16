// Song references for Interval ID: the opening of a well-known tune for each interval and
// direction, played by the app (synthesized/sampled notes, never recordings).
// `notes`: [semitones from the phrase's first note, length in beats]; `pair`: indices of the
// two notes that make the interval; `bpm`: tempo. `also`: other well-known examples (names only).
// Phrases are a line or two of the tune where it is well known; a few stay at their first notes
// until the melody is checked (`short`). The pair is repeated on its own afterwards.

export const SONGS = {
  asc: {
    0: { name: 'Jingle Bells', notes: [[0, 1], [0, 1], [0, 2], [0, 1], [0, 1], [0, 2], [0, 1], [3, 1], [-4, 1.5], [-2, 0.5], [0, 4]], pair: [0, 1], bpm: 150 },
    1: { name: 'Jaws', notes: [[0, 1.5], [1, 1.5], [0, 0.5], [1, 0.5], [0, 0.5], [1, 0.5]], pair: [0, 1], bpm: 70 },
    2: {
      name: 'Frère Jacques',
      notes: [[0, 1], [2, 1], [4, 1], [0, 1], [0, 1], [2, 1], [4, 1], [0, 1], [4, 1], [5, 1], [7, 2], [4, 1], [5, 1], [7, 2]],
      pair: [0, 1], bpm: 110,
    },
    // "Ya feliz" (Ramito de violetas; in Hebrew, David Broza's "Sigaliot": "Hi hit-"), from the
    // user's piano recording (C Eb Bb Ab Ab Bb Bb Bb Ab G); timing from their sung recording
    // (beats = seconds at 60 bpm).
    3: {
      name: 'Ramito de violetas', also: 'Sigaliot (David Broza) · Greensleeves · Smoke on the Water',
      notes: [[0, 0.34], [3, 0.68], [10, 0.63], [8, 0.9], [8, 0.39], [10, 0.47], [10, 0.49], [10, 0.33], [8, 0.62], [7, 0.8]],
      pair: [0, 1], bpm: 60,
    },
    4: {
      name: 'When the Saints Go Marching In',
      notes: [[0, 1], [4, 1], [5, 1], [7, 4], [0, 1], [4, 1], [5, 1], [7, 4], [0, 1], [4, 1], [5, 1], [7, 2], [4, 2], [0, 2], [4, 2], [2, 4]],
      pair: [0, 1], bpm: 160,
    },
    5: { name: 'Here Comes the Bride', also: 'Amazing Grace', notes: [[0, 1], [5, 0.75], [5, 0.25], [5, 2], [0, 1], [7, 0.75], [4, 0.25], [5, 2]], pair: [0, 1], bpm: 70 },
    6: { name: 'The Simpsons', also: 'Maria (West Side Story)', short: true, notes: [[0, 1], [6, 2]], pair: [0, 1], bpm: 110 },
    7: {
      name: 'Star Wars (main theme)', also: 'Twinkle Twinkle Little Star', where: 'the leap after the opening triplet',
      notes: [[-5, 1 / 3], [-5, 1 / 3], [-5, 1 / 3], [0, 2], [7, 2], [5, 1 / 3], [4, 1 / 3], [2, 1 / 3], [12, 2], [7, 1]],
      pair: [3, 4], bpm: 100,
    },
    8: {
      name: 'The Entertainer', where: 'the leap up after the three rising notes',
      notes: [[-2, 0.5], [-1, 0.5], [0, 0.5], [8, 1], [0, 0.5], [8, 1], [0, 0.5], [8, 2]], pair: [2, 3], bpm: 90,
    },
    9: { name: 'My Bonnie Lies over the Ocean', also: 'NBC chime', notes: [[0, 1], [9, 1.5], [7, 0.5], [5, 1], [7, 1], [5, 1], [2, 1], [0, 2]], pair: [0, 1], bpm: 140 },
    10: { name: 'Star Trek (original series theme)', also: 'Somewhere (West Side Story)', short: true, notes: [[0, 1], [10, 2]], pair: [0, 1], bpm: 80 },
    11: { name: 'Take On Me (chorus)', short: true, notes: [[0, 1], [11, 2]], pair: [0, 1], bpm: 100 },
    12: { name: 'Somewhere Over the Rainbow', notes: [[0, 2], [12, 2], [11, 1], [7, 0.5], [9, 0.5], [11, 1], [12, 1]], pair: [0, 1], bpm: 90 },
  },
  desc: {
    0: { name: 'Jingle Bells', notes: [[0, 1], [0, 1], [0, 2], [0, 1], [0, 1], [0, 2], [0, 1], [3, 1], [-4, 1.5], [-2, 0.5], [0, 4]], pair: [0, 1], bpm: 150 },
    1: { name: 'Für Elise', also: 'Joy to the World', notes: [[0, 0.5], [-1, 0.5], [0, 0.5], [-1, 0.5], [0, 0.5], [-5, 0.5], [-2, 0.5], [-4, 0.5], [-7, 1.5]], pair: [0, 1], bpm: 110 },
    2: {
      name: 'Mary Had a Little Lamb', also: 'Three Blind Mice',
      notes: [[0, 1], [-2, 1], [-4, 1], [-2, 1], [0, 1], [0, 1], [0, 2], [-2, 1], [-2, 1], [-2, 2], [0, 1], [3, 1], [3, 2]],
      pair: [0, 1], bpm: 130,
    },
    3: { name: 'Hey Jude', also: 'This Old Man', notes: [[0, 1], [-3, 2], [-3, 0.5], [0, 0.5], [2, 0.5], [-5, 2.5]], pair: [0, 1], bpm: 75 },
    4: {
      name: "Beethoven's 5th Symphony", also: 'Imperial March (Star Wars)', where: 'the drop after the three repeated notes',
      notes: [[0, 0.5], [0, 0.5], [0, 0.5], [-4, 2.5], [-2, 0.5], [-2, 0.5], [-2, 0.5], [-5, 2.5]], pair: [2, 3], bpm: 110,
    },
    5: { name: 'Eine kleine Nachtmusik', notes: [[0, 1], [-5, 0.5], [0, 1], [-5, 0.5], [0, 0.5], [-5, 0.5], [0, 0.5], [4, 0.5], [7, 2]], pair: [0, 1], bpm: 110 },
    6: { name: 'YYZ (Rush)', short: true, notes: [[0, 1], [-6, 2]], pair: [0, 1], bpm: 100 },
    7: { name: 'The Flintstones', short: true, notes: [[0, 1], [-7, 1.5]], pair: [0, 1], bpm: 110 },
    8: { name: 'Love Story (theme)', unsure: true, short: true, notes: [[0, 1], [-8, 2]], pair: [0, 1], bpm: 80 },
    9: { name: "Nobody Knows the Trouble I've Seen", short: true, notes: [[0, 1], [-9, 2]], pair: [0, 1], bpm: 80 },
    12: { name: 'Willow Weep for Me', short: true, notes: [[0, 1], [-12, 2]], pair: [0, 1], bpm: 80 },
  },
};

/** The song for an interval (semitones) and direction ('asc' | 'desc'), or null. */
export const songFor = (semis, dir) => SONGS[dir === 'desc' ? 'desc' : 'asc'][semis] ?? null;

/** Key of a song in the settings (e.g. its YouTube video): 'asc:7'. */
export const songKey = (semis, dir) => `${dir === 'desc' ? 'desc' : 'asc'}:${semis}`;

/**
 * Parse a YouTube link (watch, youtu.be, shorts, embed; optional t= / start= time) into
 * { id, start } or null.
 */
export function parseYouTube(url) {
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (!/(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return null;
  let id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v');
  if (!id) id = u.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1];
  if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
  const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? '';
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const start = m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0;
  return { id, start };
}

/** YouTube search for a song (a search, not a fixed video: those disappear or move). */
export const youtubeSearch = (song) => `https://www.youtube.com/results?search_query=${encodeURIComponent(song.name.replace(/[()]/g, ''))}`;
