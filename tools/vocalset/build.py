"""Build the sung-vowel sample library from VocalSet recordings.

For each voice (one male, one female singer) and vowel, this:
  1. tracks pitch in the straight-tone scale and arpeggio recordings,
  2. works out the file's overall tuning offset and maps each steady note to
     the C-major scale degree the singer intended,
  3. keeps the best take per pitch (long and steady),
  4. cuts it, sets pitch-synchronous crossfaded loop points in the steady part
     so notes can be held for any length, normalizes loudness,
  5. writes 16-bit mono WAVs + samples/voices/manifest.json.

The app retunes each sample to exact pitch using the measured f0 (playbackRate),
and fills non-recorded pitches from the nearest recorded one.

Usage:  python build.py      (downloads missing source files first)
Source: VocalSet (Wilkins et al., 2018), CC BY 4.0 — https://zenodo.org/records/1442513
"""
import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

from fetch import fetch
from pitch import load_mono, yin_track, segment_notes, hz_to_midi

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "samples" / "voices"
OUT_SR = 32000
VOWELS = "aeiou"
VOICES = {
    # voice: (VocalSet singer folder, file prefix, expected C-major range)
    "male": ("male1", "m1", (48, 62)),  # baritone, sings C3–D4
    "female": ("female5", "f5", (60, 74)),  # mezzo-soprano, sings C4–D5
}
# Files that don't follow the usual naming pattern.
NAME_OVERRIDES = {"m1_scales_straight_u.wav": "m1_straight_tone_scales_u.wav"}
C_MAJOR = {0, 2, 4, 5, 7, 9, 11}
STEADY_TOL = 30  # cents: max deviation from the note's median inside the looped core
MIN_LOOP = 0.15  # seconds
TARGET_RMS = 0.08
XFADE = 0.03  # loop crossfade, seconds
PRE_ROLL = 0.02  # audio kept before the steady region, seconds


def tuning_offset(midis):
    """Offset in semitones (-0.5..0.5) that best aligns the notes to C major."""
    best, best_err = 0.0, 1e9
    for o in np.arange(-0.5, 0.5, 0.01):
        err = 0.0
        for m in midis:
            cands = [round(m - o) + k for k in (-1, 0, 1)]
            err += min((m - o - c) ** 2 for c in cands if c % 12 in C_MAJOR)
        if err < best_err:
            best, best_err = o, err
    return best


def intended_note(m, offset):
    cands = [round(m - offset) + k for k in (-1, 0, 1)]
    return min((c for c in cands if c % 12 in C_MAJOR), key=lambda c: abs(m - offset - c))


def source_name(folder, prefix, kind, vowel):
    name = f"{prefix}_{kind}_straight_{vowel}.wav"
    return f"FULL/{folder}/{kind}/straight/{NAME_OVERRIDES.get(name, name)}"


def steady_core(times, f0, start, end, tol_cents=STEADY_TOL):
    """Longest run of frames within tol of the median pitch inside [start, end]."""
    idx = np.where((times >= start) & (times <= end) & (f0 > 0))[0]
    midi = hz_to_midi(f0[idx])
    med = np.median(midi)
    ok = np.abs(midi - med) * 100 <= tol_cents
    best = (0, 0)
    run_start = None
    for k, good in enumerate(np.append(ok, False)):
        if good and run_start is None:
            run_start = k
        elif not good and run_start is not None:
            if k - run_start > best[1] - best[0]:
                best = (run_start, k)
            run_start = None
    if best[1] - best[0] < 3:
        return None
    sel = idx[best[0] : best[1]]
    return times[sel[0]], times[sel[-1]], float(np.median(hz_to_midi(f0[sel])))


