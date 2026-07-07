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
    "is_control", "cam_type", "iso", "shutter", "aperture", "cam_dist", "nozzle_dist",
    "lighting", "notes", "ref_file", "test_file", "colormap", "gain", "noise_floor",
    "threshold", "peak", "mean", "coverage",
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


def compute_diff(ref_bytes: bytes, test_bytes: bytes, roi_norm: tuple = None):
    """Decode ref/test images and return their grayscale absolute difference.

    Shared by run_bos and /suggest_params. roi_norm, if given, is normalized (x, y, w, h) 0-1; both images are cropped to it first.
    """
    ref = cv2.imdecode(np.frombuffer(ref_bytes, np.uint8), cv2.IMREAD_COLOR)
    test = cv2.imdecode(np.frombuffer(test_bytes, np.uint8), cv2.IMREAD_COLOR)
    if ref is None or test is None:
        raise ValueError("Could not decode one or both images. Check the file format.")

    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))

    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    test_gray = cv2.cvtColor(test, cv2.COLOR_BGR2GRAY)

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

    return cv2.absdiff(ref_gray, test_gray)


def run_bos(
    ref_bytes: bytes,
    test_bytes: bytes,
    colormap: str = "JET",
    gain: float = 1.0,
    threshold: int = DEFAULT_COVERAGE_THRESHOLD,
    noise_floor: int = 0,
    roi_norm: tuple = None,
) -> dict:
    """Compute the BOS diff and return rendered images plus stats.

    Stats always come from the raw diff, never the display-adjusted render (colormap/gain/noise_floor).
    """
    diff = compute_diff(ref_bytes, test_bytes, roi_norm)

    # peak = 99th percentile, a robust max that ignores lone noise pixels.
    peak = int(round(float(np.percentile(diff, 99))))
    coverage = float(np.count_nonzero(diff > threshold)) / diff.size * 100.0

    # --- Display rendering (does not affect stats) ---
    render_diff = diff

    if noise_floor > 0:
        render_diff = render_diff.copy()
        render_diff[render_diff <= noise_floor] = 0

    scale = 255.0 / DISPLAY_FULL_SCALE
    diff_vis = np.clip(render_diff.astype(np.float32) * scale * gain, 0, 255).astype(np.uint8)

    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    roi_text = ""
    if roi_norm is not None:
        _, _, nw, nh = roi_norm
        roi_text = f" | ROI: {nw * 100:.0f}%x{nh * 100:.0f}%"
    footer = (
        f"Cmap: {colormap.upper()} | Gain: {gain}x | Noise: {noise_floor} | "
        f"Thresh: {threshold}{roi_text}"
    )

    final_gray = _stamp_footer(diff_vis, footer)
    final_color = _stamp_footer(diff_color, footer)
    _, gray_buf = cv2.imencode(".png", final_gray)
    _, color_buf = cv2.imencode(".png", final_color)

    # Raw view: same scale, but no noise-floor/gain applied.
    raw_vis = np.clip(diff.astype(np.float32) * scale, 0, 255).astype(np.uint8)
    raw_footer = "RAW - no noise floor"
    final_raw = _stamp_footer(raw_vis, raw_footer)
    _, raw_buf = cv2.imencode(".png", final_raw)

    # Thresholded view: matches the same threshold coverage % is counted against.
    thresh_vis = np.where(diff > threshold, 255, 0).astype(np.uint8)
    thresh_footer = f"THRESHOLDED - threshold: {threshold}"
    final_thresh = _stamp_footer(thresh_vis, thresh_footer)
    _, thresh_buf = cv2.imencode(".png", final_thresh)

    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
        "raw": base64.b64encode(raw_buf).decode(),
        "thresholded": base64.b64encode(thresh_buf).decode(),
        "stats": {
            "peak": peak,
            "mean": round(float(diff.mean()), 2),
            "coverage": round(coverage, 2),
        },
    }


