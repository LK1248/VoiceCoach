# Voice Coach

A browser-based singing coach. No build step — plain HTML/CSS/ES modules.

**Live:** https://lk1248.github.io/VoiceCoach/

## Modes

- **Interval ID** — hear two notes, identify the interval (m2 … octave).
- **Single Note** — *pitch alignment*: hear a note, sing it as many times as you like; each attempt is scored and graphed over the earlier ones. *Pitch following*: hold each note within tolerance for a set time to advance to the next; successes are counted per run. Notes come from a range (vertical slider) with per-note checkboxes.
- **Interval Singing** — hear two notes, sing them back; live pitch tracking, per-note cents accuracy and steadiness, and reference-vs-take comparison playback.
- Registers and Vocal Range — planned.

Settings: instrument (piano, guitars, recorded male/female voice with a selectable vowel per note, pure tone), active intervals, direction, fixed or random root with a per-instrument range.

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
