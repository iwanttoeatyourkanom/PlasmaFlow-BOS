import base64
import csv
import json
import os
from datetime import datetime

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="BOS Image Analysis")

COLORMAPS = {
    "JET": cv2.COLORMAP_JET,
    "TURBO": cv2.COLORMAP_TURBO,
    "VIRIDIS": cv2.COLORMAP_VIRIDIS,
}

DEFAULT_COVERAGE_THRESHOLD = 1
# Median kernel for /diff_preview's smoothing (removes speckle without smearing the jet).
MEDIAN_KSIZE = 5

# Fixed (not per-image min/max) diff->white scale, so brightness stays comparable across experiments.
DISPLAY_FULL_SCALE = 64

# The Raw view is a display-only "before" reference (never overlaid, cropped, or
# exported), so its width is capped to keep responses light on big photos. The main
# grayscale/color diffs stay full resolution; only this reference image is shrunk.
RAW_DISPLAY_MAX_W = 2000

# Three accumulating CSVs joined by run_id, minted once per Analyze press.
RUNS_FILE = "runs.csv"
RUNS_HEADER = [
    "run_id", "datetime", "gas_type", "flow_rate", "plasma_status", "plasma_condition",
    "is_control", "cam_type", "iso", "shutter", "aperture", "nozzle_dist",
    "lighting", "notes", "ref_file", "test_file", "colormap", "gain", "noise_floor",
    "threshold", "align", "peak", "mean", "coverage", "denoise",
]
ROI_REGIONS_FILE = "roi_regions.csv"
ROI_REGIONS_HEADER = [
    "run_id", "roi_name", "role", "mean", "peak", "std", "coverage", "snr_mean", "snr_std",
]


