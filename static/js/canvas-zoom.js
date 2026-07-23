// Fullscreen zoom-to-draw modal (ROI + Scale) and the Measure wizard's two steps.

// The real canvas is reparented into the modal (not cloned), so its existing
// drag listeners keep working; it's moved back on close.
let canvasZoomHome = null; // { canvas, parent, nextSibling }
// Same idea for a Measure card's .img-wrap (img + overlay layers) — see openMeasureZoom().
let measureZoomHome = null; // { wrap, parent, nextSibling, imgId, layerId, slotKey }
// Measure is a 2-step wizard: 'scale' (px/mm on the reference) then 'measure'
// (draw on the color diff). null outside that flow.
let wizardStep = null;
// calibInfo + calibEntryRow get reparented alongside calibCanvas in the scale step.
let calibExtraHome = null; // { info, infoParent, infoNext, entry, entryParent, entryNext }
// CSS max-width/height can only shrink the canvas, never grow a small one to fill
// the modal, so the fitted display size is computed and set in JS.
function fitZoomedCanvas() {
  if (!canvasZoomHome) return;
  const canvas = canvasZoomHome.canvas;
  const body = document.getElementById('canvasZoomBody');
  const pad = 2 * 21; // matches .canvas-zoom-body padding (1.3rem ~= 21px) each side
  const availW = Math.max(50, body.clientWidth - pad);
  const availH = Math.max(50, body.clientHeight - pad);
  const scale = Math.min(availW / canvas.width, availH / canvas.height);
  canvas.style.width = Math.round(canvas.width * scale) + 'px';
  canvas.style.height = Math.round(canvas.height * scale) + 'px';
}
function openCanvasZoom(canvasId, title) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.classList.contains('has-image')) return;
  canvasZoomHome = { canvas, parent: canvas.parentElement, nextSibling: canvas.nextElementSibling };
  document.getElementById('canvasZoomTitle').textContent = title || 'Draw';
  document.getElementById('canvasZoomUndo').style.display = 'none'; // single box/line here -- Clear already covers it
  document.getElementById('canvasZoomBody').appendChild(canvas);
  document.getElementById('canvasZoomModal').classList.add('open');
  requestAnimationFrame(fitZoomedCanvas);
}
// keepOpen tears down the current content but leaves the modal open — used by the
// wizard's "Next" to swap the scale step for the drawing step in one session.
function closeCanvasZoom(keepOpen) {
  const modal = document.getElementById('canvasZoomModal');
  if (!modal.classList.contains('open')) return;
  if (!keepOpen) modal.classList.remove('open');
  if (canvasZoomHome) {
    const { canvas, parent, nextSibling } = canvasZoomHome;
    canvas.style.width = '';
    canvas.style.height = '';
    parent.insertBefore(canvas, nextSibling);
    canvasZoomHome = null;
  }
  if (measureZoomHome) {
    const { wrap, parent, nextSibling, layerId } = measureZoomHome;
    document.getElementById(layerId).classList.remove('active');
    parent.insertBefore(wrap, nextSibling);
    measureZoomHome = null;
    // Back at the small size -- every overlay sized against clientWidth/
    // clientHeight needs to be redrawn now that the image shrank back down.
    requestAnimationFrame(() => {
      measureSlots().forEach(s => renderMeasureLayer(document.getElementById(s.imgId), document.getElementById(s.layerId), measureLines[s.key]));
      if (roiBoxOverlayVisible) renderRoiBoxOverlays();
    });
  }
  if (calibExtraHome) {
    const { bar, barParent, barNext, info, infoParent, infoNext, entry, entryParent, entryNext } = calibExtraHome;
    // info's saved nextSibling is entry, so entry must be reinserted first or
    // info's insertBefore hits a not-yet-child reference node (NotFoundError).
    entryParent.insertBefore(entry, entryNext);
    infoParent.insertBefore(info, infoNext);
    barParent.insertBefore(bar, barNext);
    document.getElementById('canvasZoomFoot').style.display = 'none';
    calibExtraHome = null;
  }
  if (!keepOpen) {
    wizardStep = null;
    document.getElementById('canvasZoomClear').textContent = 'Clear';
    document.getElementById('canvasZoomDone').textContent = 'Done';
    document.getElementById('canvasZoomUndo').style.display = 'none';
  }
}

