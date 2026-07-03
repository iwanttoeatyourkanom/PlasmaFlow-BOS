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
# Kernel for the median filter applied to the diff when noise reduction is on.
# Median removes single-pixel speckle well without smearing the gas jet the way
# a Gaussian blur would.
MEDIAN_KSIZE = 5

# Raw diff value that maps to full white when rendering. Using a FIXED scale
# (instead of cv2.normalize's per-image min/max) means display brightness tracks
# the actual diff magnitude: turning on noise reduction then reads as a cleaner
# image rather than a brighter one, and different experiments become comparable
# at the same intensity. Tuned so a faint He gas jet stays clearly visible;
# lower this to brighten weak signals (e.g. Ar), raise it to compress bright ones.
DISPLAY_FULL_SCALE = 64

LOG_FILE = "experimental_log.csv"
LOG_HEADER = [
    "Date / Time", "Gas Type", "Flow Rate (L/min)", "Plasma Status", "Plasma Condition",
    "Camera Type", "Focus", "ISO", "Shutter", "Aperture",
    "Cam Dist (cm)", "Nozzle Dist (cm)", "Lighting", "Notes",
    "Colormap", "Gain", "Noise Floor", "Threshold",
    "Reference File Name", "Test File Name", "Peak Diff p99 (0-255)", "Mean Diff (0-255)", "Coverage %",
    "ROI X (norm)", "ROI Y (norm)", "ROI W (norm)", "ROI H (norm)",
    "Denoise",
]


