# Tests

Regression tests for PlasmaFlow-BOS. Run both from the project root (the folder
with `main.py` and `static/`).

## Backend (Python)

Covers the diff pipeline, alignment safety on odd inputs, ROI/SNR stats, and
every HTTP endpoint including the graceful-error paths.

```
python tests/test_bos.py        # plain runner, no extra tools
python -m pytest tests          # if you have pytest
```

The suite redirects the app's CSV log paths to a temp folder, so running it
never appends to your real `runs.csv` / `roi_regions.csv`.
Endpoint tests need `httpx` (`pip install httpx`); without it they skip.

## Frontend (JavaScript)

Loads `static/index.html` in a headless DOM, checks it starts with no errors,
exercises the UI wiring (mode toggle, guide tabs, sliders, collapsible cards,
keyboard shortcut), and drives the result-render path including an
XSS-escaping check.

```
npm install jsdom      # one time
node tests/frontend_test.js
```

Without jsdom the suite skips cleanly.

## What to run after changing code

- Edited `main.py` -> run the Python suite.
- Edited `static/index.html` -> run the frontend suite, and a syntax check:
  extract the `<script>` block and run `node --check` on it.
