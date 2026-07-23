// Reference / Test / Reference-2 uploads (drag-drop + picker) and previews.

// ===== File Upload =====
function setupZone(zoneId, inputEl, previewBoxId, fileNameId) {
  const zone = document.getElementById(zoneId);

  zone.onclick = () => inputEl.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');

  zone.ondrop = e => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) setFile(inputEl, previewBoxId, fileNameId, e.dataTransfer.files[0]);
  };

  inputEl.onchange = () => {
    if (inputEl.files[0]) setFile(inputEl, previewBoxId, fileNameId, inputEl.files[0]);
  };
}

function setFile(inputEl, previewBoxId, fileNameId, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  inputEl.files = dt.files;

  document.getElementById(fileNameId).textContent = file.name;

  // Rebuild the ROI diff preview when both images are present. ROI/Compare
  // Regions are kept (normalized coords survive same-framing swaps); clear them
  // by hand if the framing actually changed. See reapplyRoiToNewCanvas().
  if (inputEl === refInput || inputEl === testInput) {
    if (refInput.files.length && testInput.files.length) {
      fetchDiffPreview();
    } else {
      resetRoiCanvas();
      setRoiBgStatus('Upload both Reference and Test first.');
    }
  }

  // The reference photo is where a ruler/known mark is visible, so it's what the
  // Scale card traces on. Load it there whenever a new reference comes in.
  if (inputEl === refInput) loadRefToCalibCanvas(file);

  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById(previewBoxId).innerHTML = `<img src="${e.target.result}" />`;
  };
  reader.readAsDataURL(file);

  updateAnalyzeEnabled();
}

setupZone('refZone', refInput, 'refPreviewBox', 'refFileName');
setupZone('testZone', testInput, 'testPreviewBox', 'testFileName');

// Reference 2 is an optional flow-OFF/flow-OFF shot for the noise baseline. It
// doesn't touch the diff preview, ROI, or the Analyze button, so it gets this
// lighter setup rather than setFile/setupZone.
function setControlFile(inputEl, previewBoxId, fileNameId, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  inputEl.files = dt.files;
  document.getElementById(fileNameId).textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById(previewBoxId).innerHTML = `<img src="${e.target.result}" />`;
  };
  reader.readAsDataURL(file);
}
function setupControlZone(zoneId, inputEl, previewBoxId, fileNameId) {
  const zone = document.getElementById(zoneId);
  zone.onclick = () => inputEl.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) setControlFile(inputEl, previewBoxId, fileNameId, e.dataTransfer.files[0]);
  };
  inputEl.onchange = () => {
    if (inputEl.files[0]) setControlFile(inputEl, previewBoxId, fileNameId, inputEl.files[0]);
  };
}
const ctrlRef2Input = document.getElementById('ctrlRef2Input');
setupControlZone('ctrlRef2Zone', ctrlRef2Input, 'ctrlRef2PreviewBox', 'ctrlRef2FileName');

// Test (Plasma ON), compare-mode only. Reuses the same generic zone setup as
// Reference 2 above, then layers on an Analyze-enabled check (Reference 2 is
// optional so it doesn't need one, but this photo is required in compare mode).
setupControlZone('testOnZone', testOnInput, 'testOnPreviewBox', 'testOnFileName');
(function wireTestOnEnableCheck() {
  const zone = document.getElementById('testOnZone');
  const origDrop = zone.ondrop;
  zone.ondrop = (e) => { origDrop(e); updateAnalyzeEnabled(); };
  const origChange = testOnInput.onchange;
  testOnInput.onchange = () => { origChange(); updateAnalyzeEnabled(); };
})();

// Purely a visibility toggle. A file already chosen in the hidden zone stays
// selected and still gets uploaded on Analyze either way.
document.getElementById('toggleCtrlBtn').onclick = () => {
  const wrap = document.getElementById('ctrlZonesWrap');
  const btn = document.getElementById('toggleCtrlBtn');
  const visible = wrap.style.display !== 'none';
  wrap.style.display = visible ? 'none' : 'block';
  btn.textContent = visible ? 'Show' : 'Hide';
};