def compute_diff(ref_bytes: bytes, test_bytes: bytes, roi_norm: tuple = None):
    """Decode ref/test images and return their grayscale absolute difference.

    Shared by run_bos and /suggest_params so the suggested noise floor/threshold
    are computed from exactly the same diff that analysis uses. roi_norm, if given,
    is (x, y, w, h) in normalized 0-1 coordinates; both images are cropped to it
    before differencing.
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
    denoise: bool = True,
) -> dict:
    """Compute the BOS difference between a reference and test image.

    roi_norm, if given, is (x, y, w, h) in normalized 0-1 coordinates; both
    images are cropped to it before differencing so stats reflect the ROI only.

    Display parameters (colormap, gain, noise_floor, denoise) affect the rendered
    grayscale/pseudo-color output but never the reported stats, which are always
    derived from the raw diff. When `denoise` is on, a median filter is applied to
    the diff before rendering only (removes single-pixel speckle without smearing
    the gas jet).
    """
    diff = compute_diff(ref_bytes, test_bytes, roi_norm)

    # Stats come from the raw diff, before denoise/noise floor/gain/normalize.
    # "peak" is the 99th percentile, a robust max: it reports the strong-signal
    # level while ignoring lone noise pixels that would otherwise set diff.max().
    peak = int(round(float(np.percentile(diff, 99))))
    coverage = float(np.count_nonzero(diff > threshold)) / diff.size * 100.0

    # --- Display rendering (does not affect stats) ---
    # Median filter only smooths the rendered image, not the numbers above.
    render_diff = cv2.medianBlur(diff, MEDIAN_KSIZE) if denoise else diff

    if noise_floor > 0:
        render_diff = render_diff.copy()
        render_diff[render_diff <= noise_floor] = 0

    # Fixed-scale mapping (not per-image min/max): brightness reflects the real
    # diff magnitude, so denoise cleans the image instead of just brightening it.
    scale = 255.0 / DISPLAY_FULL_SCALE
    diff_vis = np.clip(render_diff.astype(np.float32) * scale * gain, 0, 255).astype(np.uint8)

    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    roi_text = ""
    if roi_norm is not None:
        _, _, nw, nh = roi_norm
        roi_text = f" | ROI: {nw * 100:.0f}%x{nh * 100:.0f}%"
    denoise_text = "ON" if denoise else "OFF"
    footer = (
        f"Cmap: {colormap.upper()} | Gain: {gain}x | Noise: {noise_floor} | "
        f"Thresh: {threshold} | Denoise: {denoise_text}{roi_text}"
    )

    final_gray = _stamp_footer(diff_vis, footer)
    final_color = _stamp_footer(diff_color, footer)
    _, gray_buf = cv2.imencode(".png", final_gray)
    _, color_buf = cv2.imencode(".png", final_color)

    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
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


def append_experiment_to_log(data: dict):
    """Append one experiment row to the CSV log, writing the header on first use."""
    file_exists = os.path.isfile(LOG_FILE)
    with open(LOG_FILE, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(LOG_HEADER)
        writer.writerow([
            data.get("timestamp", ""), data.get("gas_type", ""), data.get("flow_rate", ""),
            data.get("plasma_status", ""), data.get("plasma_condition", ""),
            data.get("CamType", ""), data.get("Focus", ""), data.get("Iso", ""),
            data.get("Shutter", ""), data.get("Aperture", ""),
            data.get("CamDist", ""), data.get("NozDist", ""), data.get("Light", ""), data.get("Notes", ""),
            data.get("colormap", ""), data.get("gain", ""), data.get("noise_floor", ""), data.get("threshold", ""),
            data.get("ref_filename", ""), data.get("test_filename", ""),
            data.get("max_diff", ""), data.get("mean_diff", ""), data.get("coverage", ""),
            data.get("roi_x", ""), data.get("roi_y", ""), data.get("roi_w", ""), data.get("roi_h", ""),
            data.get("denoise", ""),
        ])


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
    denoise: bool = Form(True),
    roi_x: float = Form(0.0),
    roi_y: float = Form(0.0),
    roi_w: float = Form(0.0),
    roi_h: float = Form(0.0),
    gas_type: str = Form("None"),
    flow_rate: str = Form(""),
    plasma_status: str = Form("OFF"),
    plasma_condition: str = Form(""),
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
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # A zero-size ROI means "no selection" — analyze the full image.
    roi_norm = (roi_x, roi_y, roi_w, roi_h) if roi_w > 0 and roi_h > 0 else None

    try:
        result = run_bos(
            ref_bytes, test_bytes, colormap, gain=gain, threshold=threshold,
            noise_floor=noise_floor, roi_norm=roi_norm, denoise=denoise,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    append_experiment_to_log({
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "gas_type": gas_type,
        "flow_rate": flow_rate,
        "plasma_status": plasma_status,
        "plasma_condition": plasma_condition,
        "CamType": CamType, "Focus": Focus, "Iso": Iso, "Shutter": Shutter, "Aperture": Aperture,
        "CamDist": CamDist, "NozDist": NozDist, "Light": Light, "Notes": Notes,
        "colormap": colormap, "gain": gain, "noise_floor": noise_floor, "threshold": threshold,
        "ref_filename": reference.filename,
        "test_filename": test.filename,
        "max_diff": result["stats"]["peak"],
        "mean_diff": result["stats"]["mean"],
        "coverage": result["stats"]["coverage"],
        "roi_x": round(roi_x, 6) if roi_norm else "",
        "roi_y": round(roi_y, 6) if roi_norm else "",
        "roi_w": round(roi_w, 6) if roi_norm else "",
        "roi_h": round(roi_h, 6) if roi_norm else "",
        "denoise": "ON" if denoise else "OFF",
    })

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
    """Suggest a noise floor and coverage threshold from the diff image.

    Uses the same diff as run_bos (decode -> resize -> gray -> ROI crop -> absdiff),
    then sets noise_floor to the 95th percentile and threshold to the 99th
    percentile — just above the background noise level, assuming the analyzed
    region is mostly background.
    """
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
    """Crop a full-image diff to a normalized (x, y, w, h) ROI.

    Uses the same clamping as compute_diff so a slightly out-of-range selection
    stays valid. Cropping the shared diff (instead of re-differencing per ROI)
    keeps every region's numbers consistent with /analyze.
    """
    nx, ny, nw, nh = roi_norm
    H, W = diff.shape
    rx = max(0, min(int(nx * W), W - 1))
    ry = max(0, min(int(ny * H), H - 1))
    rw = min(max(1, int(nw * W)), W - rx)
    rh = min(max(1, int(nh * H)), H - ry)
    return diff[ry:ry + rh, rx:rx + rw]


def _roi_stats(sub, threshold: int) -> dict:
    """Per-ROI stats from a cropped diff, matching /analyze's definitions.

    peak is the 99th percentile (robust max); coverage is the % of pixels above
    threshold; std is the diff spread, used as a noise proxy for the SNR value.
    """
    return {
        "mean": round(float(sub.mean()), 2),
        "peak": int(round(float(np.percentile(sub, 99)))),
        "std": round(float(sub.std()), 2),
        "coverage": round(float(np.count_nonzero(sub > threshold)) / sub.size * 100.0, 2),
        "pixels": int(sub.size),
    }


@app.post("/analyze_rois")
async def analyze_rois(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    rois: str = Form(...),
    threshold: int = Form(DEFAULT_COVERAGE_THRESHOLD),
):
    """Analyze several named ROIs against one shared diff.

    The full-image diff is computed ONCE, then cropped per ROI so every region's
    numbers come from exactly the diff /analyze would produce (no re-differencing).
    ROIs tagged role="background" set the noise level: their mean/std are averaged
    into bg_mean/bg_std, and every ROI gets an SNR-like value — roi_mean / bg_mean
    and roi_mean / bg_std. `rois` is a JSON list of {name, x, y, w, h, role}.
    """
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
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # First pass: crop + stats for every ROI, collecting the background means/stds.
    rows = []
    bg_means, bg_stds = [], []
    for i, roi in enumerate(roi_list):
        try:
            roi_norm = (float(roi["x"]), float(roi["y"]), float(roi["w"]), float(roi["h"]))
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"ROI #{i + 1} needs numeric x, y, w, h.")
        role = roi.get("role", "signal")
        name = str(roi.get("name") or f"ROI {i + 1}")

        stats = _roi_stats(_crop_diff(diff, roi_norm), threshold)
        stats["name"] = name
        stats["role"] = role
        rows.append(stats)
        if role == "background":
            bg_means.append(stats["mean"])
            bg_stds.append(stats["std"])

    # Average the background ROIs into one noise reference (None if none tagged).
    bg_mean = round(sum(bg_means) / len(bg_means), 2) if bg_means else None
    bg_std = round(sum(bg_stds) / len(bg_stds), 2) if bg_stds else None

    # Second pass: SNR-like ratios against the background (guard divide-by-zero).
    for row in rows:
        row["snr_mean"] = round(row["mean"] / bg_mean, 2) if bg_mean else None
        row["snr_std"] = round(row["mean"] / bg_std, 2) if bg_std else None

    return {
        "rois": rows,
        "background": {"mean": bg_mean, "std": bg_std},
        "threshold": threshold,
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
    """Sample the BOS diff along a straight line and return the intensity profile.

    Uses the same diff as /analyze (full image, no ROI). The endpoints are
    normalized 0-1; the diff is sampled at `samples` evenly spaced points with
    bilinear interpolation. A moving-average copy is returned alongside the raw
    values so a jet's two-edge (shear-layer) structure — two peaks with a dip
    between them — is easier to read on the chart.
    """
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    # Clamp endpoints into [0,1] and require a line with real length.
    cx0, cy0, cx1, cy1 = (max(0.0, min(1.0, v)) for v in (x0, y0, x1, y1))
    if cx0 == cx1 and cy0 == cy1:
        raise HTTPException(status_code=400, detail="Line has zero length; drag to draw a line.")
    samples = max(2, samples)

    try:
        diff = compute_diff(ref_bytes, test_bytes, None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if denoise:
        diff = cv2.medianBlur(diff, MEDIAN_KSIZE)

    H, W = diff.shape
    # Normalized -> pixel coords, using the last valid index so both ends stay in bounds.
    px0, px1 = cx0 * (W - 1), cx1 * (W - 1)
    py0, py1 = cy0 * (H - 1), cy1 * (H - 1)
    xs = np.linspace(px0, px1, samples).astype(np.float32).reshape(1, -1)
    ys = np.linspace(py0, py1, samples).astype(np.float32).reshape(1, -1)

    # Bilinear sample along the line (remap wants 2D maps, so use a single row).
    sampled = cv2.remap(
        diff.astype(np.float32), xs, ys,
        interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE,
    )[0]

    # Light moving average (window 5) to bring out the two-edge dip.
    kernel = np.ones(5, dtype=np.float32) / 5.0
    smoothed = np.convolve(sampled, kernel, mode="same")

    length_px = float(np.hypot(px1 - px0, py1 - py0))

    return {
        "values": [round(float(v), 1) for v in sampled],
        "smoothed": [round(float(v), 1) for v in smoothed],
        "peak": int(round(float(np.percentile(sampled, 99)))),
        "mean": round(float(sampled.mean()), 2),
        "length_px": int(round(length_px)),
        "samples": samples,
    }


@app.post("/diff_preview")
async def diff_preview(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
):
    """Return a contrast-stretched diff image for placing a line profile.

    The Reference image (flow OFF) shows no jet, so drawing a line over it is
    blind. This gives the frontend a DISPLAY-ONLY background where the jet is
    visible: the full-frame diff clipped to its 2nd-98th percentile and scaled
    to 0-255. The stretch is intentionally aggressive for visibility and is
    NEVER fed into measurements (unlike the fixed-scale render in run_bos);
    /line_profile still samples the raw diff via compute_diff.
    """
    ref_bytes = await reference.read()
    test_bytes = await test.read()

    try:
        diff = compute_diff(ref_bytes, test_bytes, None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Calm speckle so the jet reads more clearly (display-only, like run_bos).
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
