// Auto sliders and the single-run Analyze flow.

// ===== Auto (armed) sliders =====
// Clicking Auto just arms/locks the slider; the value is fetched from
// /suggest_params at Analyze time (applyAutoValues). `field` is the response key.
const autoControls = [
  { btn: autoFloorBtn, slider: document.getElementById('floorSlider'), valEl: document.getElementById('floorVal'), field: 'noise_floor' },
  { btn: autoThreshBtn, slider: document.getElementById('threshSlider'), valEl: document.getElementById('threshVal'), field: 'threshold' },
];

autoControls.forEach(({ btn, slider, valEl }) => {
  btn.onclick = () => {
    const armed = btn.classList.toggle('active');
    slider.disabled = armed;           // lock while armed
    valEl.disabled = armed;            // lock the typed-value box too
    valEl.classList.toggle('is-auto', armed);
  };
});

// /suggest_params reads noise percentiles assuming a mostly-BACKGROUND region, so
// scope it to a Background-tagged region (never the signal ROI, which would feed
// the jet into a "what does noise look like" calc). No background tagged -> whole image.
function getSuggestScopeRoi() {
  const bg = multiRois.find(m => m.role === 'background');
  return bg ? { x: bg.x, y: bg.y, w: bg.w, h: bg.h } : null;
}

