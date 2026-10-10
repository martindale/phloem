# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright 3D check for Phloem: orbit screenshots + console check.

Usage (server must be running, e.g. via scripts/shots.sh with SCRIPT=tests/e2e/orbit_check.py):
  .venv/bin/python tests/e2e/orbit_check.py [base_url] [out_dir] [which...]
`which` = any of: controls first10 full stress (default: all).
For each history it seeks to a settled tick, screenshots the default (auto-fit)
view, then orbits with scripted mouse drags (middle drag = orbit, left drag = pan) and takes two
more angles, plus a zoomed/panned close-up for first10. Exits non-zero on
console errors/warnings or worker errors.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
WHICH = sys.argv[3:] or ["controls", "first10", "full", "stress"]
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
W, H = 1280, 800


def header(page):
    return page.evaluate("() => Array.from(window.__phloem.header)")


def wait_tick(page, tick, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = header(page)
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.3)
    raise TimeoutError(f"tick {tick} not reached")


def drag(page, dx, dy, button="middle", steps=12):
    x0, y0 = W / 2, H / 2 - 60
    page.mouse.move(x0, y0)
    page.mouse.down(button=button)
    for i in range(1, steps + 1):
        page.mouse.move(x0 + dx * i / steps, y0 + dy * i / steps)
        page.wait_for_timeout(16)
    page.wait_for_timeout(60)  # stop moving before release: no inertia fling
    page.mouse.up(button=button)


def shot(page, name):
    path = f"{OUT}/{name}.png"
    page.screenshot(path=path, timeout=180000)  # software GL (swiftshader) needs seconds per frame at 5k files
    h = header(page)
    cam = page.evaluate("() => { const c = window.__phloem.camera; return [c.yaw, c.pitch, c.dist, c.auto]; }")
    print(f"{path}: tick={h[0]:.0f} commit={h[1]:.0f} segs={h[2]:.0f} food={h[3]:.0f} cam(yaw,pitch,dist,auto)={[round(v, 2) if isinstance(v, float) else v for v in cam]}")


def run(browser, logs, name, query, tick_expr, closeup=False, growing=None):
    page = browser.new_page(viewport={"width": W, "height": H})
    page.on("console", lambda m: logs.append((m.type, m.text)))
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + query, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    if growing is not None:
        page.evaluate(f"() => window.__phloem.seekTick({growing})")
        wait_tick(page, growing)
        page.wait_for_timeout(3000)
        shot(page, f"3d-{name}-0-growing")
    tick = page.evaluate(f"() => {{ const h = window.__phloem.header; return {tick_expr}; }}")
    t0 = time.time()
    page.evaluate(f"() => window.__phloem.seekTick({tick})")
    wait_tick(page, tick)
    print(f"{name}: seek to tick {tick} took {time.time() - t0:.1f}s")
    page.wait_for_timeout(3000)  # camera settles
    shot(page, f"3d-{name}-a-default")
    drag(page, 330, 0)
    page.wait_for_timeout(2500)
    shot(page, f"3d-{name}-b-orbit-side")
    drag(page, -150, 190)
    page.wait_for_timeout(2500)
    shot(page, f"3d-{name}-c-orbit-top")
    drag(page, 420, -330)
    page.wait_for_timeout(2500)
    shot(page, f"3d-{name}-d-orbit-below")
    if closeup:
        page.mouse.dblclick(W / 2, H / 2)  # reset
        page.wait_for_timeout(1500)
        page.mouse.move(W / 2 + 60, H / 2 - 40)
        for _ in range(6):
            page.mouse.wheel(0, -240)
            page.wait_for_timeout(60)
        page.wait_for_timeout(1500)
        drag(page, -120, -60, button="left")
        page.wait_for_timeout(1500)
        shot(page, f"3d-{name}-e-closeup")
    # real-time playback cost at this size
    page.evaluate("() => window.__phloem.play(true)")
    page.wait_for_timeout(3500)
    stats = page.evaluate(
        "() => ({fps: window.__phloem.perf.fps, frameMs: window.__phloem.perf.frameMs, gpuMs: window.__phloem.renderer.gpuMs,"
        " stepMs: window.__phloem.header[9], packMs: window.__phloem.header[10], segs: window.__phloem.header[2]})"
    )
    print(f"{name} playback:", json.dumps(stats))
    errs = page.evaluate("() => Array.from(document.querySelectorAll('.error')).map(e => e.textContent)")
    for e in errs:
        logs.append(("pageerror", e))
    page.close()


CAM = "() => { const c = window.__phloem.camera; return {yaw: c.yaw, pitch: c.pitch, dist: c.dist, auto: c.auto, rot: c.autoRotate, tx: c.tx, ty: c.ty}; }"

TOUCH_JS = """
async ({kind}) => {
  const cv = document.getElementById('stage');
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2 - 60;
  const ev = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, {pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 11, button: 0, buttons: type === 'pointerup' ? 0 : 1}));
  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
  if (kind === 'rotate') {
    ev('pointerdown', 11, cx, cy);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 11, cx + i * 20, cy + i * 4); await frame(); }
    ev('pointerup', 11, cx + 200, cy + 40);
  } else if (kind === 'pinch') {
    ev('pointerdown', 11, cx - 50, cy); ev('pointerdown', 12, cx + 50, cy);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 11, cx - 50 - i * 12, cy + i * 3); ev('pointermove', 12, cx + 50 + i * 12, cy + i * 3); await frame(); }
    ev('pointerup', 11, cx - 170, cy + 30); ev('pointerup', 12, cx + 170, cy + 30);
  } else if (kind === 'doubletap') {
    for (let k = 0; k < 2; k++) { ev('pointerdown', 11, cx, cy); await frame(); ev('pointerup', 11, cx, cy); await frame(); }
  }
}
"""


