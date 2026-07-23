// Remember the experiment/camera metadata fields across reloads.

// Metadata fields only (they rarely change between runs). Not ref/test files or
// ROI state — those belong to one specific image pair.
const PERSISTED_FIELD_IDS = [
  'gasType', 'flowRate', 'plasmaStatus', 'plasmaCond',
  'camType', 'focusSetting', 'iso', 'shutter', 'aperture', 'nozDist', 'lighting', 'notes',
];
const PERSIST_KEY = 'bosFormFields';

function savePersistedFields() {
  const data = {};
  PERSISTED_FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) data[id] = el.value;
  });
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(data)); } catch {}
}

function loadPersistedFields() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}'); } catch {}
  PERSISTED_FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && data[id] != null) el.value = data[id];
  });
}

PERSISTED_FIELD_IDS.forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', savePersistedFields);
    el.addEventListener('change', savePersistedFields);
  }
});
loadPersistedFields();
