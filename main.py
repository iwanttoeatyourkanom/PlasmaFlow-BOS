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

DEFAULT_COVERAGE_THRESHOLD = 12
# Median kernel for /line_profile's denoise and /diff_preview's smoothing (removes speckle without smearing the jet).
MEDIAN_KSIZE = 5

# Fixed (not per-image min/max) diff->white scale, so brightness stays comparable across experiments.
DISPLAY_FULL_SCALE = 64

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
LINE_PROFILES_FILE = "line_profiles.csv"
LINE_PROFILES_HEADER = [
    "run_id", "x0", "y0", "x1", "y1", "length_px", "peak", "mean", "width_px", "denoise",
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
    """(dx, dy) shift of test_patch relative to ref_patch via phase correlation."""
    win = cv2.createHanningWindow((ref_patch.shape[1], ref_patch.shape[0]), cv2.CV_32F)
    (dx, dy), _ = cv2.phaseCorrelate(ref_patch.astype(np.float32), test_patch.astype(np.float32), win)
    return dx, dy


def _estimate_shift(ref_gray: np.ndarray, test_gray: np.ndarray) -> dict:
    """Estimate a whole-frame rigid shift from the four corner patches only.

    The jet's own real signal lives away from the corners, so corner-only patches avoid
    letting the BOS signal bias the shift estimate (and then get subtracted out as noise).
    Returns the median (dx, dy) across corners plus each corner's own estimate for transparency.
    """
    H, W = ref_gray.shape
    ch, cw = max(1, int(H * CORNER_FRACTION)), max(1, int(W * CORNER_FRACTION))
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

    Shared by run_bos, /suggest_params, /analyze_rois, /line_profile, /diff_preview. roi_norm,
    if given, is normalized (x, y, w, h) 0-1; both images are cropped to it first. If align is
    True, a whole-frame translation (measured from the four corners only, see _estimate_shift)
    is applied to test before diffing, and shift_info is the returned dict; otherwise shift_info
    is None and behavior is bit-identical to before this option existed.

    If denoise is True, a median blur (MEDIAN_KSIZE) is applied to the diff itself before it's
    returned -- like align, this is a real preprocessing step (it changes peak/mean/coverage,
    not just the rendered image), distinct from the display-only noise_floor slider. Skipped on
    crops smaller than the kernel (e.g. a tiny ROI) rather than raising. This is separate from
    /line_profile's own per-line denoise toggle, which blurs its own full-image diff independently.
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
) -> dict:
    """Compute the BOS diff and return rendered images plus stats.

    Stats always come from the raw diff (after align/denoise preprocessing, if enabled), never
    the display-adjusted render (colormap/gain/noise_floor).

    roi_norm no longer crops any pixels out of the rendered images -- every run's grayscale/
    color/raw/thresholded output is always the full frame, so jet position and framing stay
    comparable across runs (needed to check repeatability). roi_norm still scopes what the
    peak/mean/coverage stats are computed from: if given, they're computed from just that
    region of the diff via _crop_diff, same numbers as before, just no longer tied to what
    the image shows.
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
    # comparing it against the main grayscale/color/thresholded views. Recomputed from
    # scratch (full frame, same as diff_full above) rather than reusing `diff_full`,
    # since `diff_full` already has align/denoise baked in when those are on. Stats
    # still scoped to roi_norm, same as the main stats above; the image itself is full.
    diff_raw_full, _ = compute_diff(ref_bytes, test_bytes, None, align=False, denoise=False)
    raw_stats_diff = _crop_diff(diff_raw_full, roi_norm) if roi_norm is not None else diff_raw_full
    raw_peak = int(round(float(np.percentile(raw_stats_diff, 99))))
    raw_mean = round(float(raw_stats_diff.mean()), 2)
    raw_vis = np.clip(diff_raw_full.astype(np.float32) * scale, 0, 255).astype(np.uint8)
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

    return {
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
    line: str = Form(""),
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
    """Run the main BOS analysis and commit one run to runs.csv (plus roi_regions.csv / line_profiles.csv if `rois` / `line` are sent)."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # A zero-size ROI means "no selection" — analyze the full image.
    roi_norm = (roi_x, roi_y, roi_w, roi_h) if roi_w > 0 and roi_h > 0 else None

    try:
        result = run_bos(
            ref_bytes, test_bytes, colormap, gain=gain, threshold=threshold,
            noise_floor=noise_floor, roi_norm=roi_norm, align=align, denoise=denoise,
            control_peak=control_peak, control_mean=control_mean,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # ROI list / line profile sample the full-image diff, independent of the quick-ROI crop above.
    roi_result = None
    line_result = None
    if rois or line:
        diff_full, _ = compute_diff(ref_bytes, test_bytes, None, align=align, denoise=denoise)

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

        if line:
            try:
                line_spec = json.loads(line)
                lx0, ly0 = float(line_spec["x0"]), float(line_spec["y0"])
                lx1, ly1 = float(line_spec["x1"]), float(line_spec["y1"])
            except (ValueError, TypeError, KeyError):
                raise HTTPException(status_code=400, detail="line must be JSON {x0,y0,x1,y1}.")
            try:
                line_result = sample_line_profile(diff_full, lx0, ly0, lx1, ly1)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            # Echo inputs, plus the run's denoise setting (line sampling no longer has
            # its own separate toggle -- it just samples diff_full, which already went
            # through compute_diff with this run's denoise setting above).
            line_result.update({
                "x0": round(lx0, 6), "y0": round(ly0, 6),
                "x1": round(lx1, 6), "y1": round(ly1, 6),
                "denoise": denoise,
            })

    # --- Commit this run to the three linked CSVs (one shared run_id) ---
    now = datetime.now()
    run_id = now.strftime("%Y%m%d_%H%M%S")
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

    if line_result:
        _append_csv(LINE_PROFILES_FILE, LINE_PROFILES_HEADER, [[
            run_id, line_result["x0"], line_result["y0"], line_result["x1"], line_result["y1"],
            line_result["length_px"], line_result["peak"], line_result["mean"],
            line_result["width_px"], "ON" if line_result["denoise"] else "OFF",
        ]])

    result["run_id"] = run_id
    result["datetime"] = timestamp
    result["rois"] = roi_result
    result["line"] = line_result
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


def sample_line_profile(diff, x0: float, y0: float, x1: float, y1: float,
                        samples: int = 200) -> dict:
    """Sample a diff along a straight line; shared by /line_profile and /analyze.

    Takes whatever diff it's given as-is (denoise, if wanted, should already be baked
    in via compute_diff -- this used to also take its own separate denoise flag and
    median-blur again here, which double-blurred when the run's main denoise was also
    on; removed in favor of one denoise setting per run). The 15-sample moving average
    below is a separate, always-on smoothing of the *sampled curve* for a readable
    peak/width, not of the 2D image.

    width_px is FWHM-style: span around the peak where the smoothed value stays above baseline + (peak - baseline)/2 (baseline = 10th pct). Raises ValueError on a zero-length line.
    """
    cx0, cy0, cx1, cy1 = (max(0.0, min(1.0, v)) for v in (x0, y0, x1, y1))
    if cx0 == cx1 and cy0 == cy1:
        raise ValueError("Line has zero length; drag to draw a line.")
    samples = max(2, samples)

    H, W = diff.shape
    px0, px1 = cx0 * (W - 1), cx1 * (W - 1)
    py0, py1 = cy0 * (H - 1), cy1 * (H - 1)
    xs = np.linspace(px0, px1, samples).astype(np.float32).reshape(1, -1)
    ys = np.linspace(py0, py1, samples).astype(np.float32).reshape(1, -1)

    # remap wants 2D maps, so use a single row for this 1D line sample.
    sampled = cv2.remap(
        diff.astype(np.float32), xs, ys,
        interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE,
    )[0]

    # Wide window (15) to suppress noise on faint signals.
    window_size = 15
    kernel = np.ones(window_size, dtype=np.float32) / float(window_size)
    smoothed = np.convolve(sampled, kernel, mode="same")

    length_px = int(round(float(np.hypot(px1 - px0, py1 - py0))))

    # Ignore the outer 5% so an endpoint edge/noise spike can't steal the peak.
    n = samples
    margin = max(1, int(n * 0.05))
    inner = smoothed[margin:n - margin]
    p_idx = margin + int(np.argmax(inner)) if inner.size else min(margin, n - 1)

    baseline = float(np.sort(smoothed)[int(0.1 * (n - 1))])
    half_max = baseline + (float(smoothed[p_idx]) - baseline) / 2.0
    w_lo = w_hi = p_idx
    while w_lo > 0 and smoothed[w_lo - 1] >= half_max:
        w_lo -= 1
    while w_hi < n - 1 and smoothed[w_hi + 1] >= half_max:
        w_hi += 1
    width_px = int(round((w_hi - w_lo) / (n - 1) * length_px))

    return {
        "values": [round(float(v), 1) for v in sampled],
        "smoothed": [round(float(v), 1) for v in smoothed],
        "peak": int(round(float(np.percentile(sampled, 99)))),
        "mean": round(float(sampled.mean()), 2),
        "length_px": length_px,
        "samples": samples,
        "width_px": width_px,
    }


@app.post("/line_profile")
async def line_profile(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    x0: float = Form(...),
    y0: float = Form(...),
    x1: float = Form(...),
    y1: float = Form(...),
    samples: int = Form(200),
    denoise: bool = Form(False),
    align: bool = Form(False),
):
    """Sample the BOS diff along a straight line (full image, no ROI). Display-only, no logging.

    `denoise` here is the same run-wide setting as everywhere else (see compute_diff) -- this
    endpoint used to take a separate line-only denoise flag applied inside sample_line_profile;
    that's gone, so the live preview now matches whatever Analyze will actually compute.
    """
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        diff, _ = compute_diff(ref_bytes, test_bytes, None, align=align, denoise=denoise)
        return sample_line_profile(diff, x0, y0, x1, y1, samples=samples)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/diff_preview")
async def diff_preview(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    align: bool = Form(False),
):
    """Return a contrast-stretched diff for placing a line profile (the reference alone shows no jet). Display-only, never used for measurement."""
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
