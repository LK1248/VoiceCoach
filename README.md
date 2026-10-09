# Voice Coach

A browser-based singing coach. No build step — plain HTML/CSS/ES modules.

**Live:** https://lk1248.github.io/VoiceCoach/

## Modes

- **Interval ID** — hear two notes (ascending, descending or together), identify the interval (unison … minor 9th). After answering: the notes' spectrum and brightness vs. pitch; for notes played together, which harmonics they share, which beat, and a roughness curve for that sound.
- **Single Note** — *pitch alignment*: hear a note, sing it as many times as you like; each attempt is scored and graphed over the earlier ones. *Pitch following*: hold each note within tolerance for a set time to advance to the next; successes are counted per run. Notes come from a range (vertical slider) with per-note checkboxes.
- **Interval Singing** — hear two notes, sing them back; live pitch tracking, per-note cents accuracy and steadiness, and reference-vs-take comparison playback.
- **Patterns** — hear a scale, arpeggio, vocal warm-up or random melody, then sing it back (or sing along): every note is scored, plus how far you drifted from the starting key. The starting note can be fixed, random, or step by a semitone each round.
- **With Chords** — a major or minor chord plays (piano, acoustic or electric guitar, violin; block chord or arpeggio) while you sing one note of its scale over it, as scored attempts or hold-to-advance. Headphones recommended; a best-effort Speakers mode measures the chord through the microphone and reads your pitch from what rises above it.
- **Vocal Range** — siren up and down in a chosen register (Chest, Head, Falsetto, Mix; Whistle, Fry) on a vowel, nasal "ng" or lip trill. Measures full range, usable range (extremes held ~0.5 s) and the range within the register; marks register switches (pitch cracks / sudden H1–H2 changes) as crack, abrupt or gradual, with the up/down gap; compares the session's range with conventional voice types.
- Registers — planned.

Settings: instrument (piano, guitars, recorded male/female voice with a selectable vowel per note, synth tones (triangle, square, sawtooth), pure tone (sine), or random), active intervals, direction, fixed or random root with a per-instrument range.

## Run locally

The microphone requires a secure origin (`https` or `localhost`), and ES modules require a server:

```bash
python tools/serve.py
```

Then open http://localhost:5317. (`tools/serve.py` sends `Cache-Control: no-cache` so the browser never runs stale modules.)

Before committing changes to `js/` or `css/`, stamp a new version so browsers and GitHub Pages don't mix cached old files with new ones:

```bash
python tools/stamp_version.py
```

## Credits

- **Voice recordings** (`samples/voices/`): derived from [VocalSet](https://zenodo.org/records/1442513) — J. Wilkins, P. Seetharaman, A. Wahl, B. Pardo, *VocalSet: A Singing Voice Dataset*, ISMIR 2018 — licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Singers m1 (baritone) and f5 (mezzo-soprano), straight-tone scales and arpeggios. Changes: notes cut, looped, loudness-normalized and resampled to 32 kHz; retuned at playback. Rebuild with `python tools/vocalset/build.py`.
- Instrument samples are streamed from the [MIDI.js soundfonts](https://github.com/gleitz/midi-js-soundfonts) (FluidR3_GM) on GitHub Pages; a synth tone is used if loading fails.