def _append_csv(path: str, header: list, rows: list):
    """Append rows to an accumulating CSV, writing the header on first use."""
    file_exists = os.path.isfile(path)
    with open(path, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(header)
        writer.writerows(rows)


CORNER_FRACTION = 0.15  # outer 15% x 15% of each corner, used only for alignment (never near the jet)


def _phase_corr_shift(ref_patch: np.ndarray, test_patch: np.ndarray) -> tuple:
    """(dx, dy) shift of test_patch relative to ref_patch via phase correlation.

    Returns (0, 0) rather than raising when the patch is too small for a Hanning
    window (needs >1 px per side) or when phaseCorrelate returns a non-finite value
    on a flat/degenerate patch, so alignment never crashes the request.
    """
    if ref_patch.shape[0] < 2 or ref_patch.shape[1] < 2:
        return 0.0, 0.0
    win = cv2.createHanningWindow((ref_patch.shape[1], ref_patch.shape[0]), cv2.CV_32F)
    (dx, dy), _ = cv2.phaseCorrelate(ref_patch.astype(np.float32), test_patch.astype(np.float32), win)
    if not (np.isfinite(dx) and np.isfinite(dy)):
        return 0.0, 0.0
    return dx, dy


def _estimate_shift(ref_gray: np.ndarray, test_gray: np.ndarray) -> dict:
    """Estimate a whole-frame rigid shift from the four corner patches only.

    The jet's own real signal lives away from the corners, so corner-only patches avoid
    letting the BOS signal bias the shift estimate (and then get subtracted out as noise).
    Returns the median (dx, dy) across corners plus each corner's own estimate for transparency.
    Images too small to carve out a real corner patch (any side < 4 px) skip alignment.
    """
    H, W = ref_gray.shape
    if H < 4 or W < 4:
        return {"dx": 0.0, "dy": 0.0, "corners": {}}
    # At least 2 px per side (phaseCorrelate needs > 1), never larger than the image.
    ch = min(H, max(2, int(H * CORNER_FRACTION)))
    cw = min(W, max(2, int(W * CORNER_FRACTION)))
    corners = {
        "top_left": (slice(0, ch), slice(0, cw)),
        "top_right": (slice(0, ch), slice(W - cw, W)),
        "bottom_left": (slice(H - ch, H), slice(0, cw)),
        "bottom_right": (slice(H - ch, H), slice(W - cw, W)),
    }

    per_corner = {}
    for name, (ys, xs) in corners.items():
        dx, dy = _phase_corr_shift(ref_gray[ys, xs], test_gray[ys, xs])
        per_corner[name] = {"dx": round(dx, 3), "dy": round(dy, 3)}

    dxs = [v["dx"] for v in per_corner.values()]
    dys = [v["dy"] for v in per_corner.values()]
    dx_med = float(np.median(dxs))
    dy_med = float(np.median(dys))

    return {"dx": round(dx_med, 3), "dy": round(dy_med, 3), "corners": per_corner}


def compute_diff(ref_bytes: bytes, test_bytes: bytes, roi_norm: tuple = None, align: bool = False,
                  denoise: bool = False):
    """Decode ref/test images and return (diff, shift_info) as their grayscale absolute difference.

    Shared by run_bos, /suggest_params, /analyze_rois, /diff_preview. roi_norm,
    if given, is normalized (x, y, w, h) 0-1; both images are cropped to it first. If align is
    True, a whole-frame translation (measured from the four corners only, see _estimate_shift)
    is applied to test before diffing, and shift_info is the returned dict; otherwise shift_info
    is None and behavior is bit-identical to before this option existed.

    If denoise is True, a median blur (MEDIAN_KSIZE) is applied to the diff itself before it's
    returned -- like align, this is a real preprocessing step (it changes peak/mean/coverage,
    not just the rendered image), distinct from the display-only noise_floor slider. Skipped on
    crops smaller than the kernel (e.g. a tiny ROI) rather than raising.
    """
    ref = cv2.imdecode(np.frombuffer(ref_bytes, np.uint8), cv2.IMREAD_COLOR)
    test = cv2.imdecode(np.frombuffer(test_bytes, np.uint8), cv2.IMREAD_COLOR)
    if ref is None or test is None:
        raise ValueError("Could not decode one or both images. Check the file format.")

    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))

    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    test_gray = cv2.cvtColor(test, cv2.COLOR_BGR2GRAY)

    shift_info = None
    if align:
        shift_info = _estimate_shift(ref_gray, test_gray)
        dx, dy = shift_info["dx"], shift_info["dy"]
        # phaseCorrelate(ref, test) reports how far test has moved from ref, so we
        # warp test back by the negative of that to undo the shift.
        M = np.array([[1, 0, -dx], [0, 1, -dy]], dtype=np.float32)
        test_gray = cv2.warpAffine(
            test_gray, M, (test_gray.shape[1], test_gray.shape[0]),
            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE,
        )

    if roi_norm is not None:
        nx, ny, nw, nh = roi_norm
        H, W = ref_gray.shape
        # Clamp to image bounds so a slightly out-of-range selection stays valid.
        rx = max(0, min(int(nx * W), W - 1))
        ry = max(0, min(int(ny * H), H - 1))
        rw = min(max(1, int(nw * W)), W - rx)
        rh = min(max(1, int(nh * H)), H - ry)
        ref_gray = ref_gray[ry:ry + rh, rx:rx + rw]
        test_gray = test_gray[ry:ry + rh, rx:rx + rw]

    diff = cv2.absdiff(ref_gray, test_gray)
    if denoise and diff.shape[0] >= MEDIAN_KSIZE and diff.shape[1] >= MEDIAN_KSIZE:
        diff = cv2.medianBlur(diff, MEDIAN_KSIZE)
    return diff, shift_info