def _stamp_footer(img, text):
    """Stamp a parameter footer onto an image (works for gray or BGR)."""
    h, w = img.shape[:2]
    footer_h = max(40, int(h * 0.05))
    if img.ndim == 2:
        footer = np.zeros((footer_h, w), dtype=np.uint8)
        text_color = 255
    else:
        footer = np.zeros((footer_h, w, 3), dtype=np.uint8)
        text_color = (255, 255, 255)

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.5, w / 1200)
    thickness = max(1, int(w / 1000))
    text_h = cv2.getTextSize(text, font, font_scale, thickness)[0][1]
    text_y = int(footer_h / 2 + text_h / 2)

    cv2.putText(footer, text, (20, text_y), font, font_scale, text_color, thickness, cv2.LINE_AA)
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
    CamType: str = Form(""),
    Focus: str = Form(""),
    Iso: str = Form(""),
    Shutter: str = Form(""),
    Aperture: str = Form(""),
    CamDist: str = Form(""),
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
            noise_floor=noise_floor, roi_norm=roi_norm,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # ROI list / line profile sample the full-image diff, independent of the quick-ROI crop above.
    roi_result = None
    line_result = None
    if rois or line:
        diff_full = compute_diff(ref_bytes, test_bytes, None)

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
                line_denoise = bool(line_spec.get("denoise", False))
            except (ValueError, TypeError, KeyError):
                raise HTTPException(status_code=400, detail="line must be JSON {x0,y0,x1,y1,denoise}.")
            try:
                line_result = sample_line_profile(diff_full, lx0, ly0, lx1, ly1, denoise=line_denoise)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            # Echo inputs so the results view carries the values logged below.
            line_result.update({
                "x0": round(lx0, 6), "y0": round(ly0, 6),
                "x1": round(lx1, 6), "y1": round(ly1, 6),
                "denoise": line_denoise,
            })

    # --- Commit this run to the three linked CSVs (one shared run_id) ---
    now = datetime.now()
    run_id = now.strftime("%Y%m%d_%H%M%S")
    timestamp = now.strftime("%Y-%m-%d %H:%M:%S")

    _append_csv(RUNS_FILE, RUNS_HEADER, [[
        run_id, timestamp, gas_type, flow_rate, plasma_status, plasma_condition,
        is_control, CamType, Iso, Shutter, Aperture, CamDist, NozDist,
        Light, Notes, reference.filename, test.filename, colormap, gain, noise_floor,
        threshold,
        result["stats"]["peak"], result["stats"]["mean"], result["stats"]["coverage"],
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
):
    """Suggest noise_floor (95th pct) and threshold (99th pct) from the same diff as run_bos, assuming the region is mostly background."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # A zero-size ROI means "no selection" — analyze the full image.
    roi_norm = (roi_x, roi_y, roi_w, roi_h) if roi_w > 0 and roi_h > 0 else None

    try:
        diff = compute_diff(ref_bytes, test_bytes, roi_norm)
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
        diff = compute_diff(ref_bytes, test_bytes, None)
        return analyze_roi_list(diff, roi_list, threshold)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def sample_line_profile(diff, x0: float, y0: float, x1: float, y1: float,
                        samples: int = 200, denoise: bool = False) -> dict:
    """Sample a diff along a straight line; shared by /line_profile and /analyze.

    width_px is FWHM-style: span around the peak where the smoothed value stays above baseline + (peak - baseline)/2 (baseline = 10th pct). Raises ValueError on a zero-length line.
    """
    cx0, cy0, cx1, cy1 = (max(0.0, min(1.0, v)) for v in (x0, y0, x1, y1))
    if cx0 == cx1 and cy0 == cy1:
        raise ValueError("Line has zero length; drag to draw a line.")
    samples = max(2, samples)

    if denoise:
        diff = cv2.medianBlur(diff, MEDIAN_KSIZE)

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
):
    """Sample the BOS diff along a straight line (full image, no ROI). Display-only, no logging."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        diff = compute_diff(ref_bytes, test_bytes, None)
        return sample_line_profile(diff, x0, y0, x1, y1, samples=samples, denoise=denoise)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/diff_preview")
async def diff_preview(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
):
    """Return a contrast-stretched diff for placing a line profile (the reference alone shows no jet). Display-only, never used for measurement."""
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        diff = compute_diff(ref_bytes, test_bytes, None)
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
