import { AudioEngine } from './audio.js';
import { MicRecorder } from './recorder.js';
import { INSTRUMENTS } from './instruments.js';
import { settings, getRange, vowelsInUse, initSettingsUI, onSettingsChange } from './settings.js';
import { IdentifyMode } from './identify.js';
import { SingMode } from './sing.js';

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
const modes = {
  identify: new IdentifyMode(engine, status),
  sing: new SingMode(engine, recorder, status),
};

// Preload samples for the current instrument's random range in the background.
let preloadToken = 0;
async function preloadRange() {
  const token = ++preloadToken;
  const inst = settings.instrument;
  loadStatus.classList.remove('warn');
  const def = INSTRUMENTS[inst];
  if (!def.sf && !def.vocalset) { loadStatus.textContent = 'Synthesized — no download needed.'; return; }
  const [lo, hi] = getRange();
  const notes = [];
  const vs = def.vocalset ? vowelsInUse() : [null];
  for (let m = lo; m <= hi; m++) for (const v of vs) notes.push([m, v ?? undefined]);
  const failed = await engine.preload(inst, notes, (done, fail, total) => {
    if (token === preloadToken) loadStatus.textContent = `Loading samples ${done + fail}/${total}…`;
  });
  if (token !== preloadToken) return;
  loadStatus.textContent = failed ? `${failed} samples failed to load — synth fallback will be used.` : 'Samples ready.';
  loadStatus.classList.toggle('warn', !!failed);
}
preloadRange();

onSettingsChange((field) => {
  if (field === 'instrument' || field === 'range' || field === 'vowel') preloadRange();
  if (field === 'intervals') modes.identify.renderAnswers();
  modes.sing.onSettings(field);
});

// Tabs
let mode = 'identify';
document.querySelectorAll('.tab[data-mode]').forEach((tab) => {
  tab.onclick = () => {
    if (modes.sing.busy) return; // don't switch away mid-recording
    engine.stopAll();
    mode = tab.dataset.mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${mode}`; });
    if (mode === 'sing') modes.sing.draw();
  };
});

// Keyboard shortcuts: Space = new/next, R = replay
document.addEventListener('keydown', (e) => {
  if (e.target.matches('select, input') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.code === 'Space') e.preventDefault();
  modes[mode].onKey(e);
});
