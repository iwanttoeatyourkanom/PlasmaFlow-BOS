// Measure tool: draw length lines on the diff images; baked into downloads.

// ===== Measure tool (single-analysis Grayscale/Color images) =====
// A ruler: drag as many lines as you want, each showing its length (mm with a
// Scale, else px). Unlike the ROI overlay, these get baked into downloads
// (bakeMeasureIntoDataURL) so the measurement travels with the image.
const MEASURE_COLOR = '#ffd166';
const MEASURE_LABEL_COLOR = '#ffffff'; // deliberately different from the line -- the label sits centered on the line, so same color made it unreadable
let measureLines = { gray: [], color: [] }; // arrays of {x0,y0,x1,y1} normalized 0-1, fractions of the diff-only region

function measureSlots() {
  return [
    { key: 'gray', imgId: 'grayImg', layerId: 'grayMeasureLayer' },
    { key: 'color', imgId: 'colorImg', layerId: 'colorMeasureLayer' },
  ];
}

function normToPx(imgEl, n) {
  const rect = containRect(imgEl.clientWidth, imgEl.clientHeight, imgEl.naturalWidth, imgEl.naturalHeight);
  const ds = getDiffPixelSize(imgEl.naturalWidth, imgEl.naturalHeight);
  const scaleY = ds.h / imgEl.naturalHeight;
  return { x: rect.x + n.x * rect.w, y: rect.y + (n.y * scaleY) * rect.h };
}
function pxToNorm(imgEl, p) {
  const rect = containRect(imgEl.clientWidth, imgEl.clientHeight, imgEl.naturalWidth, imgEl.naturalHeight);
  const ds = getDiffPixelSize(imgEl.naturalWidth, imgEl.naturalHeight);
  const scaleY = ds.h / imgEl.naturalHeight;
  return {
    x: clamp01((p.x - rect.x) / rect.w),
    y: clamp01(((p.y - rect.y) / rect.h) / scaleY),
  };
}
// Physical length in the diff-resolution image (same pixel space the server's
// own peak/mean/coverage numbers are computed in).
function measureLengthPx(imgEl, norm) {
  const ds = getDiffPixelSize(imgEl.naturalWidth, imgEl.naturalHeight);
  return Math.hypot((norm.x1 - norm.x0) * ds.w, (norm.y1 - norm.y0) * ds.h);
}

