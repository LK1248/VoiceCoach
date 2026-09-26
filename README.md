# Voice Coach

A browser-based singing coach. No build step — plain HTML/CSS/ES modules.

## Modes

- **Interval ID** — hear two notes, identify the interval (m2 … octave).
- **Interval Singing** — hear two notes, sing them back; live pitch tracking, per-note cents accuracy and steadiness, and reference-vs-take comparison playback.
- Registers and Vocal Range — planned.

Settings: instrument (piano, guitars, male/female voice, pure tone), active intervals, direction, fixed or random root with a per-instrument range.

## Run locally

The microphone requires a secure origin (`https` or `localhost`), and ES modules require a server:

```bash
python -m http.server 5317
```

Then open http://localhost:5317.

Instrument samples are streamed from the [MIDI.js soundfonts](https://github.com/gleitz/midi-js-soundfonts) (FluidR3_GM) on GitHub Pages; a synth tone is used if loading fails.
