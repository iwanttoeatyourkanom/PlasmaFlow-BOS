// Raw/Thresholded toggles, the ROI-selection canvas, and the shared diff preview.

// ===== Raw / Thresholded views (hidden until requested, own download) =====
function toggleImageBox(boxId, btnId, showLabel, hideLabel) {
  const box = document.getElementById(boxId);
  const btn = document.getElementById(btnId);
  const visible = box.style.display !== 'none';
  box.style.display = visible ? 'none' : 'flex';
  btn.textContent = visible ? showLabel : hideLabel;
}
document.getElementById('showRawBtn').onclick = () => toggleImageBox('rawBox', 'showRawBtn', 'Show Raw', 'Hide Raw');
document.getElementById('showThreshBtn').onclick = () => toggleImageBox('threshBox', 'showThreshBtn', 'Show Thresholded', 'Hide Thresholded');

function downloadSingleImage(imgId, filename) {
  const img = document.getElementById(imgId);
  if (!img || !img.src) return;
  const slot = { grayImg: 'gray', colorImg: 'color' }[imgId];
  const lines = slot && typeof measureLines !== 'undefined' && measureLines[slot];
  const href = (lines && lines.length) ? bakeMeasureIntoDataURL(img, lines) : img.src;
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

// ===== ROI Selection =====
const roiCanvas = document.getElementById('roiCanvas');
const roiCtx = roiCanvas.getContext('2d');
let roiImageEl = new Image();      // the contrast-stretched diff preview from /diff_preview
const setRoiBgStatus = msg => { document.getElementById('roiBgStatus').textContent = msg || ''; };
let roiDragging = false;
let roiStart = { x: 0, y: 0 };
let roiEnd = { x: 0, y: 0 };
let roiActive = false;
let roiNorm = null; // {x, y, w, h} all normalized 0-1
let roiRatio = null; // locked width/height, or null for freeform

// Named multi-ROI (drives /analyze_rois; independent of the single ROI above)
const MROI_SIGNAL_COLOR = '#7cc4ff';
const MROI_BG_COLOR = '#e0a05a';
let multiRois = []; // [{name, role, x, y, w, h}] normalized 0-1
// The Compare Region that finalizeROI() auto-added for the current quick ROI,
// tracked so clearROI() can drop that exact copy too.
let lastAutoRoi = null;

const clamp01 = v => Math.max(0, Math.min(1, v));

function getROICanvasPos(e) {
  const rect = roiCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width * roiCanvas.width,
    y: (e.clientY - rect.top) / rect.height * roiCanvas.height
  };
}

// Build the selection rectangle from the drag, enforcing the locked aspect
// ratio (if any) and clamping it inside the canvas.
function getROIRect() {
  const dx = roiEnd.x - roiStart.x;
  const dy = roiEnd.y - roiStart.y;
  let w = Math.abs(dx);
  let h = Math.abs(dy);
  if (roiRatio) {
    w = Math.max(w, h * roiRatio);
    h = w / roiRatio;
  }
  let x = dx < 0 ? roiStart.x - w : roiStart.x;
  let y = dy < 0 ? roiStart.y - h : roiStart.y;

  const cw = roiCanvas.width, ch = roiCanvas.height;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > cw) w = cw - x;
  if (y + h > ch) h = ch - y;
  // Re-fit to the ratio after clamping, shrinking to the limiting side.
  if (roiRatio && w > 0 && h > 0) {
    if (w / h > roiRatio) w = h * roiRatio;
    else h = w / roiRatio;
  }
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function drawROICanvas() {
  roiCtx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
  if (roiImageEl.complete && roiImageEl.naturalWidth) {
    roiCtx.drawImage(roiImageEl, 0, 0, roiCanvas.width, roiCanvas.height);
  }
  // Committed named ROIs (drawn under the active drag box) with a name label.
  multiRois.forEach(m => {
    const x = m.x * roiCanvas.width, y = m.y * roiCanvas.height;
    const w = m.w * roiCanvas.width, h = m.h * roiCanvas.height;
    const col = m.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR;
    roiCtx.setLineDash([]);
    roiCtx.strokeStyle = col;
    roiCtx.lineWidth = 2;
    roiCtx.strokeRect(x, y, w, h);
    roiCtx.font = '600 13px "IBM Plex Mono", monospace';
    roiCtx.textBaseline = 'middle';
    const tw = roiCtx.measureText(m.name).width;
    roiCtx.fillStyle = col;
    roiCtx.fillRect(x, y, tw + 12, 18);
    roiCtx.fillStyle = '#0b0c0d';
    roiCtx.fillText(m.name, x + 6, y + 10);
  });
  if (roiActive || roiDragging) {
    const r = getROIRect();
    if (r.w > 0 && r.h > 0) {
      roiCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      roiCtx.fillRect(r.x, r.y, r.w, r.h);
      roiCtx.strokeStyle = '#ffffff';
      roiCtx.lineWidth = 2;
      roiCtx.setLineDash([6, 3]);
      roiCtx.strokeRect(r.x, r.y, r.w, r.h);
      roiCtx.setLineDash([]);
    }
  }
}

