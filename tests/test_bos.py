"""
Regression tests for PlasmaFlow-BOS.

Run from the project root (the folder that contains main.py and static/):

    python -m pytest tests            # if pytest is installed
    python tests/test_bos.py          # plain runner, no pytest needed

The endpoint tests redirect the app's CSV log paths to a temporary folder, so
running the suite never appends to your real runs.csv / roi_regions.csv /
line_profiles.csv.

Covers: the diff pipeline, alignment safety on odd inputs, line-profile math,
ROI/SNR stats, and every HTTP endpoint including the graceful-error paths.
"""

import importlib.util
import os
import re
import tempfile

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Load main.py from the project root (works no matter where pytest is invoked,
# as long as the CWD is the project root so StaticFiles("static") resolves).
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_OLD_CWD = os.getcwd()
os.chdir(_ROOT)
_spec = importlib.util.spec_from_file_location("bos_main", os.path.join(_ROOT, "main.py"))
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)

# Redirect CSV writes to a throwaway dir so tests never touch real data.
_TMP = tempfile.mkdtemp(prefix="bos_tests_")
m.RUNS_FILE = os.path.join(_TMP, "runs.csv")
m.ROI_REGIONS_FILE = os.path.join(_TMP, "roi_regions.csv")
m.LINE_PROFILES_FILE = os.path.join(_TMP, "line_profiles.csv")

_RNG = np.random.default_rng(1234)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _noise(h, w, ch=3):
    shape = (h, w, ch) if ch else (h, w)
    return _RNG.integers(0, 255, shape).astype(np.uint8)


def _png(img):
    return cv2.imencode(".png", img)[1].tobytes()


def _pair_with_band(h=240, w=320, boost=60, band=(80, 160, 150, 172)):
    """Reference + test where test has a bright vertical band (a fake jet)."""
    base = _noise(h, w)
    test = base.copy()
    y0, y1, x0, x1 = band
    test[y0:y1, x0:x1] = np.clip(test[y0:y1, x0:x1].astype(int) + boost, 0, 255).astype(np.uint8)
    return _png(base), _png(test), (x1 - x0)


def _client():
    from starlette.testclient import TestClient
    return TestClient(m.app)


def _has_testclient():
    try:
        import httpx  # noqa: F401
        from starlette.testclient import TestClient  # noqa: F401
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# compute_diff
# ---------------------------------------------------------------------------
def test_compute_diff_basic_shapes():
    ref, test, _ = _pair_with_band()
    diff, shift = m.compute_diff(ref, test, None, align=False, denoise=False)
    assert diff.ndim == 2 and diff.dtype == np.uint8
    assert shift is None


def test_compute_diff_mismatched_sizes_resizes():
    ref = _png(_noise(200, 300))
    test = _png(_noise(150, 240))
    diff, _ = m.compute_diff(ref, test, None, align=True, denoise=True)
    assert diff.shape == (200, 300)  # diff follows the reference size


def test_compute_diff_grayscale_input():
    g1 = _noise(200, 300, ch=None)
    g2 = g1.copy()
    g2[50:100, 100:140] = np.clip(g2[50:100, 100:140].astype(int) + 50, 0, 255).astype(np.uint8)
    diff, _ = m.compute_diff(_png(g1), _png(g2), None, align=True)
    assert diff.shape == (200, 300)


def test_compute_diff_bad_bytes_raises():
    try:
        m.compute_diff(b"not an image", b"still not", None)
        assert False, "expected ValueError"
    except ValueError:
        pass


# ---------------------------------------------------------------------------
# alignment safety (regression for the small-image crash)
# ---------------------------------------------------------------------------
def test_align_tiny_images_do_not_crash():
    for size in [(1, 1), (3, 3), (2, 50), (13, 13)]:
        ref = _png(_noise(*size))
        diff, shift = m.compute_diff(ref, ref, None, align=True)
        assert shift is not None
        assert np.isfinite(shift["dx"]) and np.isfinite(shift["dy"])


def test_align_flat_image_finite():
    flat = _png(np.full((200, 300, 3), 128, np.uint8))
    _, shift = m.compute_diff(flat, flat, None, align=True)
    assert np.isfinite(shift["dx"]) and np.isfinite(shift["dy"])


def test_align_detects_real_shift():
    big = _noise(200, 300)
    shifted = np.roll(big, 4, axis=1)
    _, shift = m.compute_diff(_png(big), _png(shifted), None, align=True)
    assert abs(shift["dx"]) > 1.0  # a ~4 px horizontal shift is detected


