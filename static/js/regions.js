// Named signal/background regions (SNR) and their overlays on the result images.

// ===== Compare regions (per-region stats + SNR via /analyze_rois) =====
const clearAllRoiBtn = document.getElementById('clearAllRoiBtn');
const mroiListEl = document.getElementById('mroiList');

// Drops every named region (signal + background) at once.
function clearAllMultiRois() {
  if (!multiRois.length) return;
  multiRois = [];
  renderMroiList();
  drawROICanvas();
}
clearAllRoiBtn.onclick = clearAllMultiRois;

// roiNorm and its auto-added region share coordinates but are stored separately,
// so tagging the region "Background" doesn't touch roiNorm. Match by coords
// (regions are never repositioned after creation, so this stays reliable).
function roiNormMatchesBackgroundRegion() {
  if (!roiNorm) return false;
  return multiRois.some(m => m.role === 'background'
    && Math.abs(m.x - roiNorm.x) < 1e-6 && Math.abs(m.y - roiNorm.y) < 1e-6
    && Math.abs(m.w - roiNorm.w) < 1e-6 && Math.abs(m.h - roiNorm.h) < 1e-6);
}

// Same check, but against a frozen post-Analyze snapshot instead of live state.
function boxMatchesBackgroundRegion(box, regions) {
  if (!box || !regions) return false;
  return regions.some(m => m.role === 'background'
    && Math.abs(m.x - box.x) < 1e-6 && Math.abs(m.y - box.y) < 1e-6
    && Math.abs(m.w - box.w) < 1e-6 && Math.abs(m.h - box.h) < 1e-6);
}

// Which box the run's stats scope to: the quick ROI wins, unless it's absent or
// tagged Background (now a noise reference) — then fall back to the bounding box
// of the Signal regions rather than silently reverting to the full frame.
function getEffectiveRoiForAnalyze() {
  if (roiNorm && !roiNormMatchesBackgroundRegion()) return roiNorm;
  const signalRois = multiRois.filter(m => m.role !== 'background');
  if (!signalRois.length) return null;
  const x0 = Math.min(...signalRois.map(m => m.x));
  const y0 = Math.min(...signalRois.map(m => m.y));
  const x1 = Math.max(...signalRois.map(m => m.x + m.w));
  const y1 = Math.max(...signalRois.map(m => m.y + m.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ===== ROI box overlay on the main result images =====
// A toggle-able DOM overlay (not baked into the PNG), so the images stay full-frame
// while showing which box the stats used. Reads the snapshot frozen at Analyze time,
// not live state, so it matches the actual run even if you keep editing boxes.
let roiBoxOverlayVisible = false;

function currentRoiBoxes() {
  const d = currentAnalysisData;
  if (!d || !d.runId) return [];
  const boxes = [];
  if (d.quickRoiBox) {
    boxes.push({ ...d.quickRoiBox, color: '#ffffff', label: 'ROI' });
  }
  (d.compareRoiBoxes || []).forEach(m => {
    boxes.push({ ...m, color: m.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR, label: m.name });
  });
  return boxes;
}

// object-fit:contain math: the rendered image is letterboxed inside the <img> box,
// so overlays need the real content rect or they drift off the pixels they mark.
function containRect(containerW, containerH, imgW, imgH) {
  if (!imgW || !imgH) return { w: containerW, h: containerH, x: 0, y: 0 };
  const containerRatio = containerW / containerH;
  const imgRatio = imgW / imgH;
  let w, h;
  if (imgRatio > containerRatio) {
    w = containerW;
    h = containerW / imgRatio;
  } else {
    h = containerH;
    w = containerH * imgRatio;
  }
  return { w, h, x: (containerW - w) / 2, y: (containerH - h) / 2 };
}

// The served PNG is taller than the diff region (the server stamps a footer band
// below it), and normalized ROI coords are fractions of the diff region, not the
// whole PNG. Return that region's size; fall back to natural size for old runs.
function getDiffPixelSize(imgNaturalW, imgNaturalH) {
  const d = currentAnalysisData;
  return {
    w: (d && d.imageW) || imgNaturalW,
    h: (d && d.imageH) || imgNaturalH,
  };
}

// diffSize is optional: Single mode falls back to currentAnalysisData, while
// Compare passes each run's own size (OFF and ON differ).
function drawRoiBoxLayer(imgEl, layerEl, boxes, diffSize) {
  layerEl.innerHTML = '';
  if (!imgEl.naturalWidth || !boxes.length) return;
  const cw = imgEl.clientWidth, ch = imgEl.clientHeight;
  layerEl.style.width = cw + 'px';
  layerEl.style.height = ch + 'px';
  const rect = containRect(cw, ch, imgEl.naturalWidth, imgEl.naturalHeight);
  // Rescale y/h for the footer band (x/w unaffected — the footer only adds height).
  const ds = diffSize || getDiffPixelSize(imgEl.naturalWidth, imgEl.naturalHeight);
  const scaleY = ds.h / imgEl.naturalHeight;
  boxes.forEach(b => {
    const el = document.createElement('div');
    el.className = 'roi-box-item';
    el.style.left = (rect.x + b.x * rect.w) + 'px';
    el.style.top = (rect.y + (b.y * scaleY) * rect.h) + 'px';
    el.style.width = (b.w * rect.w) + 'px';
    el.style.height = (b.h * scaleY * rect.h) + 'px';
    el.style.borderColor = b.color;
    const label = document.createElement('span');
    label.className = 'roi-box-label';
    label.textContent = b.label;
    label.style.background = b.color;
    el.appendChild(label);
    layerEl.appendChild(el);
  });
}

function renderRoiBoxOverlays() {
  const boxes = currentRoiBoxes();
  drawRoiBoxLayer(document.getElementById('grayImg'), document.getElementById('grayRoiLayer'), boxes);
  drawRoiBoxLayer(document.getElementById('colorImg'), document.getElementById('colorRoiLayer'), boxes);
}

// After each Analyze: show the toggle only if there's a box, and reset to hidden.
function refreshRoiBoxUI() {
  const boxes = currentRoiBoxes();
  const btn = document.getElementById('toggleRoiBoxBtn');
  btn.style.display = boxes.length ? '' : 'none';
  roiBoxOverlayVisible = false;
  btn.textContent = 'Show ROI Box';
  document.getElementById('grayRoiLayer').classList.remove('visible');
  document.getElementById('colorRoiLayer').classList.remove('visible');
}

document.getElementById('toggleRoiBoxBtn').onclick = () => {
  roiBoxOverlayVisible = !roiBoxOverlayVisible;
  document.getElementById('toggleRoiBoxBtn').textContent = roiBoxOverlayVisible ? 'Hide ROI Box' : 'Show ROI Box';
  document.getElementById('grayRoiLayer').classList.toggle('visible', roiBoxOverlayVisible);
  document.getElementById('colorRoiLayer').classList.toggle('visible', roiBoxOverlayVisible);
  if (roiBoxOverlayVisible) renderRoiBoxOverlays();
};

window.addEventListener('resize', debounce(() => {
  if (roiBoxOverlayVisible) renderRoiBoxOverlays();
}, 150));