// Fill in every armed slider from /suggest_params. Runs once (one request covers
// both values). Throws on failure so Analyze can surface the error and abort.
async function applyAutoValues() {
  const armed = autoControls.filter(c => c.btn.classList.contains('active'));
  if (!armed.length) return;

  const fd = new FormData();
  fd.append('reference', refInput.files[0]);
  fd.append('test', testInput.files[0]);
  const autoRoi = getSuggestScopeRoi();
  if (autoRoi) {
    fd.append('roi_x', autoRoi.x.toFixed(6));
    fd.append('roi_y', autoRoi.y.toFixed(6));
    fd.append('roi_w', autoRoi.w.toFixed(6));
    fd.append('roi_h', autoRoi.h.toFixed(6));
  }
  fd.append('align', document.getElementById('alignToggle').checked ? 'true' : 'false');
  fd.append('denoise', document.getElementById('denoiseToggle').checked ? 'true' : 'false');

  const res = await fetch('/suggest_params', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Server error (${res.status})`);
  }
  const data = await res.json();

  armed.forEach(c => {
    c.slider.value = data[c.field];
    c.valEl.value = c.slider.value;
    paintRange(c.slider);
  });
}

// ===== Run Analysis =====
document.getElementById('analyzeBtn').onclick = async () => {
  if (appMode === 'compare') { await runCompareAnalyze(); return; }

  statusEl.innerHTML = '<span class="spinner"></span> Processing Images...';
  analyzeBtn.disabled = true;

  // Fill in any "Auto" (armed) sliders before reading their values below.
  try {
    await applyAutoValues();
  } catch (err) {
    statusEl.style.color = '#f0616d';
    statusEl.textContent = `Auto failed: ${err.message}`;
    analyzeBtn.disabled = false;
    setTimeout(() => { statusEl.style.color = 'var(--muted)'; }, 3000);
    return;
  }

  // If Reference 2 was uploaded, run Reference vs Reference 2 (both OFF) first as
  // a noise baseline from the same time window as Test. Optional — failure here
  // doesn't block the real run below.
  let controlResult = null;
  if (ctrlRef2Input.files.length) {
    const fdCtrl = new FormData();
    fdCtrl.append('reference', refInput.files[0]);
    fdCtrl.append('test', ctrlRef2Input.files[0]);
    fdCtrl.append('colormap', document.getElementById('colormapSel').value);
    fdCtrl.append('gain', document.getElementById('gainSlider').value);
    fdCtrl.append('threshold', document.getElementById('threshSlider').value);
    fdCtrl.append('noise_floor', document.getElementById('floorSlider').value);
    fdCtrl.append('align', document.getElementById('alignToggle').checked ? 'true' : 'false');
    fdCtrl.append('denoise', document.getElementById('denoiseToggle').checked ? 'true' : 'false');
    fdCtrl.append('is_control', 'ON');
    fdCtrl.append('gas_type', 'None');
    fdCtrl.append('plasma_status', 'OFF');
    fdCtrl.append('CamType', document.getElementById('camType').value);
    fdCtrl.append('Focus', document.getElementById('focusSetting').value);
    fdCtrl.append('Iso', document.getElementById('iso').value);
    fdCtrl.append('Shutter', document.getElementById('shutter').value);
    fdCtrl.append('Aperture', document.getElementById('aperture').value);
    fdCtrl.append('NozDist', document.getElementById('nozDist').value);
    fdCtrl.append('Light', document.getElementById('lighting').value);
    fdCtrl.append('Notes', 'Noise baseline: Reference vs Reference 2, bracketing this run\'s Test shot');
    try {
      const resCtrl = await fetch('/analyze', { method: 'POST', body: fdCtrl });
      if (resCtrl.ok) {
        const dataCtrl = await resCtrl.json();
        // Keep the diff images too — coherent shape vs scattered noise is a visual
        // judgement the numbers alone can't make.
        controlResult = {
          runId: dataCtrl.run_id, stats: dataCtrl.stats,
          grayscale: dataCtrl.grayscale, color: dataCtrl.color,
        };
      }
    } catch (err) { /* non-fatal, proceed without a control comparison */ }
  }

  const fd = new FormData();
  fd.append('reference', refInput.files[0]);
  fd.append('test', testInput.files[0]);
  fd.append('colormap', document.getElementById('colormapSel').value);
  fd.append('gain', document.getElementById('gainSlider').value);
  fd.append('threshold', document.getElementById('threshSlider').value);
  fd.append('noise_floor', document.getElementById('floorSlider').value);
  fd.append('align', document.getElementById('alignToggle').checked ? 'true' : 'false');
  fd.append('denoise', document.getElementById('denoiseToggle').checked ? 'true' : 'false');

  const effectiveRoi = getEffectiveRoiForAnalyze();
  if (effectiveRoi) {
    fd.append('roi_x', effectiveRoi.x.toFixed(6));
    fd.append('roi_y', effectiveRoi.y.toFixed(6));
    fd.append('roi_w', effectiveRoi.w.toFixed(6));
    fd.append('roi_h', effectiveRoi.h.toFixed(6));
  }

  // Send whatever is currently drawn so the server logs it under this
  // run's run_id - the single commit point for both CSVs.
  if (multiRois.length) {
    fd.append('rois', JSON.stringify(multiRois.map(m => ({
      name: m.name, role: m.role,
      x: +m.x.toFixed(6), y: +m.y.toFixed(6), w: +m.w.toFixed(6), h: +m.h.toFixed(6),
    }))));
  }
  fd.append('is_control', 'OFF');

  // Forward the noise-baseline stats so the server can stamp them into this run's
  // image footer, not just the results table.
  if (controlResult && controlResult.stats) {
    fd.append('control_peak', controlResult.stats.peak);
    fd.append('control_mean', controlResult.stats.mean);
  }

  const logFields = {
    gas_type: document.getElementById('gasType').value,
    flow_rate: document.getElementById('flowRate').value,
    plasma_status: document.getElementById('plasmaStatus').value,
    plasma_condition: document.getElementById('plasmaCond').value,
    CamType: document.getElementById('camType').value,
    Focus: document.getElementById('focusSetting').value,
    Iso: document.getElementById('iso').value,
    Shutter: document.getElementById('shutter').value,
    Aperture: document.getElementById('aperture').value,
    NozDist: document.getElementById('nozDist').value,
    Light: document.getElementById('lighting').value,
    Notes: document.getElementById('notes').value
  };

  const displayFields = {
    cmap: document.getElementById('colormapSel').value,
    gain: document.getElementById('gainSlider').value,
    floor: document.getElementById('floorSlider').value,
    thresh: document.getElementById('threshSlider').value,
    align: document.getElementById('alignToggle').checked ? 'ON' : 'OFF',
    denoise: document.getElementById('denoiseToggle').checked ? 'ON' : 'OFF'
  };

  Object.entries(logFields).forEach(([key, val]) => fd.append(key, val));

  try {
    const res = await fetch('/analyze', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    currentAnalysisData = {
      runId: data.run_id,
      datetime: data.datetime,
      grayBase64: data.grayscale,
      colorBase64: data.color,
      rawBase64: data.raw,
      thresholdedBase64: data.thresholded,
      stats: data.stats,
      alignShift: data.align_shift,  // {dx, dy} if align was on, else null
      // Diff-region size before the footer band — ROI pixel math scales against
      // this, not the decoded <img> height. See getDiffPixelSize().
      imageW: data.image_width,
      imageH: data.image_height,
      rois: data.rois,       // /analyze_rois-shaped result, or null
      control: controlResult,  // {runId, stats} if Control Ref 1/2 were both uploaded, else null
      log: logFields,
      display: displayFields,
      refName: refInput.files[0].name,
      testName: testInput.files[0].name,
      roi: effectiveRoi ? { ...effectiveRoi } : null,
      // Frozen snapshot of what was drawn, so overlays and downloads always match
      // this run even if the user keeps editing boxes afterward.
      quickRoiBox: roiNorm ? { ...roiNorm } : null,
      compareRoiBoxes: multiRois.map(m => ({ name: m.name, role: m.role, x: m.x, y: m.y, w: m.w, h: m.h })),
      calibPxPerMm: calibPxPerMm,
    };

    document.getElementById('grayImg').src = `data:image/png;base64,${data.grayscale}`;
    document.getElementById('colorImg').src = `data:image/png;base64,${data.color}`;
    document.getElementById('colorCmapName').textContent = displayFields.cmap;
    refreshRoiBoxUI();
    resetMeasureState();

    const controlPanel = document.getElementById('controlResultPanel');
    if (controlResult && controlResult.grayscale) {
      document.getElementById('controlGrayImg').src = `data:image/png;base64,${controlResult.grayscale}`;
      document.getElementById('controlColorImg').src = `data:image/png;base64,${controlResult.color}`;
      controlPanel.style.display = 'flex';
    } else {
      controlPanel.style.display = 'none';
    }

    if (data.raw) document.getElementById('rawImg').src = `data:image/png;base64,${data.raw}`;
    if (data.thresholded) document.getElementById('threshImg').src = `data:image/png;base64,${data.thresholded}`;
    // New run - collapse the optional views back down until requested again.
    document.getElementById('rawBox').style.display = 'none';
    document.getElementById('threshBox').style.display = 'none';
    document.getElementById('showRawBtn').textContent = 'Show Raw';
    document.getElementById('showThreshBtn').textContent = 'Show Thresholded';

    // Signal ROI crop: collapsed each run (rebuilt lazily on click), and the
    // button shows only when there's a quick ROI or Signal region to crop to.
    document.getElementById('signalRoiBox').style.display = 'none';
    const signalRoiBtn = document.getElementById('showSignalRoiBtn');
    signalRoiBtn.textContent = 'Show Zoomed Signal ROI';
    signalRoiBtn.style.display = getSignalCropBox() ? '' : 'none';

    if (data.stats) {
      document.getElementById('statMax').textContent = data.stats.peak;
      document.getElementById('statMean').textContent = data.stats.mean;
      document.getElementById('statCoverage').textContent = data.stats.coverage + '%';
      const coverageLabel = effectiveRoi
        ? `Coverage in ROI (diff>${displayFields.thresh})`
        : `Coverage (diff>${displayFields.thresh})`;
      document.getElementById('statCoverageLabel').textContent = coverageLabel;
    }

    const roiBar = document.getElementById('roiActiveBar');
    if (effectiveRoi) {
      const wp = (effectiveRoi.w * 100).toFixed(1);
      const hp = (effectiveRoi.h * 100).toFixed(1);
      const source = roiNorm ? 'ROI active' : 'Stats scoped to your Signal regions';
      roiBar.textContent = `${source}: ${wp}% × ${hp}% of the image. Numbers come from inside that box. The images below stay full frame, use "Show ROI Box" to see where it sits.`;
      roiBar.style.display = 'block';
    } else {
      roiBar.style.display = 'none';
    }

    renderResultTable();

    const roiPanel = document.getElementById('roiResultPanel');
    if (data.rois) {
      fillRoiTable(data.rois, document.getElementById('roiTableBody'), document.getElementById('roiTableNote'));
      // Snapshot the ROI canvas at Analyze time so the result panel keeps showing
      // which region was which even after more drawing.
      document.getElementById('roiOverlayImg').src = roiCanvas.toDataURL('image/png');
      roiPanel.style.display = 'flex';
    } else {
      roiPanel.style.display = 'none';
    }

    statusEl.textContent = 'Analysis complete.';
    document.body.classList.add('results-mode');
    window.scrollTo({ top: 0, behavior: 'smooth' });

  } catch (err) {
    statusEl.style.color = '#f0616d';
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    analyzeBtn.disabled = false;
    setTimeout(() => { statusEl.style.color = 'var(--muted)'; }, 3000);
  }
};