function updateROIInfo() {
  const infoEl = document.getElementById('roiInfo');
  const clearBtn = document.getElementById('clearRoiBtn');
  if (roiNorm) {
    const xp = (roiNorm.x * 100).toFixed(1);
    const yp = (roiNorm.y * 100).toFixed(1);
    const wp = (roiNorm.w * 100).toFixed(1);
    const hp = (roiNorm.h * 100).toFixed(1);
    infoEl.textContent = `Selected: ${wp}% × ${hp}% of image, from (${xp}%, ${yp}%)`;
    infoEl.style.color = 'var(--text)';
    clearBtn.style.display = '';
    roiCanvas.classList.add('has-roi');
  } else {
    infoEl.textContent = 'No box drawn. The whole image is used.';
    infoEl.style.color = 'var(--muted)';
    clearBtn.style.display = 'none';
    roiCanvas.classList.remove('has-roi');
  }
}

function clearROI() {
  roiActive = false;
  roiDragging = false;
  roiStart = { x: 0, y: 0 };
  roiEnd = { x: 0, y: 0 };
  roiNorm = null;
  // Drop the Compare Region copy this exact box auto-added too, or it just
  // keeps rendering (drawROICanvas draws multiRois independently of roiNorm).
  if (lastAutoRoi) {
    const idx = multiRois.indexOf(lastAutoRoi);
    if (idx !== -1) { multiRois.splice(idx, 1); renderMroiList(); }
    lastAutoRoi = null;
  }
  updateROIInfo();
  drawROICanvas();
}

// Commit the current rectangle as the active ROI (shared by drag-release
// and aspect-ratio changes).
function commitROI() {
  const r = getROIRect();
  if (r.w < 5 || r.h < 5) {
    clearROI();
    return;
  }
  roiActive = true;
  roiNorm = {
    x: r.x / roiCanvas.width,
    y: r.y / roiCanvas.height,
    w: r.w / roiCanvas.width,
    h: r.h / roiCanvas.height
  };
  updateROIInfo();
  drawROICanvas();
}

function finalizeROI() {
  roiDragging = false;
  commitROI();
  // Every drag also becomes a Compare Region (no separate "Add" step), so an
  // SNR comparison builds up as you draw. roiNorm still scopes the main stats.
  if (roiNorm) {
    addRoiAsRegion(roiNorm);
    lastAutoRoi = multiRois[multiRois.length - 1];
  }
}

// Drop a default centered box (~70% of the image) so the user sees a frame
// immediately when picking a ratio, then can drag to adjust.
function placeDefaultROI() {
  if (!roiImageEl.naturalWidth) return;
  const cw = roiCanvas.width, ch = roiCanvas.height;
  let w = cw * 0.7;
  let h = roiRatio ? w / roiRatio : ch * 0.7;
  if (h > ch * 0.7) { h = ch * 0.7; w = roiRatio ? h * roiRatio : cw * 0.7; }
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;
  roiStart = { x, y };
  roiEnd = { x: x + w, y: y + h };
  commitROI();
}

document.querySelectorAll('.roi-ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.roi-ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const v = btn.dataset.ratio;
    roiRatio = v === 'free' ? null : (() => { const [a, b2] = v.split(':').map(Number); return a / b2; })();

    if (roiActive) {
      commitROI();              // re-fit the existing box to the new ratio
    } else if (v !== 'free') {
      placeDefaultROI();        // show a starter box so the frame is visible
    }
  });
});

let roiDownClient = { x: 0, y: 0 };
roiCanvas.addEventListener('mousedown', e => {
  e.preventDefault();
  const pos = getROICanvasPos(e);
  roiDownClient = { x: e.clientX, y: e.clientY };
  roiDragging = true;
  roiActive = false;
  roiNorm = null;
  roiStart = pos;
  roiEnd = pos;
  updateROIInfo();
});