def run_bos(
    ref_bytes: bytes,
    test_bytes: bytes,
    colormap: str = "JET",
    gain: float = 1.0,
    threshold: int = DEFAULT_COVERAGE_THRESHOLD,
    noise_floor: int = 0,
    roi_norm: tuple = None,
    align: bool = False,
    denoise: bool = False,
    control_peak: float = None,
    control_mean: float = None,
) -> tuple:
    """Compute the BOS diff and return (rendered images + stats dict, diff_full).

    Stats always come from the raw diff (after align/denoise preprocessing, if enabled), never
    the display-adjusted render (colormap/gain/noise_floor).

    roi_norm no longer crops any pixels out of the rendered images -- every run's grayscale/
    color/raw/thresholded output is always the full frame, so jet position and framing stay
    comparable across runs (needed to check repeatability). roi_norm still scopes what the
    peak/mean/coverage stats are computed from: if given, they're computed from just that
    region of the diff via _crop_diff, same numbers as before, just no longer tied to what
    the image shows.

    diff_full (the full-frame diff array, after this call's align/denoise) is returned
    alongside the dict so callers that also need to sample it (e.g. /analyze's ROI list)
    can reuse it instead of paying for a second identical decode+align+diff.
    """
    diff_full, shift_info = compute_diff(ref_bytes, test_bytes, None, align=align, denoise=denoise)
    img_h, img_w = diff_full.shape  # pre-footer size, in pixels -- the served PNGs are taller than
    # this once _stamp_footer appends its footer band below, so the client needs this to convert
    # normalized (0-1) ROI coordinates (which are fractions of THIS, not of the served PNG) back
    # into pixels correctly, e.g. when cropping a region out of the returned image client-side.
    stats_diff = _crop_diff(diff_full, roi_norm) if roi_norm is not None else diff_full

    # peak = 99th percentile, a robust max that ignores lone noise pixels.
    peak = int(round(float(np.percentile(stats_diff, 99))))
    mean = round(float(stats_diff.mean()), 2)
    coverage = round(float(np.count_nonzero(stats_diff > threshold)) / stats_diff.size * 100.0, 2)

    # --- Display rendering (full frame, does not affect stats) ---
    render_diff = diff_full

    if noise_floor > 0:
        render_diff = render_diff.copy()
        render_diff[render_diff <= noise_floor] = 0

    scale = 255.0 / DISPLAY_FULL_SCALE
    diff_vis = np.clip(render_diff.astype(np.float32) * scale * gain, 0, 255).astype(np.uint8)

    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    align_text = f"Align: {'ON' if align else 'OFF'}"
    denoise_text = f"Denoise: {'ON' if denoise else 'OFF'}"
    roi_text = ""
    if roi_norm is not None:
        _, _, nw, nh = roi_norm
        roi_text = f" | ROI: {nw * 100:.0f}%x{nh * 100:.0f}%"
    # Settings on their own line, computed result values on the line below. Cov gets the
    # threshold it was counted against in parentheses right next to it, so the number is
    # self-explanatory without having to cross-reference the settings line above.
    footer = [
        f"Cmap: {colormap.upper()} | Gain: {gain}x | NoiseFloor: {noise_floor} | "
        f"Thresh: {threshold} | {align_text} | {denoise_text}{roi_text}",
        f"Peak: {peak} | Mean: {mean} | Cov: {coverage}% (diff>{threshold})",
    ]
    # If a bracketed noise baseline (Reference vs Reference 2) was computed for this run,
    # burn its peak/mean into the image too -- not just the separate result table -- so
    # the "is this above the noise floor" comparison travels with the image itself
    # (ZIP, downloads, screenshots) instead of only living in the live UI.
    if control_peak is not None and control_mean is not None:
        footer.append(f"Noise Baseline (Ref1 vs Ref2): Peak: {control_peak}, Mean: {control_mean}")

    final_gray = _stamp_footer(diff_vis, footer)
    final_color = _stamp_footer(diff_color, footer)
    _, gray_buf = cv2.imencode(".png", final_gray)
    _, color_buf = cv2.imencode(".png", final_color)

    # Raw view: the genuinely untouched difference -- no align, no denoise, no noise
    # floor/gain -- regardless of what the align/denoise toggles above are set to. This
    # is a fixed "before" reference so align/denoise's effect can actually be seen by
    # comparing it against the main grayscale/color/thresholded views. Needs a fresh
    # align=False/denoise=False computation whenever this run's own align/denoise were
    # on (since diff_full then has those baked in) -- but if they were already both off,
    # diff_full already IS that computation, so it's reused instead (see below). Stats
    # still scoped to roi_norm, same as the main stats above; the image itself is full.
    if align or denoise:
        diff_raw_full, _ = compute_diff(ref_bytes, test_bytes, None, align=False, denoise=False)
    else:
        # This run's own align/denoise were already both off, so diff_full above (computed
        # with align=False, denoise=False) is already byte-identical to what a fresh
        # align=False/denoise=False call would produce -- reuse it instead of decoding and
        # diffing the same two images a second time.
        diff_raw_full = diff_full
    raw_stats_diff = _crop_diff(diff_raw_full, roi_norm) if roi_norm is not None else diff_raw_full
    raw_peak = int(round(float(np.percentile(raw_stats_diff, 99))))
    raw_mean = round(float(raw_stats_diff.mean()), 2)
    raw_vis = np.clip(diff_raw_full.astype(np.float32) * scale, 0, 255).astype(np.uint8)
    # Shrink the reference image for display (stats above already came from full res).
    if raw_vis.shape[1] > RAW_DISPLAY_MAX_W:
        rs = RAW_DISPLAY_MAX_W / raw_vis.shape[1]
        raw_vis = cv2.resize(raw_vis, (RAW_DISPLAY_MAX_W, max(1, int(round(raw_vis.shape[0] * rs)))),
                             interpolation=cv2.INTER_AREA)
    raw_footer = [
        "RAW - no align, no denoise, no noise floor",
        f"Peak: {raw_peak} | Mean: {raw_mean}",
    ]
    if control_peak is not None and control_mean is not None:
        raw_footer.append(f"Noise Baseline (Ref1 vs Ref2): Peak: {control_peak}, Mean: {control_mean}")
    final_raw = _stamp_footer(raw_vis, raw_footer)
    _, raw_buf = cv2.imencode(".png", final_raw)

    # Thresholded view: matches the same threshold coverage % is counted against.
    thresh_vis = np.where(diff_full > threshold, 255, 0).astype(np.uint8)
    thresh_footer = [
        f"THRESHOLDED - threshold: {threshold} | {align_text} | {denoise_text}",
        f"Coverage: {coverage}%",
    ]
    if control_peak is not None and control_mean is not None:
        thresh_footer.append(f"Noise Baseline (Ref1 vs Ref2): Peak: {control_peak}, Mean: {control_mean}")
    final_thresh = _stamp_footer(thresh_vis, thresh_footer)
    _, thresh_buf = cv2.imencode(".png", final_thresh)

    result = {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
        "raw": base64.b64encode(raw_buf).decode(),
        "thresholded": base64.b64encode(thresh_buf).decode(),
        "stats": {
            "peak": peak,
            "mean": mean,
            "coverage": coverage,
        },
        "align_shift": {"dx": shift_info["dx"], "dy": shift_info["dy"]} if shift_info else None,
        "image_width": img_w,
        "image_height": img_h,
    }
    return result, diff_full


