// Plasma On/Off compare: two Analyze passes on one reference, rendered side by side.

// ===== Compare Analyze (Plasma On/Off) =====
// Runs /analyze twice on one Reference (once per Test) with identical settings and
// the same ROI/regions, so OFF and ON are directly comparable — the point of the mode.
let currentCompareData = null;

async function runCompareAnalyze() {
  statusEl.innerHTML = '<span class="spinner"></span> Processing Images...';
  analyzeBtn.disabled = true;

  try {
    await applyAutoValues();
  } catch (err) {
    statusEl.style.color = '#f0616d';
    statusEl.textContent = `Auto failed: ${err.message}`;
    analyzeBtn.disabled = false;
    setTimeout(() => { statusEl.style.color = 'var(--muted)'; }, 3000);
    return;
  }

  const effectiveRoi = getEffectiveRoiForAnalyze();
  const roisPayload = multiRois.length ? JSON.stringify(multiRois.map(m => ({
    name: m.name, role: m.role,
    x: +m.x.toFixed(6), y: +m.y.toFixed(6), w: +m.w.toFixed(6), h: +m.h.toFixed(6),
  }))) : '';

  const sharedFields = {
    gas_type: document.getElementById('gasType').value,
    flow_rate: document.getElementById('flowRate').value,
    plasma_condition: document.getElementById('plasmaCond').value,
    CamType: document.getElementById('camType').value,
    Focus: document.getElementById('focusSetting').value,
    Iso: document.getElementById('iso').value,
    Shutter: document.getElementById('shutter').value,
    Aperture: document.getElementById('aperture').value,
    NozDist: document.getElementById('nozDist').value,
    Light: document.getElementById('lighting').value,
    Notes: document.getElementById('notes').value,
  };

  function buildFd(testFile, plasmaStatus) {
    const fd = new FormData();
    fd.append('reference', refInput.files[0]);
    fd.append('test', testFile);
    fd.append('colormap', document.getElementById('colormapSel').value);
    fd.append('gain', document.getElementById('gainSlider').value);
    fd.append('threshold', document.getElementById('threshSlider').value);
    fd.append('noise_floor', document.getElementById('floorSlider').value);
    fd.append('align', document.getElementById('alignToggle').checked ? 'true' : 'false');
    fd.append('denoise', document.getElementById('denoiseToggle').checked ? 'true' : 'false');
    if (effectiveRoi) {
      fd.append('roi_x', effectiveRoi.x.toFixed(6));
      fd.append('roi_y', effectiveRoi.y.toFixed(6));
      fd.append('roi_w', effectiveRoi.w.toFixed(6));
      fd.append('roi_h', effectiveRoi.h.toFixed(6));
    }
    if (roisPayload) fd.append('rois', roisPayload);
    fd.append('is_control', 'OFF');
    fd.append('plasma_status', plasmaStatus);
    Object.entries(sharedFields).forEach(([key, val]) => fd.append(key, val));
    return fd;
  }

  // Optional off/off baseline (Reference vs Reference 2), same shared ROI/settings
  // as the OFF/ON runs. Only sent if Reference 2 was uploaded.
  function buildCtrlFd() {
    const fd = new FormData();
    fd.append('reference', refInput.files[0]);
    fd.append('test', ctrlRef2Input.files[0]);
    fd.append('colormap', document.getElementById('colormapSel').value);
    fd.append('gain', document.getElementById('gainSlider').value);
    fd.append('threshold', document.getElementById('threshSlider').value);
    fd.append('noise_floor', document.getElementById('floorSlider').value);
    fd.append('align', document.getElementById('alignToggle').checked ? 'true' : 'false');
    fd.append('denoise', document.getElementById('denoiseToggle').checked ? 'true' : 'false');
    if (effectiveRoi) {
      fd.append('roi_x', effectiveRoi.x.toFixed(6));
      fd.append('roi_y', effectiveRoi.y.toFixed(6));
      fd.append('roi_w', effectiveRoi.w.toFixed(6));
      fd.append('roi_h', effectiveRoi.h.toFixed(6));
    }
    if (roisPayload) fd.append('rois', roisPayload);
    fd.append('is_control', 'ON');
    fd.append('gas_type', 'None');
    fd.append('plasma_status', 'OFF');
    fd.append('CamType', document.getElementById('camType').value);
    fd.append('Focus', document.getElementById('focusSetting').value);
    fd.append('Iso', document.getElementById('iso').value);
    fd.append('Shutter', document.getElementById('shutter').value);
    fd.append('Aperture', document.getElementById('aperture').value);
    fd.append('NozDist', document.getElementById('nozDist').value);
    fd.append('Light', document.getElementById('lighting').value);
    fd.append('Notes', 'Noise baseline: Reference vs Reference 2, bracketing this Compare run');
    return fd;
  }

  try {
    // Sequential, not Promise.all: the server handles each /analyze synchronously,
    // and this lets an OFF error short-circuit before ON is sent. (run_id is now
    // microsecond-resolution, so the old anti-collision delay between calls is gone.)
    let controlResult = null;
    if (ctrlRef2Input.files.length) {
      try {
        const resCtrl = await fetch('/analyze', { method: 'POST', body: buildCtrlFd() });
        if (resCtrl.ok) {
          const dataCtrl = await resCtrl.json();
          controlResult = {
            runId: dataCtrl.run_id, stats: dataCtrl.stats,
            grayscale: dataCtrl.grayscale, color: dataCtrl.color,
          };
        }
      } catch (err) { /* non-fatal, proceed without a control comparison */ }
    }

    const resOff = await fetch('/analyze', { method: 'POST', body: buildFd(testInput.files[0], 'OFF') });
    if (!resOff.ok) throw new Error(`Plasma OFF run failed: server error ${resOff.status}`);
    const dataOff = await resOff.json();

    const resOn = await fetch('/analyze', { method: 'POST', body: buildFd(testOnInput.files[0], 'ON') });
    if (!resOn.ok) throw new Error(`Plasma ON run failed: server error ${resOn.status}`);
    const dataOn = await resOn.json();

    await renderCompareResults(dataOff, dataOn, effectiveRoi, controlResult);

    statusEl.textContent = 'Comparison complete.';
    document.body.classList.add('compare-results-mode');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    statusEl.style.color = '#f0616d';
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    analyzeBtn.disabled = false;
    setTimeout(() => { statusEl.style.color = 'var(--muted)'; }, 3000);
  }
}

