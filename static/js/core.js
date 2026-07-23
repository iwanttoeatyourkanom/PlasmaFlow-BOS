// Entry point: shared DOM refs, app state, mode toggle, sliders, keyboard, fullscreen.
// No bundler here — every file in static/js shares one global scope and loads in the
// order listed at the bottom of index.html. Keep that order when adding a file.

// User guide popup + tabs
(function () {
  const openBtn = document.getElementById('captureGuideOpen');
  const closeBtn = document.getElementById('captureGuideClose');
  const modal = document.getElementById('captureGuideModal');
  const open = () => modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  const tabs = modal.querySelectorAll('.cg-tab');
  const panels = modal.querySelectorAll('.cg-tab-panel');
  const body = modal.querySelector('.cg-body');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    panels.forEach(p => { p.style.display = p.dataset.panel === tab.dataset.tab ? '' : 'none'; });
    if (body) body.scrollTop = 0;
  }));
})();

const refInput = document.getElementById('refInput');
const testInput = document.getElementById('testInput');
const testOnInput = document.getElementById('testOnInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const autoFloorBtn = document.getElementById('autoFloorBtn');
const autoThreshBtn = document.getElementById('autoThreshBtn');
const statusEl = document.getElementById('status');

let currentAnalysisData = {};

// px per mm, or null until the Scale card is calibrated. Persisted across reloads.
let calibPxPerMm = null;

// Compare mode reuses the single-mode cards but takes a second Test (Plasma ON)
// and runs /analyze twice with identical params, so OFF and ON stay comparable.
let appMode = 'single';

function updateAnalyzeEnabled() {
  const baseReady = refInput.files.length && testInput.files.length;
  const ready = appMode === 'compare' ? (baseReady && testOnInput.files.length) : baseReady;
  analyzeBtn.disabled = !ready;
  statusEl.style.color = 'var(--muted)';
  if (ready) statusEl.textContent = "Ready. Press Analyze when you're set.";
  else if (appMode === 'compare' && baseReady) statusEl.textContent = 'Upload the Plasma ON test to continue.';
  else statusEl.textContent = 'Upload both photos to continue.';
}

function setAppMode(mode) {
  appMode = mode;
  const isCompare = mode === 'compare';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('testOnZone').style.display = isCompare ? '' : 'none';
  document.getElementById('compareModeHint').style.display = isCompare ? '' : 'none';
  document.getElementById('testZoneLabel').textContent = isCompare ? 'Test (Plasma OFF, gas flowing)' : 'Test';
  document.getElementById('imageInputDesc').textContent = isCompare
    ? 'Upload the shared Reference (flow OFF), then a Test shot for Plasma OFF and one for Plasma ON.'
    : 'Upload two photos: flow OFF (reference) and flow ON (test).';
  document.getElementById('plasmaStatusRow').style.display = isCompare ? 'none' : '';
  analyzeBtn.textContent = isCompare ? 'Compare Analyze' : 'Analyze';
  updateAnalyzeEnabled();
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.onclick = () => setAppMode(btn.dataset.mode);
});

// Collapsible optional cards. Collapsed by default for a clean first view;
// once a user opens one, that choice is remembered across reloads.
document.querySelectorAll('.card.collapsible').forEach(card => {
  const num = card.querySelector('.card-num');
  const key = 'bosCollapse_' + (num ? num.textContent.trim() : '');
  try { if (localStorage.getItem(key) === 'open') card.classList.remove('collapsed'); } catch {}
  card.querySelector('.card-header').addEventListener('click', () => {
    card.classList.toggle('collapsed');
    try { localStorage.setItem(key, card.classList.contains('collapsed') ? 'closed' : 'open'); } catch {}
  });
});

document.getElementById('gainSlider').oninput = (e) => document.getElementById('gainVal').textContent = parseFloat(e.target.value).toFixed(1) + '×';
// Two-way sync between a slider and its number box. Clamp/round only on blur —
// doing it per keystroke fights typing (e.g. entering "80" one digit at a time).
function bindSliderNumber(sliderId, numberId) {
  const slider = document.getElementById(sliderId);
  const number = document.getElementById(numberId);
  const min = +slider.min, max = +slider.max;
  const clamp = (val) => {
    let v = Math.round(+val);
    if (Number.isNaN(v)) v = +slider.value;
    return Math.min(max, Math.max(min, v));
  };
  slider.addEventListener('input', () => { number.value = slider.value; });
  number.addEventListener('input', () => {
    if (number.value === '') return; // allow momentarily clearing the field while typing
    slider.value = number.value;
    paintRange(slider);
  });
  number.addEventListener('blur', () => {
    const v = clamp(number.value);
    number.value = v;
    slider.value = v;
    paintRange(slider);
  });
}
bindSliderNumber('threshSlider', 'threshVal');
bindSliderNumber('floorSlider', 'floorVal');
document.getElementById('alignToggle').onchange = (e) => document.getElementById('alignState').textContent = e.target.checked ? 'On' : 'Off';
document.getElementById('denoiseToggle').onchange = (e) => document.getElementById('denoiseState').textContent = e.target.checked ? 'On' : 'Off';

// Coalesce rapid edits (drag-adjust, renames, role toggles) into one request.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Keep range fill in sync with value
function paintRange(el) {
  const min = +el.min, max = +el.max, val = +el.value;
  const pct = ((val - min) / (max - min)) * 100;
  el.style.backgroundSize = pct + '% 100%';
}
['gainSlider', 'floorSlider', 'threshSlider'].forEach(id => {
  const el = document.getElementById(id);
  paintRange(el);
  el.addEventListener('input', () => paintRange(el));
});

document.getElementById('backBtn').onclick = () => {
  document.body.classList.remove('results-mode');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Ctrl/Cmd + Enter runs Analyze from anywhere on the setup page (not while the
// guide is open or results are showing).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const onSetup = !document.body.classList.contains('results-mode')
      && !document.body.classList.contains('compare-results-mode');
    const guideOpen = document.getElementById('captureGuideModal').classList.contains('open');
    if (onSetup && !guideOpen && !analyzeBtn.disabled) { e.preventDefault(); analyzeBtn.click(); }
  }
});

function openFullscreen(imgId) {
  document.getElementById('modalImg').src = document.getElementById(imgId).src;
  document.getElementById('imgModal').style.display = 'flex';
}

function closeFullscreen() {
  document.getElementById('imgModal').style.display = 'none';
}
