// Full-resolution zoomed crop of the signal ROI.

// ===== Show Zoomed Signal ROI (full-resolution crop, no downscaling) =====
// Quick ROI wins; otherwise crop the union box of the Signal regions (same
// convention as getEffectiveRoiForAnalyze). Background regions never used here.
function getSignalCropBox() {
  const d = currentAnalysisData;
  if (!d || !d.runId) return null;
  if (d.quickRoiBox && !boxMatchesBackgroundRegion(d.quickRoiBox, d.compareRoiBoxes)) return d.quickRoiBox;
  const signal = (d.compareRoiBoxes || []).filter(m => m.role !== 'background');
  if (!signal.length) return null;
  const x0 = Math.min(...signal.map(m => m.x));
  const y0 = Math.min(...signal.map(m => m.y));
  const x1 = Math.max(...signal.map(m => m.x + m.w));
  const y1 = Math.max(...signal.map(m => m.y + m.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Crops from the full-res color diff (no downscale) — the point is to see detail
// too small to read in the full frame.
async function buildSignalRoiCropDataURL() {
  const d = currentAnalysisData;
  const box = getSignalCropBox();
  if (!d || !d.colorBase64 || !box || box.w <= 0 || box.h <= 0) return null;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `data:image/png;base64,${d.colorBase64}`;
  });

  // Crop against the diff-only size (not natural, which includes the footer), or a
  // box near the bottom would catch footer text instead of image.
  const diffSize = getDiffPixelSize(img.naturalWidth, img.naturalHeight);
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

let signalRoiCropRunId = null; // cache key so re-toggling doesn't rebuild every click

document.getElementById('showSignalRoiBtn').onclick = async () => {
  const box = document.getElementById('signalRoiBox');
  const btn = document.getElementById('showSignalRoiBtn');
  const visible = box.style.display !== 'none';
  if (visible) {
    box.style.display = 'none';
    btn.textContent = 'Show Zoomed Signal ROI';
    return;
  }
  if (signalRoiCropRunId !== currentAnalysisData.runId) {
    btn.textContent = 'Building...';
    btn.disabled = true;
    try {
      const dataUrl = await buildSignalRoiCropDataURL();
      if (!dataUrl) { btn.disabled = false; btn.textContent = 'Show Zoomed Signal ROI'; return; }
      document.getElementById('signalRoiImg').src = dataUrl;
      const isMulti = !currentAnalysisData.quickRoiBox &&
        (currentAnalysisData.compareRoiBoxes || []).filter(m => m.role !== 'background').length > 1;
      document.getElementById('signalRoiHint').textContent = isMulti ? '(union of all signal regions)' : '';
      signalRoiCropRunId = currentAnalysisData.runId;
    } finally {
      btn.disabled = false;
    }
  }
  box.style.display = 'flex';
  btn.textContent = 'Hide Zoomed ROI';
};

function renderMroiList() {
  clearAllRoiBtn.style.display = multiRois.length ? '' : 'none';
  if (!multiRois.length) {
    mroiListEl.innerHTML = '<div class="mroi-empty">No compare regions yet. Drag a box above to add one.</div>';
    return;
  }
  mroiListEl.innerHTML = '';
  multiRois.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'mroi-item';

    const sw = document.createElement('span');
    sw.className = 'mroi-swatch';
    sw.style.background = m.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR;

    const name = document.createElement('input');
    name.className = 'mroi-name';
    name.type = 'text';
    name.value = m.name;
    name.oninput = () => { m.name = name.value; drawROICanvas(); };

    const role = document.createElement('button');
    role.type = 'button';
    role.className = 'mroi-role ' + m.role;
    role.textContent = m.role === 'background' ? 'Background' : 'Signal';
    role.onclick = () => {
      m.role = m.role === 'background' ? 'signal' : 'background';
      renderMroiList();
      drawROICanvas();
    };

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mroi-del';
    del.innerHTML = '&times;';
    del.title = 'Remove region';
    del.onclick = () => { multiRois.splice(i, 1); renderMroiList(); drawROICanvas(); };

    item.append(sw, name, role, del);
    mroiListEl.appendChild(item);
  });
}

// Appends a just-drawn box as a new named Compare Region. Called automatically
// from finalizeROI() right when a drag completes -- no separate "Add" click.
function addRoiAsRegion(box) {
  multiRois.push({
    name: `Region ${multiRois.length + 1}`,
    role: 'signal',
    x: box.x, y: box.y, w: box.w, h: box.h,
  });
  renderMroiList();
  drawROICanvas();
}

// Fills a region-comparison table on a results page from an /analyze_rois-shaped
// payload (Single mode's own results.rois, echoed back from /analyze).
function fillRoiTable(data, tbodyEl, noteEl) {
  const rows = data.rois || [];
  const bg = data.background || {};
  const hasBg = bg.mean != null;
  const fmt = (v) => (v == null ? '-' : v);

  tbodyEl.innerHTML = rows.map(r => {
    const isBg = r.role === 'background';
    const roleTag = `<span class="role-tag ${isBg ? 'background' : 'signal'}">${isBg ? 'Background' : 'Signal'}</span>`;
    const nm = (r.name || '').replace(/</g, '&lt;');
    return `<tr class="${isBg ? 'is-bg' : ''}">` +
      `<td class="roi-name-cell">${nm}</td><td>${roleTag}</td>` +
      `<td>${r.mean}</td><td>${r.peak}</td><td>${r.std}</td><td>${r.coverage}%</td>` +
      `<td>${fmt(r.snr_mean)}</td></tr>`;
  }).join('');

  if (hasBg) {
    noteEl.textContent = `SNR (mean) = region mean ÷ background mean. ` +
      `Background: mean ${bg.mean}, std ${bg.std} (threshold ${data.threshold}). ` +
      `The background row itself reading ≈ 1 is normal.`;
  } else {
    noteEl.textContent = 'No region is marked Background, so the SNR column is blank. ' +
      'Mark one quiet region as Background to fill it in.';
  }
}

renderMroiList();       // show the empty-state hint on first load
