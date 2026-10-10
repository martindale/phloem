# SPDX-License-Identifier: AGPL-3.0-only
"""Stress perf check: synthetic 5k-file history, fast-forward to the end, then
measure frame rate, main-thread frame cost, worker sim cost and GPU-side render
cost (render + gl.finish) in headless Chromium.

Usage: .venv/bin/python tests/e2e/perf_check.py [base_url] [out_dir] [files]
NOTE: under WSL headless Chromium renders with SwiftShader (CPU). Absolute
render numbers are therefore pessimistic; compare relative costs.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
FILES = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

MEASURE_JS = """
async () => {
  const g = window.__phloem;
  const r = g.renderer, gl = r.gl, cam = g.camera;
  // gl.finish() does not block in Chrome; a 1-pixel readPixels forces a full sync
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const time = (n) => { sync(); const t0 = performance.now(); for (let i = 0; i < n; i++) { r.render(cam, i / 60); sync(); } return (performance.now() - t0) / n; };
  const full = time(5);
  const saved = r.segCount; r.segCount = 0; const noSegs = time(5); r.segCount = saved;
  return { renderFinishMs: full, withoutSegmentsMs: noSegs, segmentsMs: full - noSegs, segs: saved, size: [r.width, r.height] };
}
"""

def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: logs.append((m.type, m.text)))
        page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
        page.goto(BASE + f"?stress={FILES}&commits=120&tpc=20&paused&stats", wait_until="networkidle")
        page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=30000)
        end = 120 * 20 + 60
        t0 = time.time()
        page.evaluate(f"() => window.__phloem.seekTick({end})")
        while True:
            h = page.evaluate("() => Array.from(window.__phloem.header)")
            if h[0] >= end and h[14] == 0:
                break
            if time.time() - t0 > 600:
                raise TimeoutError("fast-forward did not finish")
            time.sleep(0.5)
        ff = time.time() - t0
        print(f"fast-forward {end} ticks: {ff:.1f}s wall ({ff * 1000 / end:.2f} ms/tick incl. packing/transfer)")
        page.evaluate("() => window.__phloem.play(true)")
        page.wait_for_timeout(6000)
        stats = page.evaluate("() => ({fps: window.__phloem.perf.fps, frameMs: window.__phloem.perf.frameMs, uploadMs: window.__phloem.perf.uploadMs, stepMs: window.__phloem.header[9], packMs: window.__phloem.header[10], segs: window.__phloem.header[2], food: window.__phloem.header[3], nodes: window.__phloem.header[11]})")
        print("playback:", json.dumps(stats))
        page.evaluate("() => window.__phloem.play(false)")
        page.wait_for_timeout(500)
        print("render cost:", json.dumps(page.evaluate(MEASURE_JS)))
        page.screenshot(path=f"{OUT}/10-stress-{FILES}.png", timeout=180000)
        browser.close()
    # readPixels stalls are induced by the timing probe above, not by the app
    bad = [l for l in logs if l[0] in ("error", "warning", "pageerror") and "due to ReadPixels" not in l[1]]
    for l in bad:
        print("console:", l)
    print("console clean" if not bad else f"FAIL: {len(bad)} console errors/warnings")

main()
