/*
 * Frontend regression tests for PlasmaFlow-BOS (static/index.html).
 *
 * Loads the real page in a headless DOM, checks it initialises with no errors,
 * exercises the interactive wiring (mode toggle, guide tabs, sliders, collapsible
 * cards, keyboard shortcut), and drives the result-render path with mock backend
 * responses (including an XSS-escaping check).
 *
 * Run from the project root:
 *     npm install jsdom        # one time
 *     node tests/frontend_test.js
 *
 * If jsdom is not installed the suite skips cleanly (exit 0).
 */
'use strict';
const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('SKIP: jsdom not installed. Run `npm install jsdom` to enable frontend tests.');
  process.exit(0);
}

const HTML = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

function makeDom() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail || e)));
  const store = {};
  const mockCtx = () => {
    const noop = () => {};
    return new Proxy({ measureText: () => ({ width: 10 }), canvas: { width: 1000, height: 360 } },
      { get: (t, p) => (p in t ? t[p] : noop), set: () => true });
  };
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = () => mockCtx();
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
      window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 });
      window.alert = () => {};
      window.scrollTo = () => {};
      window.fetch = () => Promise.reject(new Error('no network in tests'));
      window.Image = class { set src(v) { this._s = v; if (this.onload) setTimeout(() => this.onload(), 0); } get src() { return this._s; } get complete() { return true; } get naturalWidth() { return 320; } get naturalHeight() { return 240; } };
      Object.defineProperty(window, 'localStorage', {
        value: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      });
    },
  });
  return { dom, errors, store };
}