def _stamp_footer(img, lines):
    """Stamp a parameter footer onto an image (works for gray or BGR).

    lines: list of logical footer lines (each a string with segments joined by
    " | "), rendered one below another -- e.g. settings on one line, computed
    result values (Peak/Mean/Cov/...) on the next. A line too wide for the
    image is further wrapped onto continuation rows.
    """
    h, w = img.shape[:2]
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.5, w / 1200)
    thickness = max(1, int(w / 1000))
    text_h = max(cv2.getTextSize(line, font, font_scale, thickness)[0][1] for line in lines)

    # Wrap each logical line on " | " so an overly long one grows taller (more
    # rows) rather than clipping off the right edge or shrinking the font.
    rows = []
    for line in lines:
        current = ""
        for seg in line.split(" | "):
            candidate = f"{current} | {seg}" if current else seg
            if current and cv2.getTextSize(candidate, font, font_scale, thickness)[0][0] + 40 > w:
                rows.append(current)
                # Keep a leading "|" on the wrapped continuation so it visibly reads as
                # "still part of the line above" instead of looking like a new, separate
                # stat -- this is what was confusing when e.g. "Denoise: ON" wrapped alone.
                current = f"| {seg}"
            else:
                current = candidate
        rows.append(current)

    line_h = int(text_h * 1.8)
    footer_h = max(40, int(h * 0.05))
    if len(rows) > 1:
        footer_h = max(footer_h, line_h * len(rows))

    if img.ndim == 2:
        footer = np.zeros((footer_h, w), dtype=np.uint8)
        text_color = 255
    else:
        footer = np.zeros((footer_h, w, 3), dtype=np.uint8)
        text_color = (255, 255, 255)

    # Center the block of rows vertically; for one row this is the same
    # footer_h/2 + text_h/2 baseline as before.
    top_pad = (footer_h - line_h * len(rows)) / 2
    for i, row in enumerate(rows):
        text_y = int(top_pad + (i + 0.5) * line_h + text_h / 2)
        cv2.putText(footer, row, (20, text_y), font, font_scale, text_color, thickness, cv2.LINE_AA)
    return cv2.vconcat([img, footer])


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.post("/analyze")
async def analyze(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    colormap: str = Form("JET"),
    gain: float = Form(1.0),
    threshold: int = Form(DEFAULT_COVERAGE_THRESHOLD),
    noise_floor: int = Form(0),
    align: bool = Form(False),
    denoise: bool = Form(False),
    roi_x: float = Form(0.0),
    roi_y: float = Form(0.0),
    roi_w: float = Form(0.0),
    roi_h: float = Form(0.0),
    rois: str = Form(""),
    gas_type: str = Form("None"),
    flow_rate: str = Form(""),
    plasma_status: str = Form("OFF"),
    plasma_condition: str = Form(""),
    is_control: str = Form("OFF"),
    control_peak: float = Form(None),
    control_mean: float = Form(None),
    CamType: str = Form(""),
    Focus: str = Form(""),
    Iso: str = Form(""),
    Shutter: str = Form(""),
    Aperture: str = Form(""),
    NozDist: str = Form(""),
    Light: str = Form(""),
    Notes: str = Form(""),
):
    """Run the main BOS analysis and commit one run to runs.csv (plus roi_regions.csv if `rois` is sent)."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # A zero-size ROI means "no selection" — analyze the full image.
    roi_norm = (roi_x, roi_y, roi_w, roi_h) if roi_w > 0 and roi_h > 0 else None

    try:
        result, diff_full = run_bos(
            ref_bytes, test_bytes, colormap, gain=gain, threshold=threshold,
            noise_floor=noise_floor, roi_norm=roi_norm, align=align, denoise=denoise,
            control_peak=control_peak, control_mean=control_mean,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # ROI list samples the full-image diff -- reuses the diff_full run_bos
    # already computed above (same ref/test/align/denoise) instead of recomputing it a
    # second time, which used to also mean re-running the 4-corner phase-correlation
    # alignment a second time whenever Align was on.
    roi_result = None
    if rois:
        try:
            roi_list = json.loads(rois)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="rois must be a valid JSON list.")
        if isinstance(roi_list, list) and roi_list:
            try:
                roi_result = analyze_roi_list(diff_full, roi_list, threshold)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

    # --- Commit this run to the three linked CSVs (one shared run_id) ---
    now = datetime.now()
    # Microsecond resolution, not just seconds: two /analyze calls landing in the same
    # second (e.g. Compare mode's OFF/ON pair, or the optional Noise Baseline run) used to
    # be able to mint the identical run_id, silently scrambling which roi_regions.csv
    # rows belonged to which run once joined back by run_id. The frontend
    # previously worked around this by force-sleeping >=1.1s between requests; this makes
    # that workaround unnecessary since collisions are no longer possible in practice.
    run_id = now.strftime("%Y%m%d_%H%M%S_%f")
    timestamp = now.strftime("%Y-%m-%d %H:%M:%S")

    _append_csv(RUNS_FILE, RUNS_HEADER, [[
        run_id, timestamp, gas_type, flow_rate, plasma_status, plasma_condition,
        is_control, CamType, Iso, Shutter, Aperture, NozDist,
        Light, Notes, reference.filename, test.filename, colormap, gain, noise_floor,
        threshold, "ON" if align else "OFF",
        result["stats"]["peak"], result["stats"]["mean"], result["stats"]["coverage"],
        "ON" if denoise else "OFF",
    ]])

    if roi_result:
        _append_csv(ROI_REGIONS_FILE, ROI_REGIONS_HEADER, [
            [run_id, r["name"], r["role"], r["mean"], r["peak"], r["std"], r["coverage"],
             "" if r["snr_mean"] is None else r["snr_mean"],
             "" if r["snr_std"] is None else r["snr_std"]]
            for r in roi_result["rois"]
        ])

    result["run_id"] = run_id
    result["datetime"] = timestamp
    result["rois"] = roi_result
    return result


@app.post("/suggest_params")
async def suggest_params(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    roi_x: float = Form(0.0),
    roi_y: float = Form(0.0),
    roi_w: float = Form(0.0),
    roi_h: float = Form(0.0),
    align: bool = Form(False),
    denoise: bool = Form(False),
):
    """Suggest noise_floor (95th pct) and threshold (99th pct) from the same diff as run_bos, assuming the region is mostly background."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # A zero-size ROI means "no selection" — analyze the full image. Same as run_bos,
    # this only scopes which pixels the suggested values are computed from -- there's
    # no image to crop here anyway, just numbers.
    roi_norm = (roi_x, roi_y, roi_w, roi_h) if roi_w > 0 and roi_h > 0 else None

    try:
        diff, _ = compute_diff(ref_bytes, test_bytes, None, align=align, denoise=denoise)
        if roi_norm is not None:
            diff = _crop_diff(diff, roi_norm)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {
        "noise_floor": int(round(float(np.percentile(diff, 95)))),
        "threshold": int(round(float(np.percentile(diff, 99)))),
    }


