# SPDX-License-Identifier: AGPL-3.0-only
"""Early-name regression check: no visible file/folder label may belong to an unreached node.
Usage: .venv/bin/python tests/e2e/labels_reached_check.py [base_url] [out_dir] [query]"""
import sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5391/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
QUERY = sys.argv[3] if len(sys.argv) > 3 else "?fixture=stemdeck-first10&paused"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

PROBE = """() => {
  const g = window.__phloem, l = g.labels;
  if (!window.__probe) { window.__probe = 1; window.__viol = 0; window.__maxVis = 0; window.__samples = 0;
    const loop = () => { const k = []; for (let i = 0; i < l.liveN; i++) k.push(l.live[i]);
      let vis = 0;
      for (const key of k) { if (key < 32 || l.alpha[key] < 0.05) continue; vis++; if (l.tgt[key] <= 0) continue;
        const ai = l.anchorIndex(key - 32);
        if (ai < 0 || l.anc[ai*5+4] < 0.5) window.__viol++; }
      window.__maxVis = Math.max(window.__maxVis, vis); window.__samples++;
      requestAnimationFrame(loop); };
    requestAnimationFrame(loop); }
  let reached = 0; for (let i = 0; i < l.ancN; i++) if (l.anc[i*5+4] > 0.5) reached++;
  return { viol: window.__viol, maxVis: window.__maxVis, samples: window.__samples, anchors: l.ancN, reached, tick: g.header[0], commit: g.header[1] };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    page = b.new_context(viewport={"width": 1280, "height": 800}).new_page()
    page.on("pageerror", lambda e: print("pageerror", str(e)[:200]))
    page.goto(BASE + QUERY, wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=30000)
    time.sleep(2)
    print("initial", page.evaluate(PROBE)); page.screenshot(path=f"{OUT}/reach_0_initial.png")
    page.evaluate("() => window.__phloem.play(true)")
    for i in range(1, 7):
        time.sleep(2.5)
        print(i, page.evaluate(PROBE)); page.screenshot(path=f"{OUT}/reach_{i}.png")
    b.close()