function fmtRatio(onVal, offVal) {
  if (typeof offVal !== 'number' || typeof onVal !== 'number' || offVal === 0) return '-';
  return (onVal / offVal).toFixed(2) + '×';
}

// Boxes (regions + quick ROI) from the compare snapshot — the compare-mode twin
// of currentRoiBoxes().
function currentCompareRoiBoxes() {
  const d = currentCompareData;
  if (!d) return [];
  const boxes = [];
  if (d.quickRoiBox) boxes.push({ ...d.quickRoiBox, color: '#ffffff', label: 'ROI' });
  (d.compareRoiBoxes || []).forEach(m => {
    boxes.push({ ...m, color: m.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR, label: m.name });
  });
  return boxes;
}

// One box-overlaid diff per run (OFF, ON), built once and reused by both the
// on-screen Region Comparison and the ZIP so they stay identical.
async function buildCompareRoiOverlayDataURLs() {
  const d = currentCompareData;
  if (!d) return { off: null, on: null };
  const boxes = currentCompareRoiBoxes();
  if (!boxes.length) return { off: null, on: null };

  async function loadImg(base64) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject;
      img.src = `data:image/png;base64,${base64}`;
    });
    return img;
  }

  async function buildOne(run) {
    const img = await loadImg(run.color);
    const MAX_W = 900;
    const diffSize = { w: run.image_width || img.naturalWidth, h: run.image_height || img.naturalHeight };
    const scale = Math.min(1, MAX_W / diffSize.w);
    const w = Math.round(diffSize.w * scale);
    const h = Math.round(diffSize.h * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0c0d';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, diffSize.w, diffSize.h, 0, 0, w, h);

    boxes.forEach(b => {
      const bx = b.x * w, by = b.y * h, bw = b.w * w, bh = b.h * h;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(b.label).width;
      ctx.fillStyle = b.color;
      ctx.fillRect(bx, Math.max(0, by - 16), tw + 8, 16);
      ctx.fillStyle = '#0b0c0d';
      ctx.fillText(b.label, bx + 4, Math.max(11, by - 4));
    });

    return canvas.toDataURL('image/png');
  }

  const [off, on] = await Promise.all([buildOne(d.off), buildOne(d.on)]);
  return { off, on };
}

