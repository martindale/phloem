# End-to-end checks (Playwright, Python)

The checks drive a real Chromium (software GL under WSL, so a frame takes 0.2-3 s and the scripts poll instead of sleeping). They need the test hook
`window.__phloem`, which a **normal production build does not contain** (it can reach the in-memory GitHub token). It exists only

* in the Vite dev server (`npm run dev`, `scripts/shots.sh`),
* in the e2e build: `npm run build:e2e` (= `vite build --mode e2e` into `dist-e2e/`, git-ignored), and
* in any build made with `VITE_EXPOSE_TEST_HOOKS=1`.

`npm run build` runs `scripts/check-dist.mjs`, which fails if `dist/` contains the hook.

## One-time setup

```
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/playwright install chromium         # on WSL also: system libraries for Chromium (apt) or a local copy under .venv/syslibs
npm ci
```

`scripts/shots.sh` adds `.venv/syslibs/usr/lib/x86_64-linux-gnu` to `LD_LIBRARY_PATH` when that folder exists; for the other commands export it yourself if you need it.

## Running

Serve the **e2e build** on a port of your own (pick one that is free; do not reuse a dev server's port):

```
npm run build:e2e
npx vite preview --outDir dist-e2e --port 5481 --strictPort &       # or: npm run preview:e2e  (port 5290)

.venv/bin/python tests/e2e/web_check.py       http://localhost:5481/ scratch/web        # landing, loading, states, share link, token, saved histories, CSP
.venv/bin/python tests/e2e/qa_check.py        http://127.0.0.1:5481/ scratch/qa         # input, touch, labels, director, quality, hostile data, a11y, CSP, drop, switch
.venv/bin/python tests/e2e/featured_check.py  http://localhost:5481/ scratch/featured   # prebuilt histories: zero api.github.com requests
.venv/bin/python tests/e2e/director_check.py  http://localhost:5481/ scratch/director handoff backdrop
.venv/bin/python tests/e2e/migrate_check.py   http://localhost:5481/                    # one-time migration from the former "gitmold" names
```

Checks that use the dev server instead (visual_check, fx_check, orbit_check, labels_check, perf_check): `PORT=5599 SCRIPT=tests/e2e/fx_check.py scripts/shots.sh`
(`PORT` defaults to 5173; set another one when your own dev server is running).

The CSP `<meta>` tag only exists in builds, so the CSP checks need a build (e2e or normal); the dev server has none.
Screenshots and scratch output go to `screenshots/` or `scratch/`, both git-ignored.