// `lines` is an array of {x0,y0,x1,y1} normalized lines -- draws all of them.
function renderMeasureLayer(imgEl, layerEl, lines) {
  const cw = imgEl.clientWidth, ch = imgEl.clientHeight;
  layerEl.style.width = cw + 'px';
  layerEl.style.height = ch + 'px';
  if (!lines || !lines.length || !imgEl.naturalWidth) { layerEl.innerHTML = ''; return; }
  const parts = lines.map(norm => {
    const p0 = normToPx(imgEl, { x: norm.x0, y: norm.y0 });
    const p1 = normToPx(imgEl, { x: norm.x1, y: norm.y1 });
    const label = fmtLen(Math.round(measureLengthPx(imgEl, norm)));
    const midX = (p0.x + p1.x) / 2, midY = (p0.y + p1.y) / 2;
    return `
          <line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" stroke="${MEASURE_COLOR}" stroke-width="1.5" />
          <circle cx="${p0.x}" cy="${p0.y}" r="3" fill="${MEASURE_COLOR}" />
          <circle cx="${p1.x}" cy="${p1.y}" r="3" fill="${MEASURE_COLOR}" />
          <text x="${midX}" y="${midY - 8}" fill="${MEASURE_LABEL_COLOR}" font-size="11"
                font-family="'IBM Plex Mono',monospace" font-weight="400" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  layerEl.innerHTML = `<svg viewBox="0 0 ${cw} ${ch}">${parts}</svg>`;
}

// Measure opens the color diff full-size in the shared zoom modal (the thumbnail
// is too tight to draw on). Reparents the .img-wrap, same trick as the canvases.
function refreshZoomedMeasureOverlay() {
  if (!measureZoomHome) return;
  const { imgId, layerId, slotKey } = measureZoomHome;
  renderMeasureLayer(document.getElementById(imgId), document.getElementById(layerId), measureLines[slotKey]);
  if (roiBoxOverlayVisible) renderRoiBoxOverlays();
}

function openMeasureZoom(imgId, layerId, slotKey) {
  const imgEl = document.getElementById(imgId);
  if (!imgEl || !imgEl.src) return;
  const wrap = imgEl.closest('.img-wrap');
  if (!wrap) return;
  measureZoomHome = { wrap, parent: wrap.parentElement, nextSibling: wrap.nextElementSibling, imgId, layerId, slotKey };
  // .active enables pointer-events on the zoomed layer only.
  document.getElementById(layerId).classList.add('active');
  document.getElementById('canvasZoomTitle').textContent = 'Measure';
  document.getElementById('canvasZoomUndo').style.display = '';
  document.getElementById('canvasZoomBody').appendChild(wrap);
  document.getElementById('canvasZoomModal').classList.add('open');
  requestAnimationFrame(refreshZoomedMeasureOverlay);
}

// Snap a drag to horizontal/vertical within ~6deg. Recomputed every move (not
// latched), so pulling away from the axis releases the snap. Screen-pixel space.
const AXIS_SNAP_RAD = 6 * Math.PI / 180;
function snapAxis(startPx, curPx) {
  const dx = curPx.x - startPx.x, dy = curPx.y - startPx.y;
  if (!dx && !dy) return curPx;
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx)); // 0 = horizontal, PI/2 = vertical
  if (angle < AXIS_SNAP_RAD) return { x: curPx.x, y: startPx.y };
  if (Math.PI / 2 - angle < AXIS_SNAP_RAD) return { x: startPx.x, y: curPx.y };
  return curPx;
}

function setupMeasureLayer(imgId, layerId, slotKey) {
  const imgEl = document.getElementById(imgId);
  const layerEl = document.getElementById(layerId);
  let dragging = false, startNorm = null, startPx = null;
  const getPt = e => {
    const r = layerEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // Only ever receives pointer events while zoomed (see the .active class
  // above), so no separate "is measure mode on" check is needed here. Each
  // drag adds one more line to measureLines[slotKey] rather than replacing
  // it -- draw as many as you want, Clear wipes all of them at once.
  layerEl.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    startPx = getPt(e);
    startNorm = pxToNorm(imgEl, startPx);
    const preview = { x0: startNorm.x, y0: startNorm.y, x1: startNorm.x, y1: startNorm.y };
    renderMeasureLayer(imgEl, layerEl, [...measureLines[slotKey], preview]);
  });
  layerEl.addEventListener('mousemove', e => {
    if (!dragging) return;
    const n = pxToNorm(imgEl, snapAxis(startPx, getPt(e)));
    const preview = { x0: startNorm.x, y0: startNorm.y, x1: n.x, y1: n.y };
    renderMeasureLayer(imgEl, layerEl, [...measureLines[slotKey], preview]);
  });
  window.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const n = pxToNorm(imgEl, snapAxis(startPx, getPt(e)));
    const norm = { x0: startNorm.x, y0: startNorm.y, x1: n.x, y1: n.y };
    if (measureLengthPx(imgEl, norm) < 3) {
      // Too short to be deliberate -- drop the preview, keep what's committed.
      renderMeasureLayer(imgEl, layerEl, measureLines[slotKey]);
      return;
    }
    measureLines[slotKey] = [...measureLines[slotKey], norm];
    renderMeasureLayer(imgEl, layerEl, measureLines[slotKey]);
    // Mirror onto the other diff (same pixel space) so one set of lines shows on both.
    const other = measureSlots().find(s => s.key !== slotKey);
    measureLines[other.key] = measureLines[slotKey].map(l => ({ ...l }));
    renderMeasureLayer(document.getElementById(other.imgId), document.getElementById(other.layerId), measureLines[other.key]);
  });
}
measureSlots().forEach(s => setupMeasureLayer(s.imgId, s.layerId, s.key));

// Fresh Analyze run -> old measurements no longer match the new image geometry.
function resetMeasureState() {
  measureLines = { gray: [], color: [] };
  measureSlots().forEach(s => renderMeasureLayer(document.getElementById(s.imgId), document.getElementById(s.layerId), []));
}

document.getElementById('measureToggleBtn').onclick = () => openScaleStep();

window.addEventListener('resize', debounce(() => {
  measureSlots().forEach(s => renderMeasureLayer(document.getElementById(s.imgId), document.getElementById(s.layerId), measureLines[s.key]));
}, 150));

// Draw the image + all measured lines onto an offscreen canvas at full res, so
// the lines travel with the exported PNG instead of staying a DOM overlay.
function bakeMeasureIntoDataURL(imgEl, lines) {
  const canvas = document.createElement('canvas');
  canvas.width = imgEl.naturalWidth;
  canvas.height = imgEl.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0);
  const ds = getDiffPixelSize(imgEl.naturalWidth, imgEl.naturalHeight);
  const lw = Math.max(2, Math.round(ds.w / 500));
  const r = Math.max(3, Math.round(ds.w / 300));
  const fontSize = Math.max(13, Math.round(ds.w / 100));
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  lines.forEach(norm => {
    const x0 = norm.x0 * ds.w, y0 = norm.y0 * ds.h;
    const x1 = norm.x1 * ds.w, y1 = norm.y1 * ds.h;
    const label = fmtLen(Math.round(Math.hypot(x1 - x0, y1 - y0)));
    ctx.strokeStyle = MEASURE_COLOR;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    [[x0, y0], [x1, y1]].forEach(([cx, cy]) => {
      ctx.fillStyle = MEASURE_COLOR;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    });
    const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
    ctx.font = `400 ${fontSize}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = MEASURE_LABEL_COLOR;
    ctx.fillText(label, midX, midY - r - 6);
  });
  return canvas.toDataURL('image/png');
}

