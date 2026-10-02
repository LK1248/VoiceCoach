import { AudioEngine } from './audio.js?v=20261002235214';
import { MicRecorder } from './recorder.js?v=20261002235214';
import { INSTRUMENTS, RANDOM, pickInstrument, VOWELS } from './instruments.js?v=20261002235214';
import { settings, getRange, vowelsInUse, initSettingsUI, onSettingsChange } from './settings.js?v=20261002235214';
import { IdentifyMode } from './identify.js?v=20261002235214';
import { SingMode } from './sing.js?v=20261002235214';
import { RangeMode } from './range.js?v=20261002235214';
import { SingleMode } from './single.js?v=20261002235214';
import { initNoteRangeUI, getSingleRange } from './noteRange.js?v=20261002235214';

const engine = new AudioEngine();
const recorder = new MicRecorder(engine);
const loadStatus = document.getElementById('loadStatus');

const status = {
  fallback(used) {
    if (used) {
      loadStatus.textContent = 'Some samples failed to load — using a synth tone instead.';
      loadStatus.classList.add('warn');
    }
  },
};

/** Note-range ▶ button: play one note (random instrument/vowel drawn when set to Random). */
async function previewNote(midi) {
  const inst = settings.instrument === RANDOM ? pickInstrument([midi]) : settings.instrument;
  const vowel = settings.vowel1 === 'random' ? VOWELS[Math.floor(Math.random() * VOWELS.length)].key : settings.vowel1;
  engine.stopAll();
  const r = await engine.playSequence(inst, [midi], { dur: 1, vowels: [vowel] });
  status.fallback(r.fallback);
  // The mic mustn't take the preview (or its delayed echo) for singing.
  modes.single.ignoreMicUntil(r.end + 0.3 + engine.outputLatency + recorder.inputLatency);
}

initSettingsUI();
engine.setKeepAlive(settings.keepAlive);
const noteRange = initNoteRangeUI(document.getElementById('noteRange'), { onHear: previewNote });
const modes = {
  identify: new IdentifyMode(engine, recorder, status),
  single: new SingleMode(engine, recorder, status),
  sing: new SingMode(engine, recorder, status),
  range: new RangeMode(engine, recorder, status),
};
// Debug handle for in-browser tests (inspect modes / engine state); not used by the app.
window.voiceCoach = { modes, engine, recorder };
// Mic frames go to whichever theme is showing.
recorder.onFrame = (f) => modes[mode].onFrame?.(f);

// Preload samples for the current instrument's random range in the background.
let preloadToken = 0;
async function preloadRange() {
  const token = ++preloadToken;
  const inst = settings.instrument;
  loadStatus.classList.remove('warn');
  if (inst === RANDOM) { loadStatus.textContent = 'Random: each sound loads the first time it plays.'; return; }
  const def = INSTRUMENTS[inst];
  if (!def.sf && !def.vocalset) { loadStatus.textContent = 'Synthesized — no download needed.'; return; }
  // Interval themes' range plus the Single Note range.
  const [lo, hi] = getRange();
  const [sLo, sHi] = getSingleRange();
  const midis = new Set();
  for (let m = lo; m <= hi; m++) midis.add(m);
  for (let m = sLo; m <= sHi; m++) midis.add(m);
  const notes = [];
  const vs = def.vocalset ? vowelsInUse() : [null];
  for (const m of midis) for (const v of vs) notes.push([m, v ?? undefined]);
  const failed = await engine.preload(inst, notes, (done, fail, total) => {
    if (token === preloadToken) loadStatus.textContent = `Loading samples ${done + fail}/${total}…`;
  });
  if (token !== preloadToken) return;
  loadStatus.textContent = failed ? `${failed} samples failed to load — synth fallback will be used.` : 'Samples ready.';
  loadStatus.classList.toggle('warn', !!failed);
}
preloadRange();

onSettingsChange((field) => {
  if (['instrument', 'range', 'vowel', 'singleRange'].includes(field)) preloadRange();
  if (field === 'keepAlive') engine.setKeepAlive(settings.keepAlive);
  if (field === 'instrument') noteRange.render(); // range follows the instrument until set
  modes.single.onSettings(field);
  modes.range.onSettings(field);
  if (field === 'intervals') modes.identify.renderAnswers();
  if (field === 'hideSpectrum') modes.identify.renderSpectrum();
  modes.sing.onSettings(field);
});

// Tabs
let mode = 'identify';
document.querySelectorAll('.tab[data-mode]').forEach((tab) => {
  tab.onclick = () => {
    if (modes.sing.busy) return; // don't switch away mid-recording
    if (tab.dataset.mode === mode) return;
    modes[mode].deactivate?.();
    engine.stopAll();
    mode = tab.dataset.mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${mode}`; });
    if (mode === 'sing') modes.sing.draw();
    modes[mode].activate?.();
  };
});

// Keyboard shortcuts (handled per mode): N = new interval, Space = next, A = replay,
// interval answer keys 2–8 / W E T Y U, S = hear correct, D = hear your answer,
// R = try again (singing).
document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('select, textarea, input[type="text"], input[type="number"]') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.code === 'Space') e.preventDefault();
  modes[mode].onKey(e);
});
