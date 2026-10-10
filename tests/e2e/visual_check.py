# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright visual + console check for Phloem.

Usage (server must be running, e.g. via scripts/shots.sh):
  .venv/bin/python tests/e2e/visual_check.py [base_url] [out_dir]
Seeks to deterministic sim ticks, screenshots each, then measures real-time
playback fps. Exits non-zero if the console shows errors/warnings.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
TPC = 45
SHOTS = [
    ("01-first-commit-growing", 28),
    ("02-merge-growing", TPC + 22),
    ("03-merge-spreading", TPC + 40),
    ("04-commit3-settled", TPC * 3 - 1),
    ("05-commit6-growing", TPC * 5 + 30),
    ("06-final-settled", TPC * 10 + 400),
]

ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

def wait_tick(page, tick, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = page.evaluate("() => Array.from(window.__phloem.header)")
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.2)
    raise TimeoutError(f"tick {tick} not reached")

def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: logs.append((m.type, m.text)))
        page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
        page.goto(BASE + "?fixture=stemdeck-first10&paused", wait_until="networkidle")
        page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=30000)
        for name, tick in SHOTS:
            page.evaluate(f"() => window.__phloem.seekTick({tick})")
            wait_tick(page, tick)
            page.wait_for_timeout(2500)  # let the camera settle
            path = f"{OUT}/{name}.png"
            page.screenshot(path=path)
            h = page.evaluate("() => Array.from(window.__phloem.header)")
            print(f"{path}: tick={h[0]:.0f} commit={h[1]:.0f} segs={h[2]:.0f} food={h[3]:.0f} pulses={h[4]:.0f} tips={h[16]:.0f} expl={h[17]:.0f}")
        # close-up of the settled network (camera manual, 3.5x)
        page.evaluate("() => { const c = window.__phloem.camera; c.auto = false; c.dist /= 3.5; c.tx += 30; c.ty += 20; }")
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{OUT}/08-closeup.png")
        page.evaluate("() => window.__phloem.camera.reset()")
        # real-time playback
        page.evaluate("() => { window.__phloem.seekTick(0); }")
        page.wait_for_timeout(500)
        page.evaluate("() => window.__phloem.play(true)")
        page.wait_for_timeout(4000)
        stats = page.evaluate("() => ({fps: window.__phloem.perf.fps, frameMs: window.__phloem.perf.frameMs, step: window.__phloem.header[9], segs: window.__phloem.header[2]})")
        print("playback:", json.dumps(stats))
        page.screenshot(path=f"{OUT}/07-realtime-playback.png")
        # devicePixelRatio 2 + live resize to a portrait phone-sized viewport
        ctx = browser.new_context(viewport={"width": 900, "height": 600}, device_scale_factor=2)
        page2 = ctx.new_page()
        page2.on("console", lambda m: logs.append((m.type, m.text)))
        page2.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
        page2.goto(BASE + "?fixture=stemdeck-first10&paused", wait_until="networkidle")
        page2.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=30000)
        page2.evaluate(f"() => window.__phloem.seekTick({TPC * 6})")
        wait_tick(page2, TPC * 6)
        page2.wait_for_timeout(2500)
        size = page2.evaluate("() => [window.__phloem.renderer.width, window.__phloem.renderer.height, devicePixelRatio]")
        print("dpr2 drawing buffer:", size)
        page2.screenshot(path=f"{OUT}/09a-dpr2.png")
        page2.set_viewport_size({"width": 400, "height": 760})
        page2.wait_for_timeout(2500)
        size = page2.evaluate("() => [window.__phloem.renderer.width, window.__phloem.renderer.height]")
        print("after resize drawing buffer:", size)
        page2.screenshot(path=f"{OUT}/09b-resized-portrait.png")
        ctx.close()
        browser.close()
    bad = [l for l in logs if l[0] in ("error", "warning", "pageerror")]
    for l in logs:
        print("console:", l)
    if bad:
        print(f"FAIL: {len(bad)} console errors/warnings")
        sys.exit(1)
    print("console clean")

main()
