# ===== Image Processing & Web Framework =====
import base64
import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ===== Data Logging & System =====
import csv
import os
from datetime import datetime

# Initialize FastAPI app
app = FastAPI(title="BOS Image Analysis")

# Available colormap options for visualization
COLORMAPS = {
    "JET": cv2.COLORMAP_JET,
    "TURBO": cv2.COLORMAP_TURBO,
    "VIRIDIS": cv2.COLORMAP_VIRIDIS,
}

# Configuration parameters
DEFAULT_COVERAGE_THRESHOLD = 30  # Default pixel difference threshold for coverage calculation
BLUR_KERNEL = (5, 5)  # Gaussian blur kernel size for noise reduction

# ===== Background Oriented Schlieren (BOS) Analysis Function =====
def run_bos(
    ref_bytes: bytes,
    test_bytes: bytes,
    colormap: str = "JET",
    gain: float = 1.0,
    threshold: int = DEFAULT_COVERAGE_THRESHOLD,
    noise_floor: int = 0,
) -> dict:
    """Process reference and test images to calculate BOS difference."""
    # Decode images from bytes
    ref_arr = np.frombuffer(ref_bytes, np.uint8)
    test_arr = np.frombuffer(test_bytes, np.uint8)

    ref = cv2.imdecode(ref_arr, cv2.IMREAD_COLOR)
    test = cv2.imdecode(test_arr, cv2.IMREAD_COLOR)

    # Validate image decoding
    if ref is None or test is None:
        raise ValueError("Could not decode one or both images. Check the file format.")

    # Ensure both images have same dimensions
    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))

    # Convert to grayscale
    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    test_gray = cv2.cvtColor(test, cv2.COLOR_BGR2GRAY)

    # Apply blur to reduce noise
    ref_gray = cv2.GaussianBlur(ref_gray, BLUR_KERNEL, 0)
    test_gray = cv2.GaussianBlur(test_gray, BLUR_KERNEL, 0)

    # Calculate absolute difference
    diff = cv2.absdiff(ref_gray, test_gray)

    # Apply noise floor (remove weak signals below threshold)
    if noise_floor > 0:
        diff_floored = diff.copy()
        diff_floored[diff_floored <= noise_floor] = 0
    else:
        diff_floored = diff

    # Normalize to 0-255 range
    diff_disp = cv2.normalize(diff_floored, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

    # Apply gain multiplier for brightness enhancement
    if gain != 1.0:
        diff_disp = np.clip(diff_disp.astype(np.float32) * gain, 0, 255).astype(np.uint8)

    # Prepare visualization image
    diff_vis = diff_disp

    # Apply colormap for pseudo-color visualization
    cmap = COLORMAPS.get(colormap.upper(), cv2.COLORMAP_JET)
    diff_color = cv2.applyColorMap(diff_vis, cmap)

    # ===== Add Footer with Analysis Parameters =====
    h, w = diff_vis.shape[:2]
    # Calculate footer height based on image size
    footer_h = max(40, int(h * 0.05))
    
    # Create footer image (grayscale and color versions)
    footer_gray = np.zeros((footer_h, w), dtype=np.uint8)
    footer_color = np.zeros((footer_h, w, 3), dtype=np.uint8)
    
    # Format parameter text
    text = f"Cmap: {colormap.upper()} | Gain: {gain}x | Noise: {noise_floor} | Thresh: {threshold}"
    
    # Configure text rendering
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.5, w / 1200) 
    thickness = max(1, int(w / 1000))
    
    # Calculate text position (center-aligned vertically)
    text_size = cv2.getTextSize(text, font, font_scale, thickness)[0]
    text_x = 20 
    text_y = int(footer_h / 2 + text_size[1] / 2)
    
    # Draw text on footer images
    cv2.putText(footer_gray, text, (text_x, text_y), font, font_scale, 255, thickness, cv2.LINE_AA)
    cv2.putText(footer_color, text, (text_x, text_y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
    
    # Concatenate image and footer
    final_gray = cv2.vconcat([diff_vis, footer_gray])
    final_color = cv2.vconcat([diff_color, footer_color])

    # Encode to PNG format
    _, gray_buf = cv2.imencode(".png", final_gray)
    _, color_buf = cv2.imencode(".png", final_color)

    # Calculate coverage percentage (pixels exceeding threshold)
    total = diff.size
    coverage = float(np.count_nonzero(diff > threshold)) / total * 100.0

    # Return encoded images and statistics
    return {
        "grayscale": base64.b64encode(gray_buf).decode(),
        "color": base64.b64encode(color_buf).decode(),
        "stats": {
            "max": int(diff.max()),
            "mean": round(float(diff.mean()), 2),
            "coverage": round(coverage, 2),
        },
    }

# ===== Experiment Data Logging Function =====
def append_experiment_to_log(data: dict):
    """Write experiment parameters and results to CSV log file."""
    file_path = "experimental_log.csv"
    file_exists = os.path.isfile(file_path)
    
    with open(file_path, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        # Write header row if file is new
        if not file_exists:
            writer.writerow([
                "Date / Time", "Gas Type", "Flow Rate (L/min)", "Plasma Status", "Plasma Condition", 
                "Camera Type", "Focus", "ISO", "Shutter", "Aperture", 
                "Cam Dist (cm)", "Nozzle Dist (cm)", "Lighting", "Notes",
                "Colormap", "Gain", "Noise Floor", "Threshold",
                "Reference File Name", "Test File Name", "Max Diff (0-255)", "Mean Diff (0-255)", "Coverage %"
            ])
        
        # Write experiment data row
        writer.writerow([
            data.get("timestamp", ""), data.get("gas_type", ""), data.get("flow_rate", ""), 
            data.get("plasma_status", ""), data.get("plasma_condition", ""),
            data.get("CamType", ""), data.get("Focus", ""), data.get("Iso", ""), 
            data.get("Shutter", ""), data.get("Aperture", ""),
            data.get("CamDist", ""), data.get("NozDist", ""), data.get("Light", ""), data.get("Notes", ""),
            data.get("colormap", ""), data.get("gain", ""), data.get("noise_floor", ""), data.get("threshold", ""),
            data.get("ref_filename", ""), data.get("test_filename", ""),
            data.get("max_diff", ""), data.get("mean_diff", ""), data.get("coverage", "")
        ])

# ===== API Routes =====
# Serve main page
@app.get("/")
async def root():
    return FileResponse("static/index.html")

# Process image analysis request
@app.post("/analyze")
async def analyze(
    reference: UploadFile = File(...),
    test: UploadFile = File(...),
    colormap: str = Form("JET"),
    gain: float = Form(1.0),
    threshold: int = Form(DEFAULT_COVERAGE_THRESHOLD),
    noise_floor: int = Form(0),
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
    Notes: str = Form("")
):
    # Read uploaded image files
    ref_bytes = await reference.read()
    test_bytes = await test.read()
    
    try:
        # Perform BOS analysis
        result = run_bos(
            ref_bytes, test_bytes, colormap, gain=gain, threshold=threshold, noise_floor=noise_floor
        )
        
        # Prepare log entry with timestamp and all parameters
        log_entry = {
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
            "coverage": result["stats"]["coverage"]
        }
        # Save to CSV log file
        append_experiment_to_log(log_entry)
        
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    
    return result

# Mount static files directory
app.mount("/static", StaticFiles(directory="static"), name="static")