# ---------------------------------------------------------------------------
# run_bos
# ---------------------------------------------------------------------------
def test_run_bos_returns_tuple_and_keys():
    ref, test, _ = _pair_with_band()
    result, diff = m.run_bos(ref, test, "JET", align=True, denoise=True)
    assert diff is not None
    for k in ("grayscale", "color", "raw", "thresholded", "stats", "image_width", "image_height"):
        assert k in result
    for k in ("peak", "mean", "coverage"):
        assert k in result["stats"]


def test_run_bos_control_footer_ok():
    ref, test, _ = _pair_with_band()
    result, _ = m.run_bos(ref, test, "JET", control_peak=20, control_mean=3.5)
    assert result["stats"]["peak"] >= 0


def _decoded_width(b64_png):
    import base64
    arr = cv2.imdecode(np.frombuffer(base64.b64decode(b64_png), np.uint8), cv2.IMREAD_COLOR)
    return arr.shape[1]


def test_raw_view_downscaled_but_main_images_full_res():
    # A wide image so the raw view exceeds the cap.
    base = _noise(400, 2400)
    test = base.copy()
    test[100:300, 1000:1100] = np.clip(test[100:300, 1000:1100].astype(int) + 50, 0, 255).astype(np.uint8)
    result, _ = m.run_bos(_png(base), _png(test), "JET", align=True, denoise=True)
    # raw is a display-only reference: capped in width
    assert _decoded_width(result["raw"]) <= m.RAW_DISPLAY_MAX_W
    # grayscale/color stay full width (overlay + zoom math depends on this)
    assert result["image_width"] == 2400
    assert _decoded_width(result["grayscale"]) == 2400
    assert _decoded_width(result["color"]) == 2400


def test_run_bos_stats_match_manual_roi():
    base = _noise(200, 300)
    test = base.copy()
    test[60:140, 120:180] = np.clip(test[60:140, 120:180].astype(int) + 40, 0, 255).astype(np.uint8)
    roi = (0.4, 0.3, 0.2, 0.4)
    result, _ = m.run_bos(_png(base), _png(test), "JET", roi_norm=roi, align=False, denoise=False)
    diff = cv2.absdiff(cv2.cvtColor(base, cv2.COLOR_BGR2GRAY), cv2.cvtColor(test, cv2.COLOR_BGR2GRAY))
    manual = round(float(m._crop_diff(diff, roi).mean()), 2)
    assert abs(result["stats"]["mean"] - manual) < 0.01


# ---------------------------------------------------------------------------
# sample_line_profile
# ---------------------------------------------------------------------------
def test_line_profile_anchors_and_peak_consistency():
    ref, test, band_px = _pair_with_band()
    diff, _ = m.compute_diff(ref, test, None, align=True, denoise=True)
    lp = m.sample_line_profile(diff, 0.1, 0.5, 0.9, 0.5)
    for k in ("peak", "mean", "length_px", "width_px", "peak_index",
              "baseline", "half_max", "width_lo", "width_hi", "values", "smoothed", "samples"):
        assert k in lp, k
    # peak label must equal the smoothed value at the marked index (chart matches numbers)
    assert lp["peak"] == int(round(lp["smoothed"][lp["peak_index"]]))
    # width band brackets the peak
    assert 0 <= lp["width_lo"] <= lp["peak_index"] <= lp["width_hi"] < lp["samples"]
    # measured width is in the right neighbourhood of the real band
    assert abs(lp["width_px"] - band_px) <= max(6, 0.4 * band_px)


def test_line_profile_zero_length_raises():
    diff, _ = m.compute_diff(*_pair_with_band()[:2], roi_norm=None)
    try:
        m.sample_line_profile(diff, 0.5, 0.5, 0.5, 0.5)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_line_profile_all_zero_diff_is_finite():
    same = _png(_noise(200, 300))
    diff, _ = m.compute_diff(same, same, None)
    lp = m.sample_line_profile(diff, 0.1, 0.5, 0.9, 0.5)
    assert np.isfinite(lp["peak"]) and np.isfinite(lp["width_px"])