// One PNG combining the color diff, the ROI box(es), and the SNR table (if any) —
// shared by the ZIP and the "Download ROI Summary" button so they match. Returns
// null when there's nothing to summarize.
async function buildRoiSummaryDataURL() {
  const d = currentAnalysisData;
  if (!d || !d.colorBase64) return null;
  const boxes = currentRoiBoxes();
  const regions = (d.rois && d.rois.rois) || [];
  if (!boxes.length && !regions.length) return null;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `data:image/png;base64,${d.colorBase64}`;
  });

  // Cap the base image width for a reasonable file size.
  const MAX_W = 1600;
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const imgW = Math.round(img.naturalWidth * scale);
  // Draw only the diff portion (crop out the server's footer band — this composite
  // has its own table below).
  const diffSize = getDiffPixelSize(img.naturalWidth, img.naturalHeight);
  const imgH = Math.round(diffSize.h * scale);

  const cols = ['Region', 'Role', 'Mean', 'Peak', 'Std', 'Cov %', 'SNR(mean)'];
  const rowH = 26, headerH = 30;
  const tableH = regions.length ? headerH + rowH * regions.length + 14
    : (boxes.length ? 40 : 0);
  const colW = imgW / cols.length;

  const canvas = document.createElement('canvas');
  canvas.width = imgW;
  canvas.height = imgH + tableH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0c0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, img.naturalWidth, diffSize.h, 0, 0, imgW, imgH);

  // The canvas holds only the diff region (footer cropped), so boxes map directly.
  boxes.forEach(b => {
    const bx = b.x * imgW, by = b.y * imgH, bw = b.w * imgW, bh = b.h * imgH;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(b.label).width;
    ctx.fillStyle = b.color;
    ctx.fillRect(bx, Math.max(0, by - 18), tw + 10, 18);
    ctx.fillStyle = '#0b0c0d';
    ctx.fillText(b.label, bx + 5, Math.max(13, by - 5));
  });

  if (regions.length) {
    let y = imgH;
    ctx.fillStyle = '#15171a';
    ctx.fillRect(0, y, imgW, tableH);
    ctx.font = '700 13px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#ffffff';
    cols.forEach((c, i) => ctx.fillText(c, i * colW + 8, y + 20));
    y += headerH;
    ctx.font = '13px "IBM Plex Mono", monospace';
    regions.forEach((r, i) => {
      if (i % 2 === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, y, imgW, rowH);
      }
      ctx.fillStyle = r.role === 'background' ? MROI_BG_COLOR : MROI_SIGNAL_COLOR;
      const vals = [
        r.name, r.role, r.mean, r.peak, r.std, r.coverage,
        r.snr_mean == null ? '-' : r.snr_mean,
      ];
      vals.forEach((v, ci) => ctx.fillText(String(v), ci * colW + 8, y + 18));
      y += rowH;
    });
  } else if (boxes.length && d.stats) {
    const y = imgH;
    ctx.fillStyle = '#15171a';
    ctx.fillRect(0, y, imgW, tableH);
    ctx.font = '13px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      `ROI   Peak: ${d.stats.peak}   Mean: ${d.stats.mean}   Coverage: ${d.stats.coverage}%`,
      10, y + tableH / 2 + 5,
    );
  }

  return canvas.toDataURL('image/png');
}

document.getElementById('dlRoiSummaryBtn').onclick = async () => {
  const btn = document.getElementById('dlRoiSummaryBtn');
  const original = btn.textContent;
  btn.textContent = 'Building...';
  btn.disabled = true;
  try {
    const dataUrl = await buildRoiSummaryDataURL();
    if (!dataUrl) {
      alert('No ROI box or Compare Regions data to summarize for this run.');
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `roi_summary_${currentAnalysisData.runId || 'run'}.png`;
    a.click();
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
};
