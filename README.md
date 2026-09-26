# Voice Coach

A browser-based singing coach. No build step — plain HTML/CSS/ES modules.

**Live:** https://lk1248.github.io/VoiceCoach/

## Modes

- **Interval ID** — hear two notes, identify the interval (m2 … octave).
- **Interval Singing** — hear two notes, sing them back; live pitch tracking, per-note cents accuracy and steadiness, and reference-vs-take comparison playback.
- Registers and Vocal Range — planned.

Settings: instrument (piano, guitars, recorded male/female voice with a selectable vowel per note, pure tone), active intervals, direction, fixed or random root with a per-instrument range.

## Run locally

The microphone requires a secure origin (`https` or `localhost`), and ES modules require a server:

```bash
python -m http.server 5317
```

Then open http://localhost:5317.

## Credits

- **Voice recordings** (`samples/voices/`): derived from [VocalSet](https://zenodo.org/records/1442513) — J. Wilkins, P. Seetharaman, A. Wahl, B. Pardo, *VocalSet: A Singing Voice Dataset*, ISMIR 2018 — licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Singers m1 (baritone) and f5 (mezzo-soprano), straight-tone scales and arpeggios. Changes: notes cut, looped, loudness-normalized and resampled to 32 kHz; retuned at playback. Rebuild with `python tools/vocalset/build.py`.
- Instrument samples are streamed from the [MIDI.js soundfonts](https://github.com/gleitz/midi-js-soundfonts) (FluidR3_GM) on GitHub Pages; a synth tone is used if loading fails.
