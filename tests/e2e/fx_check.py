# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright check of the visual effects (streaming, floods, gel, motes, ghosts): screenshot sequences + console check.

Usage (server must be running, e.g. via scripts/shots.sh with SCRIPT=tests/e2e/fx_check.py):
  .venv/bin/python tests/e2e/fx_check.py [base_url] [out_dir] [which...]
which = any of: first10 full stress tiers (default: all). Quality is pinned (`?quality=`), since software GL would
otherwise be auto-downgraded.

- first10: growing + settled, default view, an orbit, a close-up, and a close-up time sequence (paused sim: only
  streaming/breathing/motes move) to show the flow inside the veins.
- full:    the 142-file commit 320 landing: a sequence of sim ticks after it lands (the flood running outward), from two
  angles, plus a close-up during the flood.
- stress:  5k files, settled with the last bursts, default + orbit.
- tiers:   the same full-history frame at low / medium / high.
"""
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
WHICH = sys.argv[3:] or ["first10", "full", "stress", "tiers"]
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
W, H = 1280, 800
BIG = 320 * 45  # landing tick of the 142-file commit (even pacing, 45 ticks per commit)


def header(page):
    return page.evaluate("() => Array.from(window.__phloem.header)")


def wait_tick(page, tick, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = header(page)
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.25)
    raise TimeoutError(f"tick {tick} not reached")


def seek(page, tick, settle=1500):
    page.evaluate(f"() => window.__phloem.seekTick({tick})")
    wait_tick(page, tick)
    page.wait_for_timeout(settle)


def drag(page, dx, dy, steps=10, button="middle"):
    x0, y0 = W / 2, H / 2 - 60
    page.mouse.move(x0, y0)
    page.mouse.down(button=button)
    for i in range(1, steps + 1):
        page.mouse.move(x0 + dx * i / steps, y0 + dy * i / steps)
        page.wait_for_timeout(16)
    page.wait_for_timeout(60)
    page.mouse.up(button=button)


def shot(page, name):
    page.mouse.move(2, 2)  # no hover tooltip in the shot
    path = f"{OUT}/{name}.png"
    page.screenshot(path=path, timeout=240000)
    h = header(page)
    print(f"{path}: tick={h[0]:.0f} commit={h[1]:.0f} segs={h[2]:.0f} ghosts={h[33]:.0f} act={h[39]:.2f} "
          f"hot=({h[34]:.0f},{h[35]:.0f},{h[36]:.0f}) w={h[37]:.1f} burst0=({h[40]:.0f},{h[41]:.2f})")


def open_page(browser, logs, query):
    page = browser.new_page(viewport={"width": W, "height": H})
    page.on("console", lambda m: logs.append((m.type, m.text)))
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + query, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    return page


def closeup(page, k=3.2, dx=0.0, dy=0.0):
    page.evaluate(f"() => {{ const c = window.__phloem.camera; c.auto = false; c.dist /= {k}; c.tx += {dx}; c.ty += {dy}; }}")
    page.wait_for_timeout(1500)


def first10(browser, logs):
    page = open_page(browser, logs, "?fixture=stemdeck-first10&paused&labels=off&quality=high")
    seek(page, 45 + 30, 2500)
    shot(page, "fx-first10-0-growing")
    seek(page, 45 * 10 + 400, 2500)
    shot(page, "fx-first10-1-settled")
    drag(page, 260, 90)
    page.wait_for_timeout(2000)
    shot(page, "fx-first10-2-orbit")
    page.evaluate("() => window.__phloem.camera.reset()")
    page.wait_for_timeout(1500)
    closeup(page, 3.5, 30, 20)
    for i in range(4):  # paused sim: streaming, breathing and motes still move
        shot(page, f"fx-first10-3-closeup-t{i}")
        page.wait_for_timeout(700)
    page.close()


def full(browser, logs):
    page = open_page(browser, logs, "?fixture=stemdeck-full&paused&labels=off&quality=high")
    seek(page, BIG - 2, 2500)
    shot(page, "fx-full-0-before")
    for i, dt in enumerate([8, 22, 40, 62, 90, 140]):
        seek(page, BIG + dt, 800)
        shot(page, f"fx-full-1-flood-{i}-t{dt}")
    drag(page, -300, 120)
    page.wait_for_timeout(2000)
    seek(page, BIG + 45 + 20, 800)  # commit 321 lands at BIG + 45: a second (smaller) flood
    shot(page, "fx-full-2-orbit-flood")
    page.evaluate("() => window.__phloem.camera.reset()")
    page.wait_for_timeout(1500)
    seek(page, BIG + 45 * 2 + 4, 800)  # commit 322 (64 files)
    closeup(page, 2.6)
    seek(page, BIG + 45 * 2 + 16, 800)
    shot(page, "fx-full-3-closeup-flood")
    seek(page, BIG + 45 * 6, 800)
    shot(page, "fx-full-4-closeup-after")
    page.evaluate("() => window.__phloem.camera.reset()")
    seek(page, 15150, 2500)  # settling after the last commit: withered veins leave afterglow ghosts
    shot(page, "fx-full-5-afterglow")
    page.close()


def stress(browser, logs):
    page = open_page(browser, logs, "?stress=5000&commits=120&tpc=20&paused&labels=off&quality=high")
    seek(page, 119 * 20 + 14, 3000)
    shot(page, "fx-stress-0-burst")
    seek(page, 119 * 20 + 160, 2000)
    shot(page, "fx-stress-1-settled")
    drag(page, 330, 0)
    page.wait_for_timeout(2500)
    shot(page, "fx-stress-2-orbit")
    page.close()


def tiers(browser, logs):
    page = open_page(browser, logs, "?fixture=stemdeck-full&paused&labels=off&quality=high")
    seek(page, BIG + 30, 2500)
    for t in ["low", "medium", "high"]:
        page.evaluate(f"() => window.__phloem.renderer.setQuality('{t}')")
        page.wait_for_timeout(1500)
        shot(page, f"fx-tier-{t}")
    page.close()
    # prefers-reduced-motion: no motes, no streaming amplitude (floods and colour stay)
    ctx = browser.new_context(viewport={"width": W, "height": H}, reduced_motion="reduce")
    page = ctx.new_page()
    page.on("console", lambda m: logs.append((m.type, m.text)))
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + "?fixture=stemdeck-full&paused&labels=off&quality=high", wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    assert page.evaluate("() => window.__phloem.renderer.reducedMotion"), "reduced motion not detected"
    seek(page, BIG + 30, 2500)
    shot(page, "fx-tier-high-reduced-motion")
    ctx.close()


def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        for name in WHICH:
            globals()[name](browser, logs)
        browser.close()
    bad = [l for l in logs if l[0] in ("error", "warning", "pageerror")]
    for l in bad:
        print("console:", l)
    if bad:
        print(f"FAIL: {len(bad)} console errors/warnings")
        sys.exit(1)
    print("console clean")


main()
