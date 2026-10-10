# SPDX-License-Identifier: AGPL-3.0-only
"""Playwright check for name labels: screenshots (stemdeck + stress), hover tooltip,
L-key mode cycling, console cleanliness, and label cost on the 5k stress run.

Usage (server running, e.g. via scripts/shots.sh with SCRIPT=tests/e2e/labels_check.py):
  .venv/bin/python tests/e2e/labels_check.py [base_url] [out_dir]
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

def wait_tick(page, tick, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = page.evaluate("() => Array.from(window.__phloem.header)")
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.2)
    raise TimeoutError(f"tick {tick} not reached")

def open_page(browser, query, size=(1280, 800), dpr=1):
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, device_scale_factor=dpr)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: (logs.append((m.type, m.text)), m.type in ("error", "warning") and print("console:", m.type, m.text[:300])))
    page.on("pageerror", lambda e: (logs.append(("pageerror", str(e))), print("pageerror:", str(e)[:300])))
    page.on("crash", lambda: print("PAGE CRASHED"))
    page.on("framenavigated", lambda f: print("navigated:", f.url[:80]))
    page.goto(BASE + query, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=30000)
    return ctx, page, logs

HOVER_JS = """
() => {
  const g = window.__phloem, l = g.labels, cam = g.camera, r = g.renderer;
  const dpr = r.width / document.getElementById('stage').clientWidth;
  const out = new Float32Array(4);
  // pick the file anchor nearest to the screen center and return its css position (wobble ignored, hover reach covers it)
  let best = null, bd = 1e9;
  for (let i = 0; i < l.ancN; i++) {
    const id = l.anc[i*5];
    const n = l.model.tree.nodes[id];
    if (!n || n.kind !== 1) continue;
    if (!cam.project(l.anc[i*5+1], l.anc[i*5+2], l.anc[i*5+3], out)) continue;
    const sx = out[0] / dpr, sy = out[1] / dpr;
    const d = Math.hypot(sx - 640, sy - 330);
    if (d < bd) { bd = d; best = [sx, sy, n.path]; }
  }
  return best;
}
"""

def main():
    allbad = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        # ---- stemdeck, settled
        ctx, page, logs = open_page(browser, "?paused")
        end = 45 * 10 + 400
        page.evaluate(f"() => window.__phloem.seekTick({end})")
        wait_tick(page, end)
        page.wait_for_timeout(5500)  # camera settles, activity fades
        page.screenshot(path=f"{OUT}/20-labels-stemdeck-all.png", timeout=240000)
        page.keyboard.press("l")
        page.wait_for_timeout(1200)
        mode = page.evaluate("() => window.__phloem.labels.mode")
        assert mode == "active", mode
        page.screenshot(path=f"{OUT}/21-labels-stemdeck-active.png", timeout=240000)
        page.keyboard.press("l")
        page.wait_for_timeout(1200)
        assert page.evaluate("() => window.__phloem.labels.mode") == "off"
        drawn = page.evaluate("() => window.__phloem.labels.stats.drawn")
        assert drawn == 0, drawn
        page.keyboard.press("l")
        page.wait_for_timeout(1000)
        assert page.evaluate("() => window.__phloem.labels.mode") == "all"
        # hover
        pos = page.evaluate(HOVER_JS)
        page.mouse.move(pos[0], pos[1])
        page.wait_for_timeout(600)
        tip = page.evaluate("() => { const t = document.querySelector('.tip'); return t.hidden ? null : t.innerText; }")
        print("hover target:", pos[2], "->", repr(tip))
        assert tip and pos[2] in tip.replace("\n", ""), tip
        page.screenshot(path=f"{OUT}/22-labels-hover.png", timeout=240000)
        page.mouse.move(5, 5)
        page.wait_for_timeout(300)
        assert page.evaluate("() => document.querySelector('.tip').hidden")
        # close-up (zoomed in): file labels appear
        page.evaluate("() => { const c = window.__phloem.camera; c.auto = false; c.dist /= 3.2; }")
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{OUT}/23-labels-closeup.png", timeout=240000)
        page.evaluate("() => window.__phloem.camera.reset()")
        # live playback: flashes + author names
        page.evaluate("() => { window.__phloem.seekTick(0); }")
        page.wait_for_timeout(600)
        page.evaluate("() => window.__phloem.speed(2); window.__phloem.play(true)")
        page.wait_for_timeout(5200)
        page.screenshot(path=f"{OUT}/24-labels-playback.png", timeout=240000)
        print("playback labels:", json.dumps(page.evaluate("() => window.__phloem.labels.stats")))
        # motion probe: orbiting camera + live playback, GL stubbed so rAF runs at ~60 fps; track the worst per-frame
        # alpha change and slot slide of any shown label (popping / jitter), and the frame dt seen
        page.evaluate("() => { const g = window.__phloem; g.renderer.render = () => {}; g.camera.autoRotate = true; g.speed(2); window.__m = { a: 0, o: 0, n: 0, dt: 0 }; let last = performance.now(); const f = () => { const now = performance.now(); const s = g.labels.stats; window.__m.a = Math.max(window.__m.a, s.maxAlphaStep); window.__m.o = Math.max(window.__m.o, s.maxOffStep); window.__m.dt = Math.max(window.__m.dt, now - last); last = now; window.__m.n++; requestAnimationFrame(f); }; f(); }")
        page.wait_for_timeout(8000)
        print("motion probe (orbit + playback):", json.dumps(page.evaluate("() => window.__m")))
        page.evaluate("() => { const g = window.__phloem; delete g.renderer.render; g.camera.autoRotate = false; }")
        allbad += logs
        ctx.close()
        # ---- dpr 2
        ctx, page, logs = open_page(browser, "?paused", size=(900, 600), dpr=2)
        page.evaluate(f"() => window.__phloem.seekTick({end})")
        wait_tick(page, end)
        page.wait_for_timeout(5500)
        page.screenshot(path=f"{OUT}/25-labels-dpr2.png", timeout=240000)
        allbad += logs
        ctx.close()
        # ---- stress 5k
        ctx, page, logs = open_page(browser, "?stress=5000&commits=120&tpc=20&paused&stats")
        endS = 120 * 20 + 60
        page.evaluate(f"() => window.__phloem.seekTick({endS})")
        wait_tick(page, endS)
        page.wait_for_timeout(6000)
        page.screenshot(path=f"{OUT}/26-labels-stress-all.png", timeout=180000)
        print("stress labels (settled):", json.dumps(page.evaluate("() => window.__phloem.labels.stats")))
        # zoomed in on the stress run
        page.evaluate("() => { const c = window.__phloem.camera; c.auto = false; c.dist /= 5; }")
        page.wait_for_timeout(3000)
        page.screenshot(path=f"{OUT}/27-labels-stress-zoom.png", timeout=180000)
        print("stress labels (zoomed):", json.dumps(page.evaluate("() => window.__phloem.labels.stats")))
        page.evaluate("() => window.__phloem.camera.reset()")
        # Main-thread cost without SwiftShader noise: stub the GL render() so rAF runs at full speed; everything else
        # (upload, camera, label intake/plan/draw, DOM) still runs for real. The CPU is shared, so we alternate modes
        # and report median/min of repeated windows.
        page.evaluate("() => { const r = window.__phloem.renderer; r.render = () => {}; }")
        page.wait_for_timeout(4000)
        # perf 1: label layer in isolation (settled 5k mold): batches of 50 plan+draw steps
        bench = """
        (args) => {
          const g = window.__phloem; const [mode, batches] = args;
          g.setLabelMode(mode);
          const out = [];
          for (let b = 0; b < batches; b++) {
            const base = performance.now() / 1000, t0 = performance.now();
            for (let i = 0; i < 50; i++) g.labelFrame(base + i / 60, 1 / 60);
            out.push((performance.now() - t0) / 50);
          }
          out.sort((a, b) => a - b);
          return {mode, min: out[0], median: out[batches >> 1], drawn: g.labels.stats.drawn, cand: g.labels.stats.candidates};
        }
        """
        for zoom in ("fit", "zoomed x4"):
            if zoom != "fit":
                page.evaluate("() => { const c = window.__phloem.camera; c.auto = false; c.dist /= 4; }")
                page.wait_for_timeout(5000)
            for m in ("all", "active", "off"):
                page.evaluate("() => window.__phloem.labelFrame(performance.now()/1000, 1/60)")  # warm up
                r = page.evaluate(bench, [m, 21])
                print(f"labelFrame {zoom}: " + json.dumps(r))
        page.evaluate("() => { window.__phloem.camera.reset(); }")
        # perf 2: whole rAF callback (main-thread ms per frame, GL draw stubbed) during live playback, labels on vs off
        page.evaluate("() => { window.__phloem.seekTick(0); }")
        page.wait_for_timeout(1500)
        page.evaluate("() => { window.__phloem.speed(4); window.__phloem.play(true); }")
        page.wait_for_timeout(4000)
        page.evaluate("() => { window.__s = []; const f = () => { const p = window.__phloem.perf; window.__s.push([p.frameRawMs, p.labelMs]); requestAnimationFrame(f); }; f(); }")
        res = {"all": [], "active": [], "off": []}
        for rep in range(4):
            for m in ("all", "active", "off"):
                page.evaluate(f"() => {{ window.__phloem.setLabelMode('{m}'); window.__s.length = 0; }}")
                page.wait_for_timeout(3000)
                res[m].append(page.evaluate("() => window.__s.slice(5)"))
        for m, wins in res.items():
            allv = sorted(x[0] for w in wins for x in w)
            meds = sorted(sorted(x[0] for x in w)[len(w) // 2] for w in wins)
            means = [sum(x[0] for x in w) / len(w) for w in wins]
            lab = [sum(x[1] for x in w) / len(w) for w in wins]
            print(f"frame {m}: n={len(allv)} mean={sum(means)/len(means):.2f} ms (windows {', '.join(f'{v:.2f}' for v in means)}) median={meds[len(meds)//2]:.2f} ms p90={allv[int(len(allv)*0.9)]:.2f} ms  labelMs avg={sum(lab)/len(lab):.2f}")
        page.evaluate("() => { window.__phloem.play(false); }")
        page.evaluate("() => { delete window.__phloem.renderer.render; window.__phloem.setLabelMode('all'); window.__phloem.play(true); }")
        page.wait_for_timeout(4000)
        page.evaluate("() => window.__phloem.setLabelMode('all')")
        page.wait_for_timeout(800)
        page.screenshot(path=f"{OUT}/28-labels-stress-playback.png", timeout=180000)
        allbad += logs
        ctx.close()
        browser.close()
    bad = [l for l in allbad if l[0] in ("error", "warning", "pageerror") and "due to ReadPixels" not in l[1]]
    for l in bad:
        print("console:", l)
    print("console clean" if not bad else f"FAIL: {len(bad)} console errors/warnings")
    sys.exit(1 if bad else 0)

main()
