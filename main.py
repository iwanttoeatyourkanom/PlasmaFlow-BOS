import base64
import csv
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

DEFAULT_COVERAGE_THRESHOLD = 30
BLUR_KERNEL = (5, 5)

LOG_FILE = "experimental_log.csv"
LOG_HEADER = [
    "Date / Time", "Gas Type", "Flow Rate (L/min)", "Plasma Status", "Plasma Condition",
    "Camera Type", "Focus", "ISO", "Shutter", "Aperture",
    "Cam Dist (cm)", "Nozzle Dist (cm)", "Lighting", "Notes",
    "Colormap", "Gain", "Noise Floor", "Threshold",
    "Reference File Name", "Test File Name", "Max Diff (0-255)", "Mean Diff (0-255)", "Coverage %",
    "ROI X (norm)", "ROI Y (norm)", "ROI W (norm)", "ROI H (norm)",
]


def run_bos(
    ref_bytes: bytes,
    test_bytes: bytes,
    colormap: str = "JET",
    gain: float = 1.0,
    threshold: int = DEFAULT_COVERAGE_THRESHOLD,
    noise_floor: int = 0,
    roi_norm: tuple = None,
) -> dict:
    """Compute the BOS difference between a reference and test image.

    roi_norm, if given, is (x, y, w, h) in normalized 0-1 coordinates; both
    images are cropped to it before differencing so stats reflect the ROI only.
    Display parameters (colormap, gain, noise_floor) affect the rendered output
    but never the reported stats, which are derived from the raw diff.
    """
    ref = cv2.imdecode(np.frombuffer(ref_bytes, np.uint8), cv2.IMREAD_COLOR)
    test = cv2.imdecode(np.frombuffer(test_bytes, np.uint8), cv2.IMREAD_COLOR)
    if ref is None or test is None:
        raise ValueError("Could not decode one or both images. Check the file format.")

    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))

    ref_gray = cv2.GaussianBlur(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), BLUR_KERNEL, 0)
    test_gray = cv2.GaussianBlur(cv2.cvtColor(test, cv2.COLOR_BGR2GRAY), BLUR_KERNEL, 0)

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

    # --- Display rendering (does not affect stats) ---
    if noise_floor > 0:
        diff_floored = diff.copy()
        diff_floored[diff_floored <= noise_floor] = 0
    else:
        diff_floored = diff

    diff_vis = cv2.normalize(diff_floored, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    if gain != 1.0:
        diff_vis = np.clip(diff_vis.astype(np.float32) * gain, 0, 255).astype(np.uint8)

    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    final_gray, final_color = _add_param_footer(
        diff_vis, diff_color, colormap, gain, noise_floor, threshold, roi_norm
    )
    _, gray_buf = cv2.imencode(".png", final_gray)
    _, color_buf = cv2.imencode(".png", final_color)

    # Coverage is measured on the raw diff, before noise floor/gain/normalize.
    coverage = float(np.count_nonzero(diff > threshold)) / diff.size * 100.0

    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
        "stats": {
            "max": int(diff.max()),
            "mean": round(float(diff.mean()), 2),
            "coverage": round(coverage, 2),
        },
    }


def _add_param_footer(diff_vis, diff_color, colormap, gain, noise_floor, threshold, roi_norm):
    """Stamp a footer with the analysis parameters onto both output images."""
    h, w = diff_vis.shape[:2]
    footer_h = max(40, int(h * 0.05))
    footer_gray = np.zeros((footer_h, w), dtype=np.uint8)
    footer_color = np.zeros((footer_h, w, 3), dtype=np.uint8)

    roi_text = ""
    if roi_norm is not None:
        _, _, nw, nh = roi_norm
        roi_text = f" | ROI: {nw * 100:.0f}%x{nh * 100:.0f}%"
    text = f"Cmap: {colormap.upper()} | Gain: {gain}x | Noise: {noise_floor} | Thresh: {threshold}{roi_text}"

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.5, w / 1200)
    thickness = max(1, int(w / 1000))
    text_h = cv2.getTextSize(text, font, font_scale, thickness)[0][1]
    text_y = int(footer_h / 2 + text_h / 2)

    cv2.putText(footer_gray, text, (20, text_y), font, font_scale, 255, thickness, cv2.LINE_AA)
    cv2.putText(footer_color, text, (20, text_y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

    return cv2.vconcat([diff_vis, footer_gray]), cv2.vconcat([diff_color, footer_color])


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
            noise_floor=noise_floor, roi_norm=roi_norm,
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
        "max_diff": result["stats"]["max"],
        "mean_diff": result["stats"]["mean"],
        "coverage": result["stats"]["coverage"],
        "roi_x": round(roi_x, 6) if roi_norm else "",
        "roi_y": round(roi_y, 6) if roi_norm else "",
        "roi_w": round(roi_w, 6) if roi_norm else "",
        "roi_h": round(roi_h, 6) if roi_norm else "",
    })

    return result


app.mount("/static", StaticFiles(directory="static"), name="static")
