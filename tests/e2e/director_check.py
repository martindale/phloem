# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright check of the cinematic auto-director camera (render/director.ts): framing follows the activity and pulls back on the
142-file commit; hand-off to the user and back; console clean.

Usage (a production build must be served on your own port, e.g. `npm run build:e2e && npx vite preview --outDir dist-e2e --port 5233 --strictPort`):
  .venv/bin/python tests/e2e/director_check.py [base_url] [out_dir] [which...]
which = any of: sequence frames handoff backdrop (default: all except frames, which needs a trace)

- sequence: the full-history fixture, seek to commit ~316 (paused, so software GL does not drop sim time), then play at 1x with the director on.
            The page's rAF loop drives the director (dt is capped at 0.1 s per frame, so with slow software rendering the camera runs a bit
            slower than wall time). A recorder in the page samples header + camera every 100 ms into window.__trace (printed as a table), and
            screenshots are taken before, during and after the 142-file commit (320).
- frames:   scripted frame stepping. Software GL cannot play in real time, so `npm run director-trace -- 312 18 1 scratch/trace.json` runs the real sim +
            Camera + Director offline at 60 fps; TRACE=scratch/trace.json makes this mode seek the page to chosen ticks of that run, set the camera to the
            director's pose for that frame (director off in the page) and screenshot it with the real renderer and labels.
- handoff:  the director is always on (no key, button or URL switch); drag = user takes over (director state `user`), idle for 6 s = it eases back in;
            double-click resets; no Director button; C does nothing.
- backdrop: the landing page runs the director; under prefers-reduced-motion it still runs, scaled to 35 %.
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5233/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
WHICH = sys.argv[3:] or ["sequence", "handoff", "backdrop"]
import os
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
W, H = 960, 600
TPC = 45

REC = """() => {
  const g = window.__phloem; window.__trace = [];
  const t0 = performance.now();
  clearInterval(window.__rec);
  window.__rec = setInterval(() => {
    const h = g.header, c = g.camera, d = g.director;
    window.__trace.push({ t: (performance.now() - t0) / 1000, tick: h[0], commit: h[1], act: h[39], hotW: h[37], hot: [h[34], h[35], h[36]],
      burst0: [h[40], h[41]], dist: c.dist, tgt: [c.tx, c.ty, c.tz], yaw: c.yaw, pitch: c.pitch, fit: c.fitDist,
      follow: d.follow, dact: d.act, dburst: d.burst, auth: d.authority, state: d.state, fps: g.perf.fps });
  }, 100);
}"""


def open_page(browser, logs, query, size=(W, H)):
    page = browser.new_page(viewport={"width": size[0], "height": size[1]})
    page.on("console", lambda m: logs.append((m.type, m.text)))
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + query, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    return page


def wait_tick(page, tick, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = page.evaluate("() => Array.from(window.__phloem.header)")
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.2)
    raise TimeoutError(f"tick {tick}")


def shot(page, name):
    page.mouse.move(2, 2)
    path = f"{OUT}/{name}.png"
    page.screenshot(path=path, timeout=240000)
    s = page.evaluate("() => { const h = window.__phloem.header, c = window.__phloem.camera, d = window.__phloem.director; return [h[0], h[1], h[39], h[37], c.dist, c.fitDist, d.follow, d.burst, d.state]; }")
    print(f"{path}: tick={s[0]:.0f} commit={s[1]:.0f} act={s[2]:.2f} hotW={s[3]:.1f} dist={s[4]:.0f} fit={s[5]:.0f} follow={s[6]:.2f} burst={s[7]:.2f} state={s[8]}")


