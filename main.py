import base64

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

# Default threshold (0-255) above which a pixel counts as "disturbed" for
# coverage. Can be overridden per-request from the UI.
DEFAULT_COVERAGE_THRESHOLD = 30

# Gaussian blur kernel size to reduce sensor noise before differencing.
# Must be odd. Larger = more smoothing.
BLUR_KERNEL = (5, 5)


def run_bos(
    ref_bytes: bytes,
    test_bytes: bytes,
    colormap: str = "JET",
    gain: float = 1.0,
    threshold: int = DEFAULT_COVERAGE_THRESHOLD,
    noise_floor: int = 0,
) -> dict:
    """Compute a BOS difference image.

    gain        : multiplies the raw difference before display. >1 boosts a weak
                  signal (e.g. He, which barely bends light). Applied to the
                  display image only; statistics stay on the true difference.
    threshold   : 0-255 cutoff for the coverage statistic.
    noise_floor : 0-255 cutoff applied to the DISPLAY image. Any pixel whose raw
                  difference is at or below this value is forced to 0 (clean
                  background), so only stronger signal survives. Display-only;
                  statistics stay on the true difference.
    """
    ref_arr = np.frombuffer(ref_bytes, np.uint8)
    test_arr = np.frombuffer(test_bytes, np.uint8)

    ref = cv2.imdecode(ref_arr, cv2.IMREAD_COLOR)
    test = cv2.imdecode(test_arr, cv2.IMREAD_COLOR)

    if ref is None or test is None:
        raise ValueError("Could not decode one or both images. Check the file format.")

    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))

    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    test_gray = cv2.cvtColor(test, cv2.COLOR_BGR2GRAY)

    # Reduce sensor noise before differencing so small per-pixel noise does
    # not show up as fake flow.
    ref_gray = cv2.GaussianBlur(ref_gray, BLUR_KERNEL, 0)
    test_gray = cv2.GaussianBlur(test_gray, BLUR_KERNEL, 0)

    diff = cv2.absdiff(ref_gray, test_gray)

    # Noise floor: zero out everything at or below the floor on the raw diff so
    # weak background noise becomes clean (dark) and only stronger signal
    # survives into the display image. Done before normalize so the surviving
    # signal still stretches across the full display range.
    if noise_floor > 0:
        diff_floored = diff.copy()
        diff_floored[diff_floored <= noise_floor] = 0
    else:
        diff_floored = diff

    # Baseline: min-max normalize to use the full 0-255 display range. This is
    # what makes a normal-strength plume clearly visible.
    diff_disp = cv2.normalize(diff_floored, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

    # Optional gain: multiply on top of the normalized image to push faint
    # mid-tones brighter. Helpful for weak signals (e.g. He) where the
    # interesting structure sits low in the range. Clips at 255.
    if gain != 1.0:
        diff_disp = np.clip(diff_disp.astype(np.float32) * gain, 0, 255).astype(np.uint8)

    diff_vis = diff_disp

    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    _, gray_buf = cv2.imencode(".png", diff_vis)
    _, color_buf = cv2.imencode(".png", diff_color)

    # Statistics computed on the raw difference (0-255), not the display view,
    # so they reflect the true measured signal regardless of gain.
    total = diff.size
    coverage = float(np.count_nonzero(diff > threshold)) / total * 100.0

    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
        "stats": {
            "max": int(diff.max()),
            "mean": round(float(diff.mean()), 2),
            "coverage": round(coverage, 2),
        },
    }


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
):
    ref_bytes = await reference.read()
    test_bytes = await test.read()
    try:
        result = run_bos(
            ref_bytes,
            test_bytes,
            colormap,
            gain=gain,
            threshold=threshold,
            noise_floor=noise_floor,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


app.mount("/static", StaticFiles(directory="static"), name="static")