// ===== Compare mode: ROI box overlay toggle on the main Output Images =====
// Compare-mode twin of renderRoiBoxOverlays: a DOM overlay on all four images.
let compareRoiBoxOverlayVisible = false;

function renderCompareRoiBoxOverlays() {
  const d = currentCompareData;
  if (!d) return;
  const boxes = currentCompareRoiBoxes();
  const diffOff = { w: d.off.image_width, h: d.off.image_height };
  const diffOn = { w: d.on.image_width, h: d.on.image_height };
  drawRoiBoxLayer(document.getElementById('compareOffImg'), document.getElementById('compareOffRoiLayer'), boxes, diffOff);
  drawRoiBoxLayer(document.getElementById('compareOnImg'), document.getElementById('compareOnRoiLayer'), boxes, diffOn);
  drawRoiBoxLayer(document.getElementById('compareOffGrayImg'), document.getElementById('compareOffGrayRoiLayer'), boxes, diffOff);
  drawRoiBoxLayer(document.getElementById('compareOnGrayImg'), document.getElementById('compareOnGrayRoiLayer'), boxes, diffOn);
}

// Called after every fresh Compare Analyze: shows/hides the toggle button
// depending on whether there's anything to overlay, resets to hidden so each
// new comparison starts from the same full-image view.
function refreshCompareRoiBoxUI() {
  const boxes = currentCompareRoiBoxes();
  const btn = document.getElementById('toggleCompareRoiBoxBtn');
  btn.style.display = boxes.length ? '' : 'none';
  compareRoiBoxOverlayVisible = false;
  btn.textContent = 'Show ROI Box';
  ['compareOffRoiLayer', 'compareOnRoiLayer', 'compareOffGrayRoiLayer', 'compareOnGrayRoiLayer'].forEach(id => {
    document.getElementById(id).classList.remove('visible');
  });
}

document.getElementById('toggleCompareRoiBoxBtn').onclick = () => {
  compareRoiBoxOverlayVisible = !compareRoiBoxOverlayVisible;
  document.getElementById('toggleCompareRoiBoxBtn').textContent = compareRoiBoxOverlayVisible ? 'Hide ROI Box' : 'Show ROI Box';
  ['compareOffRoiLayer', 'compareOnRoiLayer', 'compareOffGrayRoiLayer', 'compareOnGrayRoiLayer'].forEach(id => {
    document.getElementById(id).classList.toggle('visible', compareRoiBoxOverlayVisible);
  });
  if (compareRoiBoxOverlayVisible) renderCompareRoiBoxOverlays();
};

window.addEventListener('resize', debounce(() => {
  if (compareRoiBoxOverlayVisible) renderCompareRoiBoxOverlays();
}, 150));

