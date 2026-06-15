import base64

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="BOS Image Analysis")


def run_bos(ref_bytes: bytes, test_bytes: bytes) -> dict:
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

    diff = cv2.absdiff(ref_gray, test_gray)
    diff_vis = cv2.normalize(diff, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    diff_color = cv2.applyColorMap(diff_vis, cv2.COLORMAP_JET)

    _, gray_buf = cv2.imencode(".png", diff_vis)
    _, color_buf = cv2.imencode(".png", diff_color)

    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
    }


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.post("/analyze")
async def analyze(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
):
    ref_bytes = await reference.read()
    test_bytes = await test.read()
    try:
        result = run_bos(ref_bytes, test_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


app.mount("/static", StaticFiles(directory="static"), name="static")
