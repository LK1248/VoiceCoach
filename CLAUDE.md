# Voice Coach — notes for Claude

Browser-based singing coach. Plain HTML/CSS/ES modules, no build step, no dependencies.
Live: https://lk1248.github.io/VoiceCoach/ (GitHub Pages from `main`, repo `LK1248/VoiceCoach`, public).

## Workflow (do this every time)

- **Local server:** `python tools/serve.py [port]` (default 5317; sends `Cache-Control: no-cache`).
  The preview tool's `voice-coach` launch config runs it on 5317. Background `python` servers
  started from Bash get killed after ~10 min — prefer `preview_start` with `voice-coach`.
- **Before every commit touching `js/` or `css/`:** `python tools/stamp_version.py`. It rewrites
  `?v=…` on every module import and on the CSS/JS links in `index.html`. Without it browsers
  (and GitHub Pages' 10-min cache) mix new and stale modules — this broke the app once.
  New modules should import with `?v=0`; the stamp script fixes the version.
- When importing app modules in browser test scripts, use the same `?v=` as `index.html`
  (read it from `document.querySelector('script[type=module]').src`), otherwise you get a
  second module instance and monkey-patches don't apply.
- Commit/push only when the user asks. After pushing, poll the Pages build
  (`gh api repos/LK1248/VoiceCoach/pages/builds/latest`) and check the live site.
- `gh` is at `C:\Program Files\GitHub CLI\gh.exe` (not on PATH; call via PowerShell).
- The user's WAV takes live in `recordings/` (git-ignored). Replaying them offline through the
  app's own code (chunked like the live recorder: 1024-sample chunks, 2048 window) is the
  primary way to tune analysis. Test several chunk offsets (0–896 step 128) — results must not
  depend on chunk alignment.
- The browser pane is usually hidden during tests → `requestAnimationFrame` doesn't fire.
  Anything that must run during recording is driven by mic frames, not rAF.
- `window.voiceCoach = { modes, engine, recorder }` exposes app internals for browser tests.
- The mic can't be used in the preview pane; tests fake `navigator.mediaDevices.getUserMedia`
  with an AudioContext → MediaStreamDestination (oscillators, or a WAV buffer source).

## Architecture

- `js/main.js` — wiring, tabs, keyboard shortcuts, sample preloading, routes mic frames to the active theme.
- Themes: `identify.js` (Interval ID), `single.js` (Single Note: pitch alignment / following),
  `sing.js` (Interval Singing), `range.js` (Vocal Range). Registers tab not built yet.
- `audio.js` engine (sampled instruments, VocalSet voices with loop points, keep-alive noise,
  spectrum analyser on output); `recorder.js` (AudioWorklet mic capture, history buffer for
  back-dated starts, per-frame pitch + clarity + rms + H1–H2, spectrum analyser with 65 Hz HP).
- `pitch.js` MPM detector; `grading.js` shared note scoring; `plot.js` pitch graphs;
  `spectrum.js` log-frequency spectrum (48 points/octave, fixed −120…−20 dBFS axis);
  `roomNoise.js` shared room-noise calibration; `noteRange.js` vertical range slider;
  `settings.js` persisted settings (localStorage).
- `samples/voices/` built by `tools/vocalset/build.py` from VocalSet (CC BY 4.0 — attribution in
  footer and README must stay). Singers m1 (baritone) and f5 (mezzo).

## Vocal Range analysis — findings from the user's real recordings

Do not loosen these without re-checking against `recordings/`:
- H1–H2 (fundamental vs 2nd harmonic) swings up to **~17 dB** from loudness swells and
  vowel-resonance crossings; real register flips are **~30 dB** (with a ~1–1.6 semitone crack).
  Timbre-only switches therefore need ≥ 18 dB; confirmed switches = crack + agreeing timbre
  change ≥ 6 dB; confirmed switches outrank unconfirmed ones (max 2 per direction).
- Changes must persist (0.4 s) and the comparison span must not straddle the siren's turning point.
- False pitch: frames with **H1–H2 < −25 dB** are wrong-pitch locks (e.g. 1.5× the real pitch;
  the "fundamental" doesn't exist). Real singing never went below −17 dB.
- False range: hum before singing (~60 Hz), octave slips at note ends, and a lock onto a real
  low sound at ~1/5 of the sung pitch. Handled by: C2 floor, relative level gate, continuous
  stretches ≥ 0.2 s (short stretches kept only between sustained singing = transitions), and
  dropping stretches that jump > 9 semitones from a longer neighbour at the **boundary**
  (compare boundary pitches, not medians — medians of gliding stretches broke this once).
- Holds: 0.5 s within ±0.5 semitone, counted if within 1.5 semitones of the extreme (overshoot).
- Known gap: a loud steady hum ≥ 65 Hz would be taken as singing (could use the room-noise profile).
- The user's voice: flips **into head around G3–A3** going up, **back down around A♯3–B3**;
  chest siren top ≈ G4–B4; usable range roughly A♯2–C♯5. Mic picks up some low-frequency noise.

## Design decisions (agreed with the user)

- Register (Chest/Head/Falsetto/Mix; Whistle/Fry) is separate from siren style (vowel / nasal
  "ng" / lip trill): nasality and trills are independent of register; falsetto is not.
- Results are per session only — no saving/history yet (would need accounts or local storage design).
- Voice type is shown as a rough "closest / also consistent" guide with caveats, never a verdict.
- Bluetooth: keep-alive noise (on by default), latency compensation from `outputLatency` + mic `latency`.
- Keyboard shortcuts: N new, A replay/hear, Space next, R try again (singing), interval keys
  2–8 (major/perfect) and W E T Y U (minor/tritone), S / D hear correct / your answer.
- UI text: shortcut letters shown capitalised.