// ===== Compare mode: Show Raw / Show Thresholded =====
document.getElementById('showCompareRawBtn').onclick = () => toggleImageBox('compareRawBox', 'showCompareRawBtn', 'Show Raw', 'Hide Raw');
document.getElementById('showCompareThreshBtn').onclick = () => toggleImageBox('compareThreshBox', 'showCompareThreshBtn', 'Show Thresholded', 'Hide Thresholded');

// ===== Compare mode: Show Zoomed Signal ROI =====
// Same union-of-signal-regions convention as Single mode's getSignalCropBox(),
// read from the snapshot frozen on currentCompareData at render time.
function getCompareSignalCropBox() {
  const d = currentCompareData;
  if (!d) return null;
  if (d.quickRoiBox && !boxMatchesBackgroundRegion(d.quickRoiBox, d.compareRoiBoxes)) return d.quickRoiBox;
  const signal = (d.compareRoiBoxes || []).filter(m => m.role !== 'background');
  if (!signal.length) return null;
  const x0 = Math.min(...signal.map(m => m.x));
  const y0 = Math.min(...signal.map(m => m.y));
  const x1 = Math.max(...signal.map(m => m.x + m.w));
  const y1 = Math.max(...signal.map(m => m.y + m.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Crops directly from the full-resolution color diff (no downscale), one per
// run, both cropped to the same shared box so they're directly comparable.
async function buildCompareSignalCropDataURLs() {
  const d = currentCompareData;
  const box = getCompareSignalCropBox();
  if (!d || !box || box.w <= 0 || box.h <= 0) return { off: null, on: null };

  async function loadImg(base64) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject;
      img.src = `data:image/png;base64,${base64}`;
    });
    return img;
  }

  async function cropOne(run) {
    const img = await loadImg(run.color);
    const diffSize = { w: run.image_width || img.naturalWidth, h: run.image_height || img.naturalHeight };
    const sx = Math.max(0, Math.min(Math.round(box.x * diffSize.w), diffSize.w - 1));
    const sy = Math.max(0, Math.min(Math.round(box.y * diffSize.h), diffSize.h - 1));
    const sw = Math.max(1, Math.min(Math.round(box.w * diffSize.w), diffSize.w - sx));
    const sh = Math.max(1, Math.min(Math.round(box.h * diffSize.h), diffSize.h - sy));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL('image/png');
  }

  const [off, on] = await Promise.all([cropOne(d.off), cropOne(d.on)]);
  return { off, on };
}

let compareSignalRoiCropRunId = null; // cache key so re-toggling doesn't rebuild every click

document.getElementById('showCompareSignalRoiBtn').onclick = async () => {
  const box = document.getElementById('compareSignalRoiBox');
  const btn = document.getElementById('showCompareSignalRoiBtn');
  const visible = box.style.display !== 'none';
  if (visible) {
    box.style.display = 'none';
    btn.textContent = 'Show Zoomed Signal ROI';
    return;
  }
  const cacheKey = currentCompareData ? `${currentCompareData.off.run_id}_${currentCompareData.on.run_id}` : null;
  if (compareSignalRoiCropRunId !== cacheKey) {
    btn.textContent = 'Building...';
    btn.disabled = true;
    try {
      const crops = await buildCompareSignalCropDataURLs();
      if (!crops.off && !crops.on) { btn.disabled = false; btn.textContent = 'Show Zoomed Signal ROI'; return; }
      document.getElementById('compareOffSignalRoiImg').src = crops.off || '';
      document.getElementById('compareOnSignalRoiImg').src = crops.on || '';
      compareSignalRoiCropRunId = cacheKey;
    } finally {
      btn.disabled = false;
    }
  }
  box.style.display = 'flex';
  btn.textContent = 'Hide Zoomed ROI';
};