def _crop_diff(diff, roi_norm: tuple):
    """Crop a full-image diff to a normalized (x, y, w, h) ROI (same clamping as compute_diff)."""
    nx, ny, nw, nh = roi_norm
    H, W = diff.shape
    rx = max(0, min(int(nx * W), W - 1))
    ry = max(0, min(int(ny * H), H - 1))
    rw = min(max(1, int(nw * W)), W - rx)
    rh = min(max(1, int(nh * H)), H - ry)
    return diff[ry:ry + rh, rx:rx + rw]


def _roi_stats(sub, threshold: int) -> dict:
    """Per-ROI stats matching /analyze's definitions (std doubles as the noise proxy for SNR)."""
    return {
        "mean": round(float(sub.mean()), 2),
        "peak": int(round(float(np.percentile(sub, 99)))),
        "std": round(float(sub.std()), 2),
        "coverage": round(float(np.count_nonzero(sub > threshold)) / sub.size * 100.0, 2),
        "pixels": int(sub.size),
    }


def analyze_roi_list(diff, roi_list: list, threshold: int) -> dict:
    """Per-region stats + SNR for named ROIs, shared by /analyze_rois and /analyze. role="background" ROIs set the noise reference. Raises ValueError on a malformed entry."""
    rows = []
    bg_means, bg_stds = [], []
    for i, roi in enumerate(roi_list):
        try:
            roi_norm = (float(roi["x"]), float(roi["y"]), float(roi["w"]), float(roi["h"]))
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"ROI #{i + 1} needs numeric x, y, w, h.")
        role = roi.get("role", "signal")
        name = str(roi.get("name") or f"ROI {i + 1}")

        stats = _roi_stats(_crop_diff(diff, roi_norm), threshold)
        stats["name"] = name
        stats["role"] = role
        rows.append(stats)
        if role == "background":
            bg_means.append(stats["mean"])
            bg_stds.append(stats["std"])

    bg_mean = round(sum(bg_means) / len(bg_means), 2) if bg_means else None
    bg_std = round(sum(bg_stds) / len(bg_stds), 2) if bg_stds else None

    for row in rows:
        row["snr_mean"] = round(row["mean"] / bg_mean, 2) if bg_mean else None
        row["snr_std"] = round(row["mean"] / bg_std, 2) if bg_std else None

    return {
        "rois": rows,
        "background": {"mean": bg_mean, "std": bg_std},
        "threshold": threshold,
    }