def controls(browser, logs):
    """Scripted mouse + touch input: orbit, pan, wheel zoom, pinch, double-tap/double-click reset, O key."""
    page = browser.new_page(viewport={"width": W, "height": H}, has_touch=True)
    page.on("console", lambda m: logs.append((m.type, m.text)))
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + "?fixture=stemdeck-first10&paused&labels=off", wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    page.evaluate("() => window.__phloem.seekTick(500)")
    wait_tick(page, 500)
    page.wait_for_timeout(1500)
    ok = True

    def check(label, cond, a, b):
        nonlocal ok
        print(f"controls {label}: {'ok' if cond else 'FAIL'}  before={ {k: round(v, 2) if isinstance(v, float) else v for k, v in a.items()} } after={ {k: round(v, 2) if isinstance(v, float) else v for k, v in b.items()} }")
        ok = ok and cond

    a = page.evaluate(CAM); drag(page, 200, 0); page.wait_for_timeout(400); b = page.evaluate(CAM)
    check("middle drag orbits (auto framing kept)", abs(b["yaw"] - a["yaw"]) > 0.5 and b["auto"], a, b)
    a = b; page.mouse.move(W / 2, H / 2); page.mouse.down(button="middle"); page.mouse.move(W / 2 + 120, H / 2, steps=8); page.mouse.up(button="middle"); page.wait_for_timeout(1200); b = page.evaluate(CAM)
    check("inertia keeps spinning after a fling", abs(b["yaw"] - a["yaw"]) > 0.6, a, b)  # the 120 px drag alone is ~0.52 rad
    a = b; drag(page, 150, 80, button="left"); page.wait_for_timeout(400); b = page.evaluate(CAM)
    check("left-drag pans", not b["auto"] and abs(b["yaw"] - a["yaw"]) < 1e-3 and abs(b["tx"] - a["tx"]) + abs(b["ty"] - a["ty"]) > 5, a, b)
    a = b; page.keyboard.down("Shift"); drag(page, -150, 0, button="left"); page.keyboard.up("Shift"); page.wait_for_timeout(400); b = page.evaluate(CAM)
    check("shift+left-drag is plain pan", abs(b["yaw"] - a["yaw"]) < 1e-3 and abs(b["tx"] - a["tx"]) + abs(b["ty"] - a["ty"]) > 5, a, b)
    a = b; drag(page, 150, 80, button="right"); page.wait_for_timeout(400); b = page.evaluate(CAM)
    check("right-drag is inert", abs(b["yaw"] - a["yaw"]) < 1e-3 and abs(b["tx"] - a["tx"]) + abs(b["ty"] - a["ty"]) < 1e-3 and abs(b["dist"] - a["dist"]) < 1e-3, a, b)
    a = b; page.mouse.move(W / 2, H / 2); page.mouse.wheel(0, -600); page.wait_for_timeout(800); b = page.evaluate(CAM)
    check("wheel zooms in", b["dist"] < a["dist"] * 0.7, a, b)
    a = b; page.mouse.dblclick(W / 2, H / 2); page.wait_for_timeout(2500); b = page.evaluate(CAM)
    check("double-click resets + auto-fits", b["auto"] and abs(b["yaw"] + 0.55) < 1e-3 and b["dist"] > a["dist"] * 1.5, a, b)
    a = b; page.evaluate(TOUCH_JS, {"kind": "rotate"}); page.wait_for_timeout(300); b = page.evaluate(CAM)
    check("one-finger drag orbits", abs(b["yaw"] - a["yaw"]) > 0.3, a, b)
    a = b; page.evaluate(TOUCH_JS, {"kind": "pinch"}); page.wait_for_timeout(300); b = page.evaluate(CAM)
    check("two-finger pinch zooms + pans", b["dist"] < a["dist"] * 0.6 and not b["auto"], a, b)
    a = b; page.wait_for_timeout(500); page.evaluate(TOUCH_JS, {"kind": "doubletap"}); page.wait_for_timeout(300); b = page.evaluate(CAM)
    check("double-tap resets", b["auto"], a, b)
    a = b; page.keyboard.press("o"); page.wait_for_timeout(1000); b = page.evaluate(CAM)
    check("O does nothing (the turntable was retired: the director owns the azimuth)", not b["rot"] and abs(b["yaw"] - a["yaw"]) < 0.02, a, b)
    page.close()
    if not ok:
        logs.append(("error", "controls check failed"))


def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        if "controls" in WHICH:
            controls(browser, logs)
        if "first10" in WHICH:
            run(browser, logs, "first10", "?fixture=stemdeck-first10&paused", "45 * 10 + 400", closeup=True, growing=45 * 5 + 30)
        if "full" in WHICH:
            run(browser, logs, "full", "?fixture=stemdeck-full&paused", "h[15] * h[19] + 300")
        if "stress" in WHICH:
            run(browser, logs, "stress", "?stress=5000&commits=120&tpc=20&paused", "120 * 20 + 300")
        browser.close()
    bad = [l for l in logs if l[0] in ("error", "warning", "pageerror")]
    for l in logs:
        print("console:", l)
    if bad:
        print(f"FAIL: {len(bad)} console errors/warnings")
        sys.exit(1)
    print("console clean")


main()