async function renderCompareResults(dataOff, dataOn, effectiveRoi, controlResult) {
  currentCompareData = {
    off: dataOff, on: dataOn, roi: effectiveRoi, control: controlResult,
    // Frozen snapshot of what was drawn, so overlays match this run even if boxes
    // are edited afterward.
    quickRoiBox: roiNorm ? { ...roiNorm } : null,
    compareRoiBoxes: multiRois.map(m => ({ name: m.name, role: m.role, x: m.x, y: m.y, w: m.w, h: m.h })),
    calibPxPerMm: calibPxPerMm,
    roiOverlayOffDataUrl: null,
    roiOverlayOnDataUrl: null,
  };

  document.getElementById('compareOffImg').src = `data:image/png;base64,${dataOff.color}`;
  document.getElementById('compareOnImg').src = `data:image/png;base64,${dataOn.color}`;
  document.getElementById('compareOffGrayImg').src = `data:image/png;base64,${dataOff.grayscale}`;
  document.getElementById('compareOnGrayImg').src = `data:image/png;base64,${dataOn.grayscale}`;
  refreshCompareRoiBoxUI();

  if (dataOff.raw) document.getElementById('compareOffRawImg').src = `data:image/png;base64,${dataOff.raw}`;
  if (dataOn.raw) document.getElementById('compareOnRawImg').src = `data:image/png;base64,${dataOn.raw}`;
  if (dataOff.thresholded) document.getElementById('compareOffThreshImg').src = `data:image/png;base64,${dataOff.thresholded}`;
  if (dataOn.thresholded) document.getElementById('compareOnThreshImg').src = `data:image/png;base64,${dataOn.thresholded}`;
  // New comparison -- collapse the optional views back down until requested again.
  document.getElementById('compareRawBox').style.display = 'none';
  document.getElementById('compareThreshBox').style.display = 'none';
  document.getElementById('showCompareRawBtn').textContent = 'Show Raw';
  document.getElementById('showCompareThreshBtn').textContent = 'Show Thresholded';

  document.getElementById('compareSignalRoiBox').style.display = 'none';
  const compareSignalRoiBtn = document.getElementById('showCompareSignalRoiBtn');
  compareSignalRoiBtn.textContent = 'Show Zoomed Signal ROI';
  compareSignalRoiBtn.style.display = getCompareSignalCropBox() ? '' : 'none';
  compareSignalRoiCropRunId = null;

  const controlPanel = document.getElementById('compareControlPanel');
  if (controlResult && controlResult.grayscale) {
    document.getElementById('compareControlGrayImg').src = `data:image/png;base64,${controlResult.grayscale}`;
    document.getElementById('compareControlColorImg').src = `data:image/png;base64,${controlResult.color}`;
    controlPanel.style.display = 'flex';
  } else {
    controlPanel.style.display = 'none';
  }

  const roiPanel = document.getElementById('compareRoiPanel');
  const wholePanel = document.getElementById('compareWholePanel');
  const roiOff = dataOff.rois && dataOff.rois.rois;
  const roiOn = dataOn.rois && dataOn.rois.rois;

  if (roiOff && roiOn && roiOff.length) {
    // Built once and reused by the ZIP; fall back to the live canvas if a build fails.
    const overlays = await buildCompareRoiOverlayDataURLs();
    currentCompareData.roiOverlayOffDataUrl = overlays.off;
    currentCompareData.roiOverlayOnDataUrl = overlays.on;
    document.getElementById('compareRoiOverlayOffImg').src = overlays.off || roiCanvas.toDataURL('image/png');
    document.getElementById('compareRoiOverlayOnImg').src = overlays.on || roiCanvas.toDataURL('image/png');
    const tbody = document.getElementById('compareRoiTableBody');
    tbody.innerHTML = '';
    roiOff.forEach((rOff, i) => {
      const rOn = roiOn[i] || {};
      const tr = document.createElement('tr');
      if (rOff.role === 'background') tr.classList.add('is-bg');
      tr.innerHTML = `
            <td class="roi-name-cell">${esc(rOff.name)}</td>
            <td><span class="role-tag ${rOff.role === 'background' ? 'background' : 'signal'}">${esc(rOff.role)}</span></td>
            <td class="grp-start">${rOff.mean}</td><td>${rOn.mean ?? '-'}</td><td>${fmtRatio(rOn.mean, rOff.mean)}</td>
            <td class="grp-start">${rOff.peak}</td><td>${rOn.peak ?? '-'}</td><td>${fmtRatio(rOn.peak, rOff.peak)}</td>
            <td class="grp-start">${rOff.coverage}%</td><td>${rOn.coverage ?? '-'}%</td><td>${fmtRatio(rOn.coverage, rOff.coverage)}</td>
            <td class="grp-start">${rOff.snr_mean ?? '-'}</td><td>${rOn.snr_mean ?? '-'}</td><td>${fmtRatio(rOn.snr_mean, rOff.snr_mean)}</td>
          `;
      tbody.appendChild(tr);
    });
    roiPanel.style.display = 'flex';
    wholePanel.style.display = 'none';
  } else {
    roiPanel.style.display = 'none';
    const tbody = document.getElementById('compareWholeTableBody');
    const sOff = dataOff.stats || {}, sOn = dataOn.stats || {};
    tbody.innerHTML = `
          <tr><td>Peak (p99)</td><td>${sOff.peak}</td><td>${sOn.peak}</td><td>${fmtRatio(sOn.peak, sOff.peak)}</td></tr>
          <tr><td>Mean</td><td>${sOff.mean}</td><td>${sOn.mean}</td><td>${fmtRatio(sOn.mean, sOff.mean)}</td></tr>
          <tr><td>Coverage %</td><td>${sOff.coverage}%</td><td>${sOn.coverage}%</td><td>${fmtRatio(sOn.coverage, sOff.coverage)}</td></tr>
        `;
    wholePanel.style.display = 'flex';
  }

}