@app.post("/analyze_rois")
async def analyze_rois(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    rois: str = Form(...),
    threshold: int = Form(DEFAULT_COVERAGE_THRESHOLD),
    align: bool = Form(False),
    denoise: bool = Form(False),
):
    """Analyze named ROIs (`rois` = JSON list of {name, x, y, w, h, role}) against one shared diff. Display-only, no logging."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        roi_list = json.loads(rois)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="rois must be a valid JSON list.")
    if not isinstance(roi_list, list) or not roi_list:
        raise HTTPException(status_code=400, detail="rois must be a non-empty list.")

    # Full-image diff once; each ROI is just a crop of it.
    try:
        diff, _ = compute_diff(ref_bytes, test_bytes, None, align=align, denoise=denoise)
        return analyze_roi_list(diff, roi_list, threshold)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/diff_preview")
async def diff_preview(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    align: bool = Form(False),
):
    """Return a contrast-stretched diff for placing an ROI (the reference alone shows no jet). Display-only, never used for measurement."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        diff, _ = compute_diff(ref_bytes, test_bytes, None, align=align)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    diff = cv2.medianBlur(diff, MEDIAN_KSIZE)

    # Contrast-stretch to the 2nd-98th percentile so faint jets become visible.
    lo, hi = np.percentile(diff, (2, 98))
    if hi <= lo:
        hi = lo + 1.0
    stretched = np.clip((diff.astype(np.float32) - lo) * (255.0 / (hi - lo)), 0, 255).astype(np.uint8)

    _, buf = cv2.imencode(".png", stretched)
    H, W = diff.shape
    return {
        "preview": base64.b64encode(buf).decode(),
        "width": W,
        "height": H,
    }


app.mount("/static", StaticFiles(directory="static"), name="static")
