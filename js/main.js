import { AudioEngine } from './audio.js?v=20260930215851';
import { MicRecorder } from './recorder.js?v=20260930215851';
import { INSTRUMENTS } from './instruments.js?v=20260930215851';
import { settings, getRange, vowelsInUse, initSettingsUI, onSettingsChange } from './settings.js?v=20260930215851';
import { IdentifyMode } from './identify.js?v=20260930215851';
import { SingMode } from './sing.js?v=20260930215851';
import { SingleMode } from './single.js?v=20260930215851';
import { initNoteRangeUI, getSingleRange } from './noteRange.js?v=20260930215851';

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

initSettingsUI();
const noteRange = initNoteRangeUI(document.getElementById('noteRange'));
const modes = {
  identify: new IdentifyMode(engine, status),
  single: new SingleMode(engine, recorder, status),
  sing: new SingMode(engine, recorder, status),
};
// Mic frames go to whichever theme is showing.
recorder.onFrame = (f) => modes[mode].onFrame?.(f);

// Preload samples for the current instrument's random range in the background.
let preloadToken = 0;
async function preloadRange() {
  const token = ++preloadToken;
  const inst = settings.instrument;
  loadStatus.classList.remove('warn');
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
  if (field === 'instrument') noteRange.render(); // range follows the instrument until set
  modes.single.onSettings(field);
  if (field === 'intervals') modes.identify.renderAnswers();
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
