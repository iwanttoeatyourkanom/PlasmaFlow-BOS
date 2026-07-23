// ZIP export (single + compare) and the result summary table.

// ===== Compare mode: Download ZIP (one row each for OFF and ON) =====
document.getElementById('dlCompareZipBtn').onclick = async () => {
  if (!currentCompareData) return;
  if (!window.JSZip) {
    alert("JSZip library failed to load. Please check your internet connection.");
    return;
  }
  const btn = document.getElementById('dlCompareZipBtn');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Zipping...';
  btn.disabled = true;

  try {
    const zip = new JSZip();
    const d = currentCompareData;
    const off = d.off, on = d.on;

    zip.file("diff_grayscale_plasma_off.png", off.grayscale, { base64: true });
    zip.file("diff_grayscale_plasma_on.png", on.grayscale, { base64: true });
    zip.file("diff_color_plasma_off.png", off.color, { base64: true });
    zip.file("diff_color_plasma_on.png", on.color, { base64: true });

    // Thresholded (binary mask) diffs, same images as the "Show Thresholded" toggle.
    if (off.thresholded) zip.file("diff_thresholded_plasma_off.png", off.thresholded, { base64: true });
    if (on.thresholded) zip.file("diff_thresholded_plasma_on.png", on.thresholded, { base64: true });

    // Noise baseline (Reference vs Reference 2), if that optional shot was
    // uploaded -- same images shown in the Noise Baseline panel.
    if (d.control && d.control.grayscale) {
      zip.file("noise_baseline_grayscale.png", d.control.grayscale, { base64: true });
      zip.file("noise_baseline_color.png", d.control.color, { base64: true });
    }

    const summaryDataUrl = await buildCompareSummaryDataURL();
    if (summaryDataUrl) {
      zip.file("plasma_compare_summary.png", summaryDataUrl.split(',')[1], { base64: true });
    }

    // Full-res crop of just the signal ROI, OFF and ON (same images as
    // "Show Zoomed Signal ROI"), skipped if no quick ROI or signal region.
    if (getCompareSignalCropBox()) {
      const signalCrops = await buildCompareSignalCropDataURLs();
      if (signalCrops.off) zip.file("signal_roi_zoom_plasma_off.png", signalCrops.off.split(',')[1], { base64: true });
      if (signalCrops.on) zip.file("signal_roi_zoom_plasma_on.png", signalCrops.on.split(',')[1], { base64: true });
    }

    const csvEsc = v => `"${(v === null || v === undefined ? '' : v).toString().replace(/"/g, '""')}"`;
    const makeCsv = (header, rows) =>
      [header.join(','), ...rows.map(r => r.map(csvEsc).join(','))].join('\n');

    // Self-contained copy of the two rows the server already logged, same columns as runs.csv.
    zip.file("runs.csv", makeCsv(
      ["run_id", "datetime", "gas_type", "flow_rate", "plasma_status", "plasma_condition",
       "is_control", "cam_type", "iso", "shutter", "aperture", "nozzle_dist",
       "lighting", "notes", "ref_file", "test_file", "colormap", "gain", "noise_floor",
       "threshold", "align", "peak", "mean", "coverage", "denoise"],
      [off, on].map(r => [
        r.run_id, r.datetime,
        document.getElementById('gasType').value, document.getElementById('flowRate').value,
        r === off ? 'OFF' : 'ON', document.getElementById('plasmaCond').value,
        'OFF', document.getElementById('camType').value, document.getElementById('iso').value,
        document.getElementById('shutter').value, document.getElementById('aperture').value,
        document.getElementById('nozDist').value, document.getElementById('lighting').value,
        document.getElementById('notes').value,
        refInput.files[0].name, r === off ? testInput.files[0].name : testOnInput.files[0].name,
        document.getElementById('colormapSel').value, document.getElementById('gainSlider').value,
        document.getElementById('floorSlider').value, document.getElementById('threshSlider').value,
        document.getElementById('alignToggle').checked ? 'ON' : 'OFF',
        r.stats.peak, r.stats.mean, r.stats.coverage,
        document.getElementById('denoiseToggle').checked ? 'ON' : 'OFF',
      ])
    ));

    const roiRows = [];
    (off.rois ? off.rois.rois : []).forEach(r =>
      roiRows.push([off.run_id, r.name, r.role, r.mean, r.peak, r.std, r.coverage, r.snr_mean, r.snr_std]));
    (on.rois ? on.rois.rois : []).forEach(r =>
      roiRows.push([on.run_id, r.name, r.role, r.mean, r.peak, r.std, r.coverage, r.snr_mean, r.snr_std]));
    zip.file("roi_regions.csv", makeCsv(
      ["run_id", "roi_name", "role", "mean", "peak", "std", "coverage", "snr_mean", "snr_std"],
      roiRows
    ));

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plasma_compare_${off.run_id}_${on.run_id}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Error creating ZIP file: " + err.message);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
};

// ===== Result summary table (display-only; reads currentAnalysisData) =====
function renderResultTable() {
  const d = currentAnalysisData;
  if (!d || !d.log) return;
  const s = d.stats || {};
  const disp = d.display || {};
  const roi = d.roi;
  const roiTxt = roi
    ? `${(roi.w * 100).toFixed(1)}% × ${(roi.h * 100).toFixed(1)}% from (${(roi.x * 100).toFixed(1)}%, ${(roi.y * 100).toFixed(1)}%)`
    : 'Full image';

  // Noise-baseline stats (Reference vs Reference 2), if it was run.
  const controlRows = d.control ? [
    ['group', 'Noise Baseline'],
    ['Baseline Run ID', d.control.runId],
    ['Baseline Peak (p99)', d.control.stats.peak],
    ['Baseline Mean', d.control.stats.mean],
    ['Baseline Coverage %', d.control.stats.coverage != null ? d.control.stats.coverage + '%' : ''],
    ['Mean vs Baseline', d.control.stats.mean ? (s.mean / d.control.stats.mean).toFixed(2) + '×' : ''],
  ] : [];

  const rows = [
    ['group', 'Output Metrics'],
    ['Run ID', d.runId],
    ['Peak Diff (p99)', s.peak],
    ['Mean Diff', s.mean],
    ['Coverage %', s.coverage != null ? s.coverage + '%' : ''],
    ['ROI', roiTxt],
    ['Scale', d.calibPxPerMm ? `${d.calibPxPerMm.toFixed(2)} px/mm` : 'not set'],
    ...controlRows,
    ['group', 'Experiment'],
    ['Gas Type', d.log.gas_type],
    ['Flow Rate (L/min)', d.log.flow_rate],
    ['Plasma Status', d.log.plasma_status],
    ['Plasma Condition', d.log.plasma_condition],
    ['group', 'Display'],
    ['Colormap', disp.cmap],
    ['Gain', disp.gain != null ? disp.gain + '×' : ''],
    ['Noise Floor', disp.floor],
    ['Coverage Threshold', disp.thresh],
    ['Align Images', disp.align],
    ['Alignment Shift', d.alignShift ? `dx=${d.alignShift.dx}, dy=${d.alignShift.dy} px` : ''],
    ['Denoise (median blur)', disp.denoise],
    ['group', 'Camera & Layout'],
    ['Camera Type', d.log.CamType],
    ['Focus', d.log.Focus],
    ['ISO', d.log.Iso],
    ['Shutter', d.log.Shutter],
    ['Aperture', d.log.Aperture],
    ['Nozzle-BG Dist (cm)', d.log.NozDist],
    ['Lighting', d.log.Light],
    ['Notes', d.log.Notes],
    ['group', 'Files'],
    ['Reference File', d.refName],
    ['Test File', d.testName]
  ];

  const tbody = document.getElementById('resultTableBody');
  tbody.innerHTML = rows.map(([k, v]) => {
    if (k === 'group') return `<tr class="grp"><td colspan="2">${v}</td></tr>`;
    const val = (v === undefined || v === null || v === '') ? '-' : String(v);
    const cls = val === '-' ? 'v empty' : 'v';
    return `<tr><td class="k">${k}</td><td class="${cls}">${val.replace(/</g, '&lt;')}</td></tr>`;
  }).join('');
}

// ===== Download ZIP =====
document.getElementById('dlZipBtn').onclick = async () => {
  if (!window.JSZip) {
    alert("JSZip library failed to load. Please check your internet connection.");
    return;
  }

  const btn = document.getElementById('dlZipBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Zipping...';
  btn.disabled = true;

  try {
    const zip = new JSZip();

    const cmap = currentAnalysisData.display.cmap;
    // Bake in any Measure lines so the ZIP records what was measured.
    const grayDataUrl = measureLines.gray.length ? bakeMeasureIntoDataURL(document.getElementById('grayImg'), measureLines.gray) : null;
    zip.file("diff_grayscale.png", grayDataUrl ? grayDataUrl.split(',')[1] : currentAnalysisData.grayBase64, { base64: true });
    const colorDataUrl = measureLines.color.length ? bakeMeasureIntoDataURL(document.getElementById('colorImg'), measureLines.color) : null;
    zip.file(`diff_color_${cmap}.png`, colorDataUrl ? colorDataUrl.split(',')[1] : currentAnalysisData.colorBase64, { base64: true });

    // Thresholded (binary mask) diff, same image as the "Show Thresholded" toggle.
    if (currentAnalysisData.thresholdedBase64) {
      zip.file("diff_thresholded.png", currentAnalysisData.thresholdedBase64, { base64: true });
    }

    // Noise baseline (Reference vs Reference 2) diff images, if that optional
    // shot was uploaded -- same images now shown in the Noise Baseline panel.
    if (currentAnalysisData.control && currentAnalysisData.control.grayscale) {
      zip.file("noise_baseline_grayscale.png", currentAnalysisData.control.grayscale, { base64: true });
      zip.file("noise_baseline_color.png", currentAnalysisData.control.color, { base64: true });
    }

    // Same composite as the "Download ROI Summary" button; null if nothing to summarize.
    const roiSummaryDataUrl = await buildRoiSummaryDataURL();
    if (roiSummaryDataUrl) {
      zip.file("roi_summary.png", roiSummaryDataUrl.split(',')[1], { base64: true });
    }

    // Full-res crop of just the signal ROI (same image as "Show Zoomed
    // Signal ROI"), skipped if this run had no quick ROI or signal region.
    if (getSignalCropBox()) {
      const signalRoiDataUrl = await buildSignalRoiCropDataURL();
      if (signalRoiDataUrl) {
        zip.file("signal_roi_zoom.png", signalRoiDataUrl.split(',')[1], { base64: true });
      }
    }

    // This run's rows only, same columns/run_id as the server CSVs so they join cleanly.
    const csvEsc = v => `"${(v === null || v === undefined ? '' : v).toString().replace(/"/g, '""')}"`;
    const makeCsv = (header, rows) =>
      [header.join(','), ...rows.map(r => r.map(csvEsc).join(','))].join('\n');

    const cad = currentAnalysisData;
    const l = cad.log;
    const s = cad.stats;
    const d = cad.display;
    const runId = cad.runId;

    zip.file("runs.csv", makeCsv(
      ["run_id", "datetime", "gas_type", "flow_rate", "plasma_status", "plasma_condition",
       "is_control", "cam_type", "iso", "shutter", "aperture", "nozzle_dist",
       "lighting", "notes", "ref_file", "test_file", "colormap", "gain", "noise_floor",
       "threshold", "align", "peak", "mean", "coverage", "denoise"],
      [[runId, cad.datetime, l.gas_type, l.flow_rate, l.plasma_status, l.plasma_condition,
        'OFF', l.CamType, l.Iso, l.Shutter, l.Aperture, l.NozDist,
        l.Light, l.Notes, cad.refName, cad.testName, d.cmap, d.gain, d.floor,
        d.thresh, d.align, s.peak, s.mean, s.coverage, d.denoise]]
    ));

    zip.file("roi_regions.csv", makeCsv(
      ["run_id", "roi_name", "role", "mean", "peak", "std", "coverage", "snr_mean", "snr_std"],
      (cad.rois ? cad.rois.rois : []).map(r =>
        [runId, r.name, r.role, r.mean, r.peak, r.std, r.coverage, r.snr_mean, r.snr_std])
    ));

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const gasPrefix = l.gas_type ? `${l.gas_type}_` : '';
    a.download = `BOS_${gasPrefix}${runId}.zip`;

    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Error creating ZIP file: " + err.message);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
};
