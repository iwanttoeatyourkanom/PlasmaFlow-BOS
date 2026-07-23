// Scale calibration: trace a known length on the reference to read sizes in mm.

// px/mm is measured in the reference image's own pixels — the same space the
// Measure tool reports lengths in — so it maps 1:1. All client-side.
const calibCanvas = document.getElementById('calibCanvas');
const calibCtx = calibCanvas.getContext('2d');
let calibImg = new Image();
let calibNat = { w: 0, h: 0 };
let calibLine = null;              // {x0,y0,x1,y1} normalized 0-1
let calibDragging = false;
let calibStart = { x: 0, y: 0 }, calibEnd = { x: 0, y: 0 };
const CALIB_KEY = 'bosScalePxPerMm';
const CALIB_COLOR = '#ef4444';

function loadRefToCalibCanvas(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      calibImg = img;
      calibNat = { w: img.naturalWidth, h: img.naturalHeight };
      const MAX_W = 420, MAX_H = 360;
      const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
      calibCanvas.width = Math.round(img.naturalWidth * scale);
      calibCanvas.height = Math.round(img.naturalHeight * scale);
      document.getElementById('calibPlaceholder').style.display = 'none';
      calibCanvas.classList.add('has-image');
      // Drop any line traced on the previous photo (the saved scale stays).
      calibLine = null;
      updateCalibInfo();
      drawCalibCanvas();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function calibPos(e) {
  const rect = calibCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width * calibCanvas.width,
    y: (e.clientY - rect.top) / rect.height * calibCanvas.height,
  };
}

function drawCalibCanvas() {
  calibCtx.clearRect(0, 0, calibCanvas.width, calibCanvas.height);
  if (calibImg.complete && calibImg.naturalWidth) {
    calibCtx.drawImage(calibImg, 0, 0, calibCanvas.width, calibCanvas.height);
  }
  let ln = null;
  if (calibDragging) ln = { x0: calibStart.x, y0: calibStart.y, x1: calibEnd.x, y1: calibEnd.y };
  else if (calibLine) ln = {
    x0: calibLine.x0 * calibCanvas.width, y0: calibLine.y0 * calibCanvas.height,
    x1: calibLine.x1 * calibCanvas.width, y1: calibLine.y1 * calibCanvas.height,
  };
  if (ln) {
    calibCtx.strokeStyle = CALIB_COLOR; calibCtx.lineWidth = 1.5;
    calibCtx.beginPath(); calibCtx.moveTo(ln.x0, ln.y0); calibCtx.lineTo(ln.x1, ln.y1); calibCtx.stroke();
    [[ln.x0, ln.y0], [ln.x1, ln.y1]].forEach(([hx, hy]) => {
      calibCtx.fillStyle = CALIB_COLOR; calibCtx.beginPath(); calibCtx.arc(hx, hy, 3, 0, Math.PI * 2); calibCtx.fill();
      calibCtx.fillStyle = '#0b0c0d'; calibCtx.beginPath(); calibCtx.arc(hx, hy, 1.2, 0, Math.PI * 2); calibCtx.fill();
    });
  }
}

let calibDownClient = { x: 0, y: 0 };
calibCanvas.addEventListener('mousedown', e => {
  e.preventDefault();
  if (!(calibImg.complete && calibImg.naturalWidth)) return;
  calibDownClient = { x: e.clientX, y: e.clientY };
  calibDragging = true; calibStart = calibPos(e); calibEnd = calibStart; calibLine = null; drawCalibCanvas();
});
// snapAxis (from measure.js) locks to horizontal/vertical near those angles —
// a ruler is nearly always shot straight.
calibCanvas.addEventListener('mousemove', e => { if (!calibDragging) return; calibEnd = snapAxis(calibStart, calibPos(e)); drawCalibCanvas(); });
// A tap (no real drag) opens the zoom view instead of leaving a stray dot.
calibCanvas.addEventListener('mouseup', e => {
  if (!calibDragging) return;
  calibEnd = snapAxis(calibStart, calibPos(e));
  const wasClick = Math.hypot(e.clientX - calibDownClient.x, e.clientY - calibDownClient.y) < 6;
  finalizeCalibLine();
  if (wasClick) openCanvasZoom('calibCanvas', 'Scale');
});
calibCanvas.addEventListener('mouseleave', () => { if (calibDragging) finalizeCalibLine(); });

function finalizeCalibLine() {
  calibDragging = false;
  const dx = calibEnd.x - calibStart.x, dy = calibEnd.y - calibStart.y;
  if (Math.hypot(dx, dy) < 5) {
    calibLine = null;
  } else {
    calibLine = {
      x0: clamp01(calibStart.x / calibCanvas.width), y0: clamp01(calibStart.y / calibCanvas.height),
      x1: clamp01(calibEnd.x / calibCanvas.width), y1: clamp01(calibEnd.y / calibCanvas.height),
    };
  }
  updateCalibInfo();
  drawCalibCanvas();
}

// Length of the drawn line in the reference image's own (natural) pixels.
function calibLinePx() {
  if (!calibLine || !calibNat.w) return 0;
  return Math.hypot((calibLine.x1 - calibLine.x0) * calibNat.w, (calibLine.y1 - calibLine.y0) * calibNat.h);
}

function updateCalibInfo() {
  const info = document.getElementById('calibInfo');
  const row = document.getElementById('calibEntryRow');
  if (calibLine) {
    info.textContent = `Line length: ${Math.round(calibLinePx())} px. Type its real length below.`;
    info.style.color = 'var(--text)';
    row.style.display = 'flex';
  } else {
    info.textContent = 'No line drawn. Drag along a known distance in the photo.';
    info.style.color = 'var(--muted)';
    row.style.display = 'none';
  }
}

function setCalibScale(pxPerMm, persist = true) {
  calibPxPerMm = pxPerMm;
  if (persist) { try { localStorage.setItem(CALIB_KEY, String(pxPerMm)); } catch {} }
  renderCalibState();
}

function clearCalibScale() {
  calibPxPerMm = null;
  calibLine = null;
  try { localStorage.removeItem(CALIB_KEY); } catch {}
  const mmEl = document.getElementById('calibMm'); if (mmEl) mmEl.value = '';
  updateCalibInfo();
  drawCalibCanvas();
  renderCalibState();
}

function renderCalibState() {
  const bar = document.getElementById('calibActiveBar');
  const clearBtn = document.getElementById('clearCalibBtn');
  if (calibPxPerMm) {
    bar.textContent = `Scale set: ${calibPxPerMm.toFixed(2)} px/mm. Line length and width now read in mm.`;
    bar.style.display = 'block';
    clearBtn.style.display = '';
  } else {
    bar.style.display = 'none';
    clearBtn.style.display = 'none';
  }
}

document.getElementById('calibApplyBtn').onclick = () => {
  const info = document.getElementById('calibInfo');
  const mm = parseFloat(document.getElementById('calibMm').value);
  const px = calibLinePx();
  if (!calibLine || !(mm > 0) || !(px > 0)) {
    info.textContent = 'Draw a line first, then type a length greater than 0.';
    info.style.color = 'var(--danger)';
    return;
  }
  setCalibScale(px / mm);
  info.textContent = `Scale set from a ${Math.round(px)} px line = ${mm} mm.`;
  info.style.color = 'var(--text)';
};
document.getElementById('clearCalibBtn').onclick = clearCalibScale;

(function loadCalibFromStorage() {
  let v = null;
  try { v = localStorage.getItem(CALIB_KEY); } catch {}
  const num = v == null ? NaN : parseFloat(v);
  if (num > 0) calibPxPerMm = num;
  renderCalibState();
})();