roiCanvas.addEventListener('mousemove', e => {
  if (!roiDragging) return;
  roiEnd = getROICanvasPos(e);
  drawROICanvas();
});

// A tap (no real drag) opens the zoom view instead of leaving a sliver box.
roiCanvas.addEventListener('mouseup', e => {
  if (!roiDragging) return;
  roiEnd = getROICanvasPos(e);
  const wasClick = Math.hypot(e.clientX - roiDownClient.x, e.clientY - roiDownClient.y) < 6;
  finalizeROI();
  if (wasClick) openCanvasZoom('roiCanvas', 'ROI Selection');
});

roiCanvas.addEventListener('mouseleave', () => {
  if (roiDragging) finalizeROI();
});

let roiDiffFetching = false;
let roiDiffPending = false;  // ref/test changed again while a fetch was already in flight
async function fetchDiffPreview() {
  // If a fetch is already running, don't drop this one — flag it and re-run
  // when the current one settles, so the canvas matches the latest files.
  if (roiDiffFetching) { roiDiffPending = true; return; }
  if (!(refInput.files.length && testInput.files.length)) {
    setRoiBgStatus('Upload both Reference and Test first.');
    return;
  }
  roiDiffFetching = true;
  roiDiffPending = false;
  const roiPh = document.getElementById('roiPlaceholder');
  roiPh.innerHTML = '<span class="spinner"></span>&nbsp; Building difference preview… large photos (e.g. DSLR, 6000px+) can take several seconds.';
  setRoiBgStatus('Building difference preview…');
  const fd = new FormData();
  fd.append('reference', refInput.files[0]);
  fd.append('test', testInput.files[0]);
  try {
    const res = await fetch('/diff_preview', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error (${res.status})`);
    }
    const data = await res.json();
    await loadDiffPreviewToROICanvas('data:image/png;base64,' + data.preview);
    setRoiBgStatus('');
  } catch (err) {
    roiPh.textContent = 'Diff preview failed: ' + err.message;
    roiPh.style.display = '';
    setRoiBgStatus('Diff preview failed: ' + err.message);
  } finally {
    roiDiffFetching = false;
    if (roiDiffPending) {
      roiDiffPending = false;
      fetchDiffPreview();
    }
  }
}

// Format a pixel length as mm when a scale is set, else px. One place so every
// readout flips to mm together the moment a scale is entered.
function fmtLen(px) {
  if (px == null) return '-';
  if (calibPxPerMm) return `${(px / calibPxPerMm).toFixed(2)} mm`;
  return `${px} px`;
}

// Escape user text (region names, roles) before putting it in innerHTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

document.getElementById('clearRoiBtn').onclick = e => {
  e.stopPropagation();
  clearROI();
};

// A new image keeps the normalized roiNorm valid; only the pixel-space
// roiStart/roiEnd (the overlay box) need recomputing for the new canvas size.
function reapplyRoiToNewCanvas() {
  roiStart = { x: roiNorm.x * roiCanvas.width, y: roiNorm.y * roiCanvas.height };
  roiEnd = { x: (roiNorm.x + roiNorm.w) * roiCanvas.width, y: (roiNorm.y + roiNorm.h) * roiCanvas.height };
  roiActive = true;
  roiDragging = false;
  updateROIInfo();
  drawROICanvas();
}

// Load the contrast-stretched diff preview as the ROI drawing background,
// so the jet is visible while placing a box.
function loadDiffPreviewToROICanvas(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      roiImageEl = img;
      const MAX_W = 1200;
      const scale = Math.min(1, MAX_W / img.naturalWidth);
      roiCanvas.width = Math.round(img.naturalWidth * scale);
      roiCanvas.height = Math.round(img.naturalHeight * scale);
      document.getElementById('roiPlaceholder').style.display = 'none';
      roiCanvas.classList.add('has-image');
      // Keep a previously-drawn Quick ROI (see reapplyRoiToNewCanvas) instead
      // of wiping it on every new test image. Only fall back to a fresh
      // default box (or an empty canvas) if nothing was drawn before.
      if (roiNorm) reapplyRoiToNewCanvas();
      else if (roiRatio) placeDefaultROI();
      else drawROICanvas();
      resolve();
    };
    img.onerror = resolve;
    img.src = src;
  });
}

// Reset the ROI canvas back to its placeholder when images are missing.
function resetRoiCanvas() {
  roiImageEl = new Image();
  roiCanvas.classList.remove('has-image');
  document.getElementById('roiPlaceholder').style.display = '';
  clearROI();
}
