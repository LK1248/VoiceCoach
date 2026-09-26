"""Audio helpers: WAV I/O and a YIN pitch tracker (numpy only)."""
import numpy as np
from scipy.io import wavfile


def load_mono(path):
    sr, x = wavfile.read(path)
    if x.dtype.kind == "i":
        x = x.astype(np.float32) / np.iinfo(x.dtype).max
    x = x.astype(np.float32)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return sr, x


def yin_track(x, sr, hop=256, win=2048, fmin=70.0, fmax=1100.0, threshold=0.12):
    """Return (times, f0 Hz or 0 if unvoiced, aperiodicity, rms) per frame."""
    tau_min = int(sr / fmax)
    tau_max = min(int(sr / fmin), win // 2)
    n_frames = max(0, (len(x) - win) // hop)
    times = np.zeros(n_frames)
    f0 = np.zeros(n_frames)
    aper = np.ones(n_frames)
    rms = np.zeros(n_frames)
    for i in range(n_frames):
        frame = x[i * hop : i * hop + win]
        times[i] = (i * hop + win / 2) / sr
        rms[i] = np.sqrt(np.mean(frame**2))
        if rms[i] < 1e-3:
            continue
        # Difference function via FFT autocorrelation.
        w = win // 2
        seg = frame[:w]
        fft = np.fft.rfft(frame, 2 * win)
        acf = np.fft.irfft(fft * np.conj(np.fft.rfft(seg, 2 * win)))[: tau_max + 2]
        energy = np.cumsum(np.concatenate([[0.0], frame**2]))
        taus = np.arange(tau_max + 2)
        e_shift = energy[taus + w] - energy[taus]
        d = energy[w] + e_shift - 2 * acf
        d[0] = 0
        cmnd = np.ones_like(d)
        cmnd[1:] = d[1:] * np.arange(1, len(d)) / np.maximum(np.cumsum(d[1:]), 1e-12)
        cand = np.where(cmnd[tau_min:tau_max] < threshold)[0]
        if len(cand):
            t = cand[0] + tau_min
            while t + 1 < tau_max and cmnd[t + 1] < cmnd[t]:
                t += 1
        else:
            t = int(np.argmin(cmnd[tau_min:tau_max]) + tau_min)
            if cmnd[t] > 0.3:
                aper[i] = cmnd[t]
                continue
        a, b, c = cmnd[t - 1], cmnd[t], cmnd[t + 1]
        den = a - 2 * b + c
        shift = 0.5 * (a - c) / den if den else 0.0
        f0[i] = sr / (t + shift)
        aper[i] = b
    return times, f0, aper, rms


def hz_to_midi(f):
    return 69 + 12 * np.log2(np.asarray(f) / 440.0)


def segment_notes(times, f0, min_dur=0.25, tol_cents=45):
    """Split a pitch track into steady notes. Returns a list of dicts with
    start/end times, median MIDI pitch and pitch spread (cents, IQR)."""
    midi = np.where(f0 > 0, hz_to_midi(np.maximum(f0, 1e-6)), np.nan)
    notes = []
    i = 0
    n = len(midi)
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        j = i
        ref = midi[i]
        # Grow while pitch stays near the running median.
        while j + 1 < n and not np.isnan(midi[j + 1]) and abs(midi[j + 1] - ref) * 100 < tol_cents:
            j += 1
            ref = np.median(midi[i : j + 1])
        if times[j] - times[i] >= min_dur:
            seg = midi[i : j + 1]
            q1, q3 = np.percentile(seg, [25, 75])
            notes.append({
                "start": float(times[i]), "end": float(times[j]),
                "midi": float(np.median(seg)), "iqr_cents": float((q3 - q1) * 100),
            })
        i = j + 1
    return notes