document.getElementById('compareBackBtn').onclick = () => {
  document.body.classList.remove('compare-results-mode');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Side-by-side composite (OFF | ON diffs + the comparison table) as one shareable PNG.
async function buildCompareSummaryDataURL() {
  const d = currentCompareData;
  if (!d) return null;

  async function loadImg(base64) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject;
      img.src = `data:image/png;base64,${base64}`;
    });
    return img;
  }
  const [imgOff, imgOn] = await Promise.all([loadImg(d.off.color), loadImg(d.on.color)]);

  const MAX_COL_W = 900;
  const diffOff = { w: d.off.image_width || imgOff.naturalWidth, h: d.off.image_height || imgOff.naturalHeight };
  const diffOn = { w: d.on.image_width || imgOn.naturalWidth, h: d.on.image_height || imgOn.naturalHeight };
  const scale = Math.min(1, MAX_COL_W / Math.max(diffOff.w, diffOn.w));
  const colW = Math.round(Math.max(diffOff.w, diffOn.w) * scale);
  const colHOff = Math.round(diffOff.h * scale);
  const colHOn = Math.round(diffOn.h * scale);
  const imgH = Math.max(colHOff, colHOn);
  const gap = 16, labelH = 30;

  const regions = (d.off.rois && d.off.rois.rois) || [];
  const regionsOn = (d.on.rois && d.on.rois.rois) || [];
  const cols = regions.length
    ? ['Region', 'Role', 'Mean OFF', 'Mean ON', 'Mean ON/OFF', 'Peak OFF', 'Peak ON', 'Peak ON/OFF', 'Cov OFF', 'Cov ON', 'Cov ON/OFF', 'SNR OFF', 'SNR ON', 'SNR ON/OFF']
    : ['Metric', 'OFF', 'ON', 'ON/OFF'];
  const rowH = 24, headerH = 26;
  const tableRows = regions.length ? regions.length : 3;
  const tableH = headerH + rowH * tableRows + 14;

  const canvas = document.createElement('canvas');
  canvas.width = colW * 2 + gap;
  canvas.height = labelH + imgH + tableH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0c0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = '700 15px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#9ea3aa';
  ctx.fillText('PLASMA OFF', 4, 20);
  ctx.fillStyle = MROI_SIGNAL_COLOR;
  ctx.fillText('PLASMA ON', colW + gap + 4, 20);

  ctx.drawImage(imgOff, 0, 0, diffOff.w, diffOff.h, 0, labelH, colW, colHOff);
  ctx.drawImage(imgOn, 0, 0, diffOn.w, diffOn.h, colW + gap, labelH, colW, colHOn);

  // Draw the region/ROI boxes on both diffs — this composite is downloadable, so
  // it should show what was measured.
  const summaryBoxes = currentCompareRoiBoxes();
  const drawSummaryBoxes = (offsetX, w, h) => {
    summaryBoxes.forEach(b => {
      const bx = offsetX + b.x * w, by = labelH + b.y * h, bw = b.w * w, bh = b.h * h;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(b.label).width;
      ctx.fillStyle = b.color;
      ctx.fillRect(bx, Math.max(labelH, by - 16), tw + 8, 16);
      ctx.fillStyle = '#0b0c0d';
      ctx.fillText(b.label, bx + 4, Math.max(labelH + 11, by - 4));
    });
  };
  drawSummaryBoxes(0, colW, colHOff);
  drawSummaryBoxes(colW + gap, colW, colHOn);

  let y = labelH + imgH;
  const colWidth = canvas.width / cols.length;
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, y, canvas.width, tableH);
  ctx.font = '700 13px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#ffffff';
  cols.forEach((c, i) => ctx.fillText(c, i * colWidth + 8, y + 20));
  y += headerH;
  ctx.font = '13px "IBM Plex Mono", monospace';

  if (regions.length) {
    regions.forEach((r, i) => {
      const rOn = regionsOn[i] || {};
      if (i % 2 === 1) { ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, y, canvas.width, rowH); }
      ctx.fillStyle = r.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR;
      const vals = [
        r.name, r.role,
        r.mean, rOn.mean ?? '-', fmtRatio(rOn.mean, r.mean),
        r.peak, rOn.peak ?? '-', fmtRatio(rOn.peak, r.peak),
        r.coverage, rOn.coverage ?? '-', fmtRatio(rOn.coverage, r.coverage),
        r.snr_mean ?? '-', rOn.snr_mean ?? '-', fmtRatio(rOn.snr_mean, r.snr_mean),
      ];
      vals.forEach((v, ci) => ctx.fillText(String(v), ci * colWidth + 8, y + 17));
      y += rowH;
    });
  } else {
    const sOff = d.off.stats || {}, sOn = d.on.stats || {};
    const rows = [
      ['Peak (p99)', sOff.peak, sOn.peak],
      ['Mean', sOff.mean, sOn.mean],
      ['Coverage %', `${sOff.coverage}%`, `${sOn.coverage}%`],
    ];
    rows.forEach(([label, off, on], i) => {
      if (i % 2 === 1) { ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, y, canvas.width, rowH); }
      ctx.fillStyle = '#ffffff';
      const vals = [label, off, on, fmtRatio(typeof on === 'number' ? on : parseFloat(on), typeof off === 'number' ? off : parseFloat(off))];
      vals.forEach((v, ci) => ctx.fillText(String(v), ci * colWidth + 8, y + 17));
      y += rowH;
    });
  }

  return canvas.toDataURL('image/png');
}

document.getElementById('dlCompareBtn').onclick = async () => {
  if (!currentCompareData) return;
  const btn = document.getElementById('dlCompareBtn');
  const original = btn.textContent;
  btn.textContent = 'Building...';
  btn.disabled = true;
  try {
    const dataUrl = await buildCompareSummaryDataURL();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `plasma_compare_${currentCompareData.off.run_id}_${currentCompareData.on.run_id}.png`;
    a.click();
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
};