# ---------------------------------------------------------------------------
# analyze_roi_list / _crop_diff
# ---------------------------------------------------------------------------
def test_roi_list_snr_and_background():
    ref, test, _ = _pair_with_band()
    diff, _ = m.compute_diff(ref, test, None, align=True)
    rois = [
        {"name": "jet", "role": "signal", "x": 0.45, "y": 0.30, "w": 0.10, "h": 0.35},
        {"name": "bg", "role": "background", "x": 0.02, "y": 0.02, "w": 0.20, "h": 0.20},
    ]
    out = m.analyze_roi_list(diff, rois, 12)
    assert len(out["rois"]) == 2
    assert out["background"]["mean"] is not None


def test_roi_list_malformed_raises():
    diff, _ = m.compute_diff(*_pair_with_band()[:2], roi_norm=None)
    try:
        m.analyze_roi_list(diff, [{"name": "a", "role": "signal"}], 12)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_crop_diff_clamps_out_of_bounds():
    diff = _noise(120, 160, ch=None)
    sub = m._crop_diff(diff, (2.0, 2.0, 0.5, 0.5))  # fully out of bounds
    assert sub.size >= 1  # clamped, never empty


# ---------------------------------------------------------------------------
# HTTP endpoints (skipped if starlette TestClient / httpx not installed)
# ---------------------------------------------------------------------------
def test_endpoints():
    if not _has_testclient():
        print("  (skipping endpoint tests: install httpx to enable)")
        return
    c = _client()
    ref, test, _ = _pair_with_band()

    # GET / serves the page
    r = c.get("/")
    assert r.status_code == 200 and "PlasmaFlow-BOS" in r.text

    # happy path with ROI + rois + line
    r = c.post("/analyze",
               files={"reference": ("r.png", ref, "image/png"), "test": ("t.png", test, "image/png")},
               data={"align": "true", "denoise": "true",
                     "roi_x": "0.45", "roi_y": "0.28", "roi_w": "0.12", "roi_h": "0.42",
                     "rois": '[{"name":"jet","role":"signal","x":0.45,"y":0.28,"w":0.12,"h":0.42},'
                             '{"name":"bg","role":"background","x":0.02,"y":0.02,"w":0.2,"h":0.2}]',
                     "line": '{"x0":0.1,"y0":0.5,"x1":0.9,"y1":0.5}'})
    assert r.status_code == 200
    d = r.json()
    assert re.match(r"^\d{8}_\d{6}_\d{6}$", d["run_id"])  # microsecond run id
    assert d["rois"] is not None and d["line"] is not None

    # two rapid calls get unique run ids
    ids = set()
    for _ in range(3):
        rr = c.post("/analyze", files={"reference": ("r.png", ref, "image/png"),
                                       "test": ("t.png", test, "image/png")}, data={"align": "true"})
        ids.add(rr.json()["run_id"])
    assert len(ids) == 3

    # graceful errors -> 400, never 500
    bad = {"reference": ("r.png", b"x", "image/png"), "test": ("t.png", b"y", "image/png")}
    assert c.post("/analyze", files=bad).status_code == 400
    good = {"reference": ("r.png", ref, "image/png"), "test": ("t.png", test, "image/png")}
    assert c.post("/analyze", files=good, data={"rois": "{bad"}).status_code == 400
    assert c.post("/analyze", files=good, data={"line": "nope"}).status_code == 400
    assert c.post("/line_profile", files=good,
                  data={"x0": "0.5", "y0": "0.5", "x1": "0.5", "y1": "0.5"}).status_code == 400

    # clamped ROI and extreme sliders still succeed
    assert c.post("/analyze", files=good,
                  data={"roi_x": "1.5", "roi_w": "0.5", "roi_h": "0.5"}).status_code == 200
    assert c.post("/analyze", files=good,
                  data={"gain": "999", "threshold": "999", "noise_floor": "999"}).status_code == 200

    # tiny image + align must not 500
    tiny = {"reference": ("r.png", _png(_noise(3, 3)), "image/png"),
            "test": ("t.png", _png(_noise(3, 3)), "image/png")}
    assert c.post("/analyze", files=tiny, data={"align": "true", "denoise": "true"}).status_code in (200, 400)

    # other endpoints
    assert c.post("/suggest_params", files=good, data={"align": "true"}).status_code == 200
    assert c.post("/analyze_rois", files=good, data={"rois": "[]"}).status_code == 400
    assert c.post("/diff_preview", files=good).status_code == 200


# ---------------------------------------------------------------------------
# Plain runner (no pytest required)
# ---------------------------------------------------------------------------
def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
        except Exception as e:  # unexpected error
            failed += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed} passed, {failed} failed")
    os.chdir(_OLD_CWD)
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if _run_all() else 1)
