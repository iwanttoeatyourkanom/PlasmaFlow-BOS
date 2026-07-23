# PlasmaFlow-BOS

Background-oriented schlieren (BOS) tool for visualizing gas-jet and plasma-actuator
flow. It lines up two photos of a speckled background, one with the flow off and one
with it on, and maps where the background shifted. Brighter areas mean a bigger shift,
which reveals flow you cannot normally see.

The numbers it reports (peak, mean, coverage) are brightness shifts from 0 to 255, not
physical units. Use them to compare runs on the same setup. Add a scale to also read
sizes in millimetres.

## Features

- Single analysis: one reference vs one test.
- Plasma On/Off compare: one reference vs two tests (off and on), same settings, side by side.
- ROI and named signal/background regions with an SNR table.
- Noise baseline: a second flow-off shot to show how much of a result is just noise.
- Scale calibration so lengths read in millimetres, plus a Measure tool for ad-hoc length readouts.
- Alignment (corner-based), denoise, adjustable colormap, gain, threshold.
- One-click export: diff images plus CSV logs, bundled in a ZIP.
- Built-in user guide covering capture tips and every feature.

## Install

Python 3.10 or newer.

```
pip install -r requirements.txt
```

## Run

```
uvicorn main:app
```

Then open http://127.0.0.1:8000 in a browser. Everything runs locally; your images
stay on your machine.

## Capture, in short

- Lock the camera to manual (focus, ISO, exposure, white balance).
- Use a tripod and a timer or remote. Do not touch anything between shots.
- Shoot reference (flow off) and test (flow on) back to back.
- For a noise baseline, take a second flow-off shot right after.
- For millimetre sizes, keep a ruler or a known mark in the reference photo.

The full guide is in the app under the "Guide" button.

## Outputs

Each run is logged to two CSVs that join on a shared run id:

- `runs.csv` one row per run with settings and whole-frame stats.
- `roi_regions.csv` per-region stats and SNR.

The ZIP download bundles the diff images and a self-contained copy of these rows,
with millimetre columns filled in when a scale is set.

## Tests

See `tests/README.md`. Backend: `python tests/test_bos.py`. Frontend: `node
tests/frontend_test.js` (needs `npm install jsdom`).

## Layout

- `main.py` FastAPI backend: image diff, stats, endpoints, CSV logging.
- `static/index.html` single-page frontend (UI, canvases, charts, exports).
- `bg_patterns/` printable speckle backgrounds.
- `tests/` backend and frontend regression tests.