(async () => {
  const { dom, errors, store } = makeDom();
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const input = el => el.dispatchEvent(new w.Event('input', { bubbles: true }));
  const drag = (el, x0, y0, x1, y1) => {
    el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y0 }));
    el.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: x1, clientY: y1 }));
    el.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, clientX: x1, clientY: y1 }));
  };

  ck('loads with no init errors', errors.length === 0);
  errors.forEach(e => console.log('   > ' + e));

  // ----- initial state -----
  ck('analyze disabled initially', $('analyzeBtn').disabled === true);
  ck('testOnZone hidden in single mode', $('testOnZone').style.display === 'none');
  ck('threshold default is 12', $('threshSlider').value === '12');

  // ----- mode toggle -----
  click(doc.querySelector('.mode-btn[data-mode="compare"]'));
  ck('compare: testOnZone shown', $('testOnZone').style.display !== 'none');
  ck('compare: button says Compare', $('analyzeBtn').textContent.includes('Compare'));
  click(doc.querySelector('.mode-btn[data-mode="single"]'));
  ck('single: testOnZone hidden again', $('testOnZone').style.display === 'none');

  // ----- guide tabs -----
  click($('captureGuideOpen'));
  ck('guide opens', $('captureGuideModal').classList.contains('open'));
  const tabs = doc.querySelectorAll('.cg-tab'), panels = doc.querySelectorAll('.cg-tab-panel');
  ck('guide has 5 tabs + 5 panels', tabs.length === 5 && panels.length === 5);
  click(tabs[2]);
  ck('tab switch shows features', [...panels].find(p => p.dataset.panel === 'features').style.display !== 'none');
  click($('captureGuideClose'));
  ck('guide closes', !$('captureGuideModal').classList.contains('open'));

  // ----- slider <-> number -----
  $('threshSlider').value = '40'; input($('threshSlider'));
  ck('slider updates number', $('threshVal').value === '40');
  $('threshVal').value = '25'; input($('threshVal'));
  ck('number updates slider', $('threshSlider').value === '25');

  // ----- collapsible cards -----
  const collapsibles = doc.querySelectorAll('.card.collapsible');
  ck('two collapsible cards, collapsed by default', collapsibles.length === 2 && [...collapsibles].every(c => c.classList.contains('collapsed')));
  const c6 = [...collapsibles].find(c => c.querySelector('.card-num').textContent.trim() === '6');
  click(c6.querySelector('.card-header'));
  ck('card expands + persists', !c6.classList.contains('collapsed') && store['bosCollapse_6'] === 'open');

  // ----- keyboard shortcut safe when disabled -----
  try { doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); ck('ctrl+enter safe when disabled', true); }
  catch (e) { ck('ctrl+enter safe when disabled', false); }

  // ----- inline-onclick globals exist -----
  ['openFullscreen', 'closeFullscreen', 'downloadSingleImage', 'fmtRatio', 'drawLineChart',
   'renderCompareResults', 'lineProfileSummary', 'fmtLen', 'pxToMm', 'esc',
   'openCanvasZoom', 'closeCanvasZoom', 'bakeMeasureIntoDataURL', 'resetMeasureState',
   'renderMeasureLayer', 'measureLengthPx', 'boxMatchesBackgroundRegion', 'getSuggestScopeRoi',
   'reapplyRoiToNewCanvas', 'openMeasureZoom', 'refreshZoomedMeasureOverlay',
   'openScaleStep', 'goToMeasureStep', 'snapAxis'].forEach(fn =>
    ck('global fn: ' + fn, typeof w[fn] === 'function'));

  // ----- measure tool: length math is a pure normalized-coord calc, easy to unit test -----
  (function () {
    const img = { naturalWidth: 1000, naturalHeight: 1100 };
    // getDiffPixelSize falls back to naturalWidth/naturalHeight when there's no
    // currentAnalysisData, so this exercises the same math bakeMeasureIntoDataURL uses.
    const lenPx = w.measureLengthPx(img, { x0: 0, y0: 0, x1: 1, y1: 0 });
    ck('measureLengthPx horizontal full-width', Math.round(lenPx) === 1000);
  })();

  // ----- measure tool: axis snapping is also pure pixel-space math -----
  (function () {
    const start = { x: 100, y: 100 };
    ck('snapAxis: near-horizontal drag snaps y to start.y', JSON.stringify(w.snapAxis(start, { x: 250, y: 104 })) === JSON.stringify({ x: 250, y: 100 }));
    ck('snapAxis: near-vertical drag snaps x to start.x', JSON.stringify(w.snapAxis(start, { x: 103, y: 250 })) === JSON.stringify({ x: 100, y: 250 }));
    const diagonal = { x: 200, y: 200 }; // exact 45 degrees -- well outside the ~6deg snap window
    ck('snapAxis: a diagonal drag passes through unchanged (releases the snap)', JSON.stringify(w.snapAxis(start, diagonal)) === JSON.stringify(diagonal));
    ck('snapAxis: no movement at all is a no-op', JSON.stringify(w.snapAxis(start, start)) === JSON.stringify(start));
  })();

  // ----- ROI bugs: dragging a box, marking it Background, must not leave it
  // scoping the main stats (getEffectiveRoiForAnalyze), and Clear ROI must not
  // leave a duplicate box rendered via Compare Regions -----
  (function () {
    const roiCanvas = $('roiCanvas');
    ck('auto-suggest scope is null with no regions drawn yet', w.getSuggestScopeRoi() === null);
    drag(roiCanvas, 20, 20, 120, 90);
    const boxNorm = w.getEffectiveRoiForAnalyze();
    ck('roi drag creates a quick ROI', !!boxNorm);
    const roleBtn = $('mroiList').querySelector('.mroi-role');
    ck('drag auto-added a Compare Region', !!roleBtn);
    click(roleBtn); // toggle Signal -> Background (renderMroiList() rebuilds the
                     // list on click, so re-query rather than reuse the old node)
    ck('region now tagged Background', $('mroiList').querySelector('.mroi-role').textContent === 'Background');
    const afterBg = w.getEffectiveRoiForAnalyze();
    ck('bug fix: background-tagged quick ROI is not used for main stats',
      afterBg === null || JSON.stringify(afterBg) !== JSON.stringify(boxNorm));

    // Auto Noise Floor / Coverage Threshold bug: /suggest_params assumes its scoped
    // region is mostly background, so it must use the Background-tagged region here,
    // never the signal-scoped getEffectiveRoiForAnalyze() box (that fed the jet itself
    // into a "what does noise look like" calculation and gave nonsense suggestions).
    const suggestRoi = w.getSuggestScopeRoi();
    ck('auto-suggest scope uses the background-tagged region', !!suggestRoi &&
      Math.abs(suggestRoi.x - boxNorm.x) < 1e-6 && Math.abs(suggestRoi.y - boxNorm.y) < 1e-6);

    drag(roiCanvas, 20, 20, 120, 90);
    const countAfterSecondDrag = $('mroiList').querySelectorAll('.mroi-item').length;
    ck('second drag adds another region alongside the background one', countAfterSecondDrag === 2);
    click($('clearRoiBtn'));
    // The earlier Background-tagged region should survive (Clear ROI only drops
    // the box it just auto-added, not the whole Compare Regions list).
    ck('bug fix: Clear ROI removes only the box it just auto-added',
      $('mroiList').querySelectorAll('.mroi-item').length === countAfterSecondDrag - 1);
  })();

  // ----- "remember ROI across image changes" feature: swapping the ref/test
  // files must not wipe roiNorm/multiRois any more, and reapplyRoiToNewCanvas()
  // must carry the normalized box over onto a differently-sized canvas (as
  // happens when the new photo isn't the exact same resolution) -----
  (function () {
    const roiCanvas = $('roiCanvas');
    drag(roiCanvas, 10, 10, 100, 80);
    const before = w.getEffectiveRoiForAnalyze();
    ck('remember-roi: drag creates a quick ROI', !!before);

    // Simulate a new image pair loading into a differently-sized canvas, the
    // way loadDiffPreviewToROICanvas does right before calling this.
    roiCanvas.width = 600;
    roiCanvas.height = 450;
    w.reapplyRoiToNewCanvas();

    const after = w.getEffectiveRoiForAnalyze();
    ck('remember-roi: normalized box survives a canvas resize unchanged',
      !!after && Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6 &&
      Math.abs(after.w - before.w) < 1e-6 && Math.abs(after.h - before.h) < 1e-6);
    ck('remember-roi: info text still shows a selected box', $('roiInfo').textContent.startsWith('Selected:'));
  })();

  // ----- Measure wizard: pressing the button opens step 1 (set scale on the
  // reference photo, calibInfo/calibEntryRow reparented alongside calibCanvas),
  // "Next" swaps to step 2 (draw on the color diff, same modal session) without
  // closing, a drag there mirrors onto the grayscale thumbnail too (same diff
  // pixel space), and Clear (step 2) wipes both mirrored copies -----
  (function () {
    // jsdom doesn't run layout or decode images, so real <img> elements report
    // clientWidth/naturalWidth as 0 -- stub realistic values so the drag's
    // pixel<->normalized math (containRect/pxToNorm) behaves like a real page.
    ['grayImg', 'colorImg'].forEach(id => {
      const el = $(id);
      el.src = 'data:image/png;base64,AA==';
      Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
      Object.defineProperty(el, 'naturalWidth', { value: 400, configurable: true });
      Object.defineProperty(el, 'naturalHeight', { value: 300, configurable: true });
    });
    // has-image is normally added once the reference photo loads into calibCanvas
    // (loadRefToCalibCanvas); simulate that so openScaleStep() takes the normal
    // path instead of its "no reference loaded yet" fallback straight to step 2.
    $('calibCanvas').classList.add('has-image');

    const colorWrap = $('colorImg').closest('.img-wrap');
    const colorOriginalParent = colorWrap.parentElement;
    const calibFrame = $('calibCanvas').closest('.canvas-frame');
    const calibOriginalParent = calibFrame.parentElement;
    const bar = $('calibActiveBar'), info = $('calibInfo'), entry = $('calibEntryRow');
    const barHome = bar.parentElement, infoHome = info.parentElement, entryHome = entry.parentElement;

    click($('measureToggleBtn'));
    ck('measure wizard: pressing the button opens step 1 (scale)', $('canvasZoomModal').classList.contains('open'));
    ck('measure wizard: calibCanvas reparented into the modal body', $('canvasZoomBody').contains($('calibCanvas')));
    ck('measure wizard: scale controls (bar/info/entry) reparented into the foot', $('canvasZoomFoot').contains(bar) && $('canvasZoomFoot').contains(info) && $('canvasZoomFoot').contains(entry));
    ck('measure wizard: foot is visible during step 1', $('canvasZoomFoot').style.display === 'flex');
    ck('measure wizard: Done button reads "Next" on step 1', $('canvasZoomDone').textContent.includes('Next'));

    // Axis snapping (snapAxis, unit-tested above) is also wired into the scale
    // line drag -- smoke-test that dragging on the zoomed calibCanvas still
    // reaches finalizeCalibLine() and updates the info text after the change.
    drag($('calibCanvas'), 20, 20, 140, 24); // near-horizontal, well within the snap window
    ck('measure wizard: dragging a scale line on calibCanvas updates calibInfo', info.textContent.startsWith('Line length:'));

    click($('canvasZoomDone')); // advance to step 2
    ck('measure wizard: step 1 controls restored to their original spot', bar.parentElement === barHome && info.parentElement === infoHome && entry.parentElement === entryHome);
    ck('measure wizard: foot hidden again on step 2', $('canvasZoomFoot').style.display === 'none');
    ck('measure wizard: calibCanvas restored to Card 4', calibFrame.parentElement === calibOriginalParent);
    ck('measure wizard: modal stayed open across the step change', $('canvasZoomModal').classList.contains('open'));
    ck('measure wizard: color img-wrap now in the modal body (step 2)', $('canvasZoomBody').contains(colorWrap));
    ck('measure wizard: Done button back to "Done" on step 2', $('canvasZoomDone').textContent === 'Done');
    ck('measure wizard: Undo button visible on step 2', $('canvasZoomUndo').style.display === '');
    const colorLayer = $('colorMeasureLayer');
    ck('measure wizard: zoomed layer is active (draggable)', colorLayer.classList.contains('active'));

    drag(colorLayer, 20, 20, 120, 90);
    ck('measure wizard: drag draws a line on the zoomed (color) layer', colorLayer.innerHTML.includes('<svg'));
    ck('measure wizard: line mirrors onto the grayscale thumbnail too', $('grayMeasureLayer').innerHTML.includes('<svg'));

    // Multiple lines: a second drag must add alongside the first, not replace it.
    drag(colorLayer, 150, 20, 250, 90);
    const colorLineCount = (colorLayer.innerHTML.match(/<line /g) || []).length;
    ck('measure wizard: a second drag adds a second line (not a replacement)', colorLineCount === 2);
    ck('measure wizard: second line mirrors onto grayscale too', ($('grayMeasureLayer').innerHTML.match(/<line /g) || []).length === 2);
    ck('measure wizard: label has no black outline stroke', !colorLayer.innerHTML.includes('#0b0c0d'));
    ck('measure wizard: label uses a thin weight', colorLayer.innerHTML.includes('font-weight="400"'));
    // Label used to be the same color as the line it sits centered on top of --
    // unreadable where they cross. Text must be white; line/dots stay yellow.
    ck('measure wizard: label text is white (distinct from the yellow line)', colorLayer.innerHTML.includes('<text') && /<text[^>]*fill="#ffffff"/.test(colorLayer.innerHTML));
    ck('measure wizard: line/dots are still the yellow measure color', /<line[^>]*stroke="#ffd166"/.test(colorLayer.innerHTML));

    // Undo removes only the most recent line (from both mirrored slots), not
    // the whole set the way Clear does.
    click($('canvasZoomUndo'));
    ck('measure wizard: Undo drops back to one line on color', (colorLayer.innerHTML.match(/<line /g) || []).length === 1);
    ck('measure wizard: Undo drops back to one line on the mirrored gray too', ($('grayMeasureLayer').innerHTML.match(/<line /g) || []).length === 1);
    click($('canvasZoomUndo'));
    ck('measure wizard: Undo down to zero lines clears the layer', colorLayer.innerHTML === '');
    click($('canvasZoomUndo')); // no-op when already empty -- must not throw
    ck('measure wizard: Undo on an empty set is a safe no-op', colorLayer.innerHTML === '');

    // Redraw one line so the close/reopen/Clear checks below still have something to work with.
    drag(colorLayer, 20, 20, 120, 90);

    click($('canvasZoomDone'));
    ck('measure wizard: Done restores the img-wrap to its original spot', colorWrap.parentElement === colorOriginalParent);
    ck('measure wizard: zoomed layer deactivated on close', !colorLayer.classList.contains('active'));
    ck('measure wizard: line still shown on the small color thumbnail after closing', $('colorMeasureLayer').innerHTML.includes('<svg'));
    ck('measure wizard: modal closed', !$('canvasZoomModal').classList.contains('open'));

    // Reopen (always starts at step 1 again) -> Next -> Clear must wipe both
    // mirrored copies, not just the one that was zoomed.
    click($('measureToggleBtn'));
    click($('canvasZoomDone'));
    click($('canvasZoomClear'));
    ck('measure wizard: Clear removes the color line', $('colorMeasureLayer').innerHTML === '');
    ck('measure wizard: Clear removes the mirrored gray line too', $('grayMeasureLayer').innerHTML === '');
    click($('canvasZoomDone'));
  })();

  // ----- Zoomed Signal ROI bug: quickRoiBox snapshot must not be trusted once
  // it's been re-tagged Background in Compare Regions (same bug class as the
  // getEffectiveRoiForAnalyze fix above, but on the frozen post-Analyze snapshot) -----
  (function () {
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const bgRegions = [{ name: 'r1', role: 'background', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }];
    const sigRegions = [{ name: 'r1', role: 'signal', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }];
    ck('boxMatchesBackgroundRegion true when tagged background', w.boxMatchesBackgroundRegion(box, bgRegions) === true);
    ck('boxMatchesBackgroundRegion false when tagged signal', w.boxMatchesBackgroundRegion(box, sigRegions) === false);
    ck('boxMatchesBackgroundRegion false with no regions', w.boxMatchesBackgroundRegion(box, []) === false);
  })();

  // ----- helper outputs -----
  ck('fmtRatio 45/30', w.fmtRatio(45, 30) === '1.50×');
  ck('fmtLen px uncalibrated', w.fmtLen(100) === '100 px');
  ck('esc blocks tags', w.esc('<img src=x>') === '&lt;img src=x&gt;');

  // ----- render path: compare ROI table + XSS escaping -----
  const line = { values: [0, 5, 20, 5, 0], smoothed: [1, 4, 18, 4, 1], peak: 18, mean: 5.6, length_px: 255, samples: 5, width_px: 30, peak_index: 2, baseline: 1, half_max: 9, width_lo: 1, width_hi: 3 };
  const mkRun = (peak, rois) => ({ run_id: 'r' + peak, datetime: 'now', color: 'AA', grayscale: 'AA', raw: 'AA', thresholded: 'AA', image_width: 320, image_height: 240, stats: { peak, mean: peak / 2, coverage: 20 }, rois: rois ? { rois, background: { mean: 2, std: 1 }, threshold: 12 } : null, line });
  const evil = '<img src=x onerror=alert(1)>';
  const roisOff = [{ name: evil, role: 'signal', mean: 20, peak: 40, std: 5, coverage: 30, snr_mean: 8, snr_std: 4 }, { name: 'bg', role: 'background', mean: 2.5, peak: 6, std: 1, coverage: 1, snr_mean: 1, snr_std: 1 }];
  const roisOn = roisOff.map(r => ({ ...r, mean: r.mean * 1.3, peak: Math.round(r.peak * 1.3) }));
  try {
    await w.renderCompareResults(mkRun(40, roisOff), mkRun(52, roisOn), { x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, null);
    ck('compare ROI panel shown', $('compareRoiPanel').style.display === 'flex');
    ck('compare ROI table has 2 rows', $('compareRoiTableBody').querySelectorAll('tr').length === 2);
    ck('region name escaped (no injected img)', $('compareRoiTableBody').querySelector('img') === null);
    ck('region name kept as literal text', $('compareRoiTableBody').querySelector('.roi-name-cell').textContent === evil);
    ck('compare line panel shown', $('compareLinePanel').style.display === 'flex');
  } catch (e) { fail++; console.log('FAIL renderCompareResults threw: ' + e.message); }

  ck('no errors after interactions', errors.length === 0);
  errors.forEach(e => console.log('   > ' + e));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
