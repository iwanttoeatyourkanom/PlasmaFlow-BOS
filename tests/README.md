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

Loads the page in a headless DOM, checks it starts with no errors, exercises the
UI wiring (mode toggle, guide tabs, sliders, collapsible cards, keyboard
shortcut), and drives the result-render path including an XSS-escaping check.

The frontend is split across `static/css/style.css` and `static/js/*.js`, which
jsdom does not fetch. The test rebuilds the equivalent inlined page by reading
those files and injecting them — each JS module as its own `<script>` block, in
`index.html` order — so per-script load semantics match a real browser.

```
npm install jsdom      # one time
node tests/frontend_test.js
```

Without jsdom the suite skips cleanly.

## What to run after changing code

- Edited `main.py` -> run the Python suite.
- Edited `static/js/*.js`, `static/css/style.css`, or `static/index.html` -> run
  the frontend suite, and `node --check` each changed JS module.