def make_sample(x, sr, core_start, core_end, f0_midi):
    """Cut [core_start - PRE_ROLL, core_end] and set a crossfaded, pitch-synchronous loop."""
    start = max(0, int((core_start - PRE_ROLL) * sr))
    end = int(core_end * sr)
    y = x[start:end].astype(np.float64).copy()
    period = sr / (440 * 2 ** ((f0_midi - 69) / 12))
    xf = int(XFADE * sr)
    # Loop over the steady part after the attack: whole number of periods.
    loop_start = int(PRE_ROLL * sr) + xf + int(0.03 * sr)
    avail = len(y) - loop_start
    n_periods = int(avail / period)
    if n_periods * period < MIN_LOOP * sr:
        return None
    loop_len = int(round(n_periods * period))
    loop_end = loop_start + loop_len
    # Snap loop_start to a rising zero crossing, keep loop_end exactly n periods later.
    zc = np.where((y[loop_start - 1 : loop_start + int(period)] <= 0) & (y[loop_start : loop_start + int(period) + 1] > 0))[0]
    if len(zc):
        loop_start += int(zc[0])
        loop_end = loop_start + loop_len
    if loop_end > len(y):
        loop_end -= int(round(period))
        loop_len = loop_end - loop_start
    # Crossfade the end of the loop into the audio just before loop_start, so
    # jumping from loop_end back to loop_start is seamless.
    w = np.linspace(0, 1, xf)
    y[loop_end - xf : loop_end] = y[loop_end - xf : loop_end] * (1 - w) + y[loop_start - xf : loop_start] * w
    y = y[:loop_end]
    # Short fade-in; normalize loudness on the loop region.
    fi = int(0.012 * sr)
    y[:fi] *= np.linspace(0, 1, fi)
    rms = np.sqrt(np.mean(y[loop_start:loop_end] ** 2))
    y *= TARGET_RMS / max(rms, 1e-9)
    return y, loop_start, loop_end


def build_voice(voice, folder, prefix, expected):
    lo, hi = expected
    paths = {(kind, v): p for (kind, v), p in zip(
        [(k, v) for k in ("scales", "arpeggios") for v in VOWELS],
        fetch([source_name(folder, prefix, k, v) for k in ("scales", "arpeggios") for v in VOWELS]))}
    entries = {}
    report = []
    for v in VOWELS:
        takes = {}
        for kind in ("scales", "arpeggios"):
            sr, x = load_mono(paths[(kind, v)])
            times, f0, _, _ = yin_track(x, sr)
            notes = segment_notes(times, f0)
            offset = tuning_offset([n["midi"] for n in notes])
            for n in notes:
                target = intended_note(n["midi"], offset)
                if not lo <= target <= hi:
                    continue  # octave error or out-of-range
                core = steady_core(times, f0, n["start"], n["end"])
                if not core:
                    continue
                cs, ce, f0m = core
                dur = ce - cs
                score = min(dur, 0.9) - n["iqr_cents"] / 200
                if target not in takes or score > takes[target]["score"]:
                    takes[target] = dict(score=score, x=x, sr=sr, cs=cs, ce=ce, f0m=f0m)
        entries[v] = []
        for target in sorted(takes):
            t = takes[target]
            made = make_sample(t["x"], t["sr"], t["cs"], t["ce"], t["f0m"])
            if not made:
                continue
            y, ls, le = made
            y = resample_poly(y, OUT_SR, t["sr"])
            ls, le = ls * OUT_SR / t["sr"], le * OUT_SR / t["sr"]
            y = y[: int(round(le))]
            rel = f"{voice}/{v}_{target}.wav"
            (OUT / voice).mkdir(parents=True, exist_ok=True)
            wavfile.write(OUT / rel, OUT_SR, (np.clip(y, -1, 1) * 32767).astype(np.int16))
            entries[v].append({
                "midi": target, "f0": round(t["f0m"], 3), "file": rel,
                "loopStart": round(ls / OUT_SR, 5), "loopEnd": round(le / OUT_SR, 5),
            })
            report.append(f"{voice} {v} {target}: tuned {(t['f0m'] - target) * 100:+.0f}c, "
                          f"steady {t['ce'] - t['cs']:.2f}s, loop {(le - ls) / OUT_SR:.2f}s")
    return entries, report


def main():
    manifest = {
        "source": "VocalSet (Wilkins, Seetharaman, Wahl, Pardo, 2018), CC BY 4.0, https://zenodo.org/records/1442513",
        "voices": {},
    }
    for voice, (folder, prefix, expected) in VOICES.items():
        entries, report = build_voice(voice, folder, prefix, expected)
        manifest["voices"][voice] = {"singer": prefix, "notes": entries}
        print("\n".join(report))
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(p.stat().st_size for p in OUT.rglob("*.wav"))
    print(f"wrote {sum(len(n) for v in manifest['voices'].values() for n in v['notes'].values())} samples, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