// ===== Measure wizard: step 1, set scale on the reference photo =====
function openScaleStep() {
  wizardStep = 'scale';
  const bar = document.getElementById('calibActiveBar');
  const info = document.getElementById('calibInfo');
  const entry = document.getElementById('calibEntryRow');
  calibExtraHome = { bar, barParent: bar.parentElement, barNext: bar.nextElementSibling,
                      info, infoParent: info.parentElement, infoNext: info.nextElementSibling,
                      entry, entryParent: entry.parentElement, entryNext: entry.nextElementSibling };
  const foot = document.getElementById('canvasZoomFoot');
  foot.appendChild(bar);
  foot.appendChild(info);
  foot.appendChild(entry);
  foot.style.display = 'flex';
  document.getElementById('canvasZoomDone').textContent = 'Next →';
  // If the reference somehow isn't loaded into calibCanvas, skip to measuring.
  const canvas = document.getElementById('calibCanvas');
  if (!canvas.classList.contains('has-image')) {
    closeCanvasZoom(true);
    goToMeasureStep();
    return;
  }
  openCanvasZoom('calibCanvas', 'Set Scale — drag a known length on the reference photo, optional');
}

// ===== Measure wizard: step 2, draw the measurement on the color diff =====
function goToMeasureStep() {
  wizardStep = 'measure';
  document.getElementById('canvasZoomClear').textContent = 'Clear';
  document.getElementById('canvasZoomDone').textContent = 'Done';
  openMeasureZoom('colorImg', 'colorMeasureLayer', 'color');
}
window.addEventListener('resize', () => {
  if (canvasZoomHome) fitZoomedCanvas();
  if (measureZoomHome) refreshZoomedMeasureOverlay();
});
document.querySelectorAll('.canvas-zoom-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openCanvasZoom(btn.dataset.target, btn.dataset.title);
  });
});
// Arrow-wrapped so the referenced functions only need to exist at click time.
const CANVAS_CLEAR_FNS = {
  // Clear means "wipe this card": drop the quick box AND its Compare Region copy.
  roiCanvas: () => { clearROI(); clearAllMultiRois(); },
  calibCanvas: () => clearCalibScale(),
};
document.getElementById('canvasZoomUndo').addEventListener('click', e => {
  e.stopPropagation();
  if (!measureZoomHome || !measureLines[measureZoomHome.slotKey].length) return;
  // gray/color mirror the same lines, so pop from both to keep them in sync.
  measureLines.gray = measureLines.gray.slice(0, -1);
  measureLines.color = measureLines.color.slice(0, -1);
  measureSlots().forEach(s => renderMeasureLayer(document.getElementById(s.imgId), document.getElementById(s.layerId), measureLines[s.key]));
});
document.getElementById('canvasZoomClear').addEventListener('click', e => {
  e.stopPropagation();
  const fn = canvasZoomHome && CANVAS_CLEAR_FNS[canvasZoomHome.canvas.id];
  if (fn) fn();
  if (measureZoomHome) {
    // Clear both mirrored copies so no stray line survives on the other.
    measureLines.gray = [];
    measureLines.color = [];
    measureSlots().forEach(s => renderMeasureLayer(document.getElementById(s.imgId), document.getElementById(s.layerId), []));
  }
});
document.getElementById('canvasZoomDone').addEventListener('click', () => {
  if (wizardStep === 'scale') {
    // "Next": go to the drawing step. Scale is optional — skip it and Measure
    // just reads in px.
    closeCanvasZoom(true);
    goToMeasureStep();
    return;
  }
  closeCanvasZoom();
});
document.getElementById('canvasZoomModal').addEventListener('click', () => closeCanvasZoom());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCanvasZoom();
});