def sequence(browser, logs):
    page = open_page(browser, logs, "?fixture=stemdeck-full&paused&labels=active&quality=low")
    g = "window.__phloem"
    start = (320 - 4) * TPC
    page.evaluate(f"() => {g}.seekTick({start})")
    wait_tick(page, start)
    page.wait_for_timeout(9000)  # let the director settle on the establishing / calm shot (paused: relaxes to the whole mold)
    shot(page, "director-0-paused-establishing")
    page.evaluate(REC)
    page.evaluate(f"() => {{ {g}.play(true); }}")
    t0 = time.time()
    marks = [  # (name, predicate on trace sample)
        ("director-1-before-burst", lambda s: s["tick"] >= 319 * TPC + 20),
        ("director-2-burst-landing", lambda s: s["tick"] >= 320 * TPC + 12),
        ("director-3-burst-flood", lambda s: s["tick"] >= 320 * TPC + 55),
        ("director-4-after-burst", lambda s: s["tick"] >= 322 * TPC + 20),
        ("director-5-later", lambda s: s["tick"] >= 328 * TPC),
    ]
    mi = 0
    while mi < len(marks) and time.time() - t0 < 240:
        tr = page.evaluate("() => window.__trace.length ? window.__trace[window.__trace.length - 1] : null")
        if tr and marks[mi][1](tr):
            shot(page, marks[mi][0])
            mi += 1
        else:
            time.sleep(0.05)
    tr = page.evaluate("() => window.__trace")
    json.dump(tr, open(f"{OUT}/director-trace.json", "w"))
    print("t     tick  cmt  act  hotW  dist  fit  follow  dburst  tgt(x,y)        yaw    pitch  state")
    for s in tr[:: max(1, len(tr) // 60)]:
        print(f"{s['t']:5.1f} {s['tick']:5.0f} {s['commit']:4.0f} {s['act']:.2f} {s['hotW']:5.1f} {s['dist']:5.0f} {s['fit']:4.0f}  {s['follow']:.2f}   {s['dburst']:.2f}   "
              f"({s['tgt'][0]:6.1f},{s['tgt'][1]:6.1f})  {s['yaw']:.3f}  {s['pitch']:.3f} {s['state']} fps={s['fps']:.1f}")
    page.close()


def frames(browser, logs):
    rows = json.load(open(os.environ["TRACE"]))
    page = open_page(browser, logs, "?fixture=stemdeck-full&paused&labels=all&quality=high", size=(1280, 800))
    g = "window.__phloem"
    page.evaluate(f"() => {{ {g}.manualDirector = true; }}")  # the director is always on: freeze it so the scripted poses stay
    ticks = [int(x) for x in os.environ.get("TICKS", "14340,14395,14420,14450,14500,14580,14700,14880,15000").split(",")]
    for i, want in enumerate(ticks):
        r = next((r for r in rows if r["tick"] >= want), rows[-1])
        page.evaluate(f"() => {g}.seekTick({int(r['tick'])})")
        wait_tick(page, int(r["tick"]))
        page.evaluate(f"() => {{ const c = {g}.camera; c.auto = false; c.tx = {r['tx']}; c.ty = {r['ty']}; c.tz = {r['tz']}; c.dist = {r['dist']}; c.yaw = {r['yaw']}; c.pitch = {r['pitch']}; }}")
        page.wait_for_timeout(2500)
        print(f"  trace t={r['t']:.2f}s follow={r['follow']:.2f} burst={r['burst']:.2f} dist={r['dist']:.0f} fit={r['fit']:.0f} tgt=({r['tx']:.0f},{r['ty']:.0f}) hot=({r['hot'][0]:.0f},{r['hot'][1]:.0f}) hotW={r['hotW']:.0f}")
        shot(page, f"director-frame-{i}-tick{int(r['tick'])}")
    page.close()


def handoff(browser, logs):
    page = open_page(browser, logs, "?fixture=stemdeck-full&paused&labels=active&quality=low", size=(800, 500))
    g = "window.__phloem"
    state = lambda: page.evaluate(f"() => {g}.director.state")
    assert state() in ("directing", "standby"), state()  # on from the first frame
    assert page.evaluate("() => document.querySelector('.gm-director')") is None, "there is no Director button"
    page.keyboard.press("c")
    page.wait_for_timeout(300)
    assert state() in ("directing", "standby"), "C must not switch it off: " + state()
    wait_tick(page, 0)
    page.evaluate(f"() => {g}.seekTick(150 * {TPC})")
    wait_tick(page, 150 * TPC)
    page.wait_for_timeout(2500)
    # a left-drag pan hands the camera over at once
    page.mouse.move(400, 250)
    page.mouse.down()
    page.mouse.move(430, 260, steps=4)
    page.wait_for_timeout(300)
    st_drag = state()
    page.mouse.up()
    page.wait_for_timeout(200)
    st_after = state()
    print("state while dragging:", st_drag, "| right after release:", st_after)
    assert st_drag == "user" and st_after == "user"
    pose0 = page.evaluate(f"() => [{g}.camera.tx, {g}.camera.dist, {g}.camera.yaw]")
    page.wait_for_timeout(2500)
    pose1 = page.evaluate(f"() => [{g}.camera.tx, {g}.camera.dist, {g}.camera.yaw]")
    print("pose held while user has the camera:", pose0, pose1)
    # wheel also counts
    page.mouse.wheel(0, -120)
    page.wait_for_timeout(500)
    assert state() == "user"
    t0 = time.time()
    while state() != "directing" and time.time() - t0 < 20:
        page.wait_for_timeout(250)
    print("director back after %.1f s of quiet" % (time.time() - t0), state())
    assert state() == "directing"
    # double-click resets and counts as input
    page.mouse.dblclick(400, 250)
    page.wait_for_timeout(300)
    assert state() == "user"
    assert page.evaluate(f"() => {g}.director.enabled") is True
    assert page.evaluate(f"() => {g}.camera.autoRotateSuppressed") is True
    page.close()


def backdrop(browser, logs):
    page = open_page(browser, logs, "", size=(W, H))
    st = page.evaluate("() => window.__phloem.director.enabled")
    print("landing backdrop: director enabled =", st)
    assert st is True
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/director-backdrop.png", timeout=240000)
    page.close()
    page = open_page(browser, logs, "?director=0", size=(W, H))  # the retired parameter must not switch anything off
    assert page.evaluate("() => window.__phloem.director.enabled") is True
    page.close()
    ctx = browser.new_context(viewport={"width": W, "height": H}, reduced_motion="reduce")
    page = ctx.new_page()
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
    assert page.evaluate("() => window.__phloem.director.enabled && window.__phloem.director.reduced") is True
    print("reduced motion: director on and scaled")
    ctx.close()


def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=ARGS)
        for name in WHICH:
            print(f"== {name}")
            globals()[name](browser, logs)
        browser.close()
    bad = [l for l in logs if l[0] in ("error", "pageerror", "warning")]
    print("console messages:", len(logs), "problems:", len(bad))
    for l in bad[:20]:
        print("  ", l)
    sys.exit(1 if bad else 0)


main()
