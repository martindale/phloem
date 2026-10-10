# SPDX-License-Identifier: AGPL-3.0-only
"""Relative render cost per visual effect / quality tier (Playwright, headless Chromium).

Usage (server must be running, e.g. via scripts/shots.sh with SCRIPT=tests/e2e/fx_cost.py):
  .venv/bin/python tests/e2e/fx_cost.py [base_url] [out_dir] [scene...]
scene = full | stress (default: both).

For each scene it seeks to a fixed sim tick (full history: shortly after the 142-file commit 320 lands, so a burst is in
flight; 5k stress: the settled end), freezes the sim (paused) and then renders the *same* frame synchronously with each
configuration, alternating configurations over several rounds (render + 1-pixel readPixels to force completion; the minimum over rounds is reported). The
configurations are JS snippets run against `window.__phloem.renderer` (see CONFIGS). Under WSL this is SwiftShader
(CPU), so only the RATIOS are meaningful; real GPUs are 2-3 orders of magnitude faster.
"""
import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
WHICH = sys.argv[3:] or ["full", "stress"]
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
W, H = 960, 600
ROUNDS = {"full": int(os.environ.get("FX_ROUNDS_FULL", 16)), "stress": int(os.environ.get("FX_ROUNDS_STRESS", 7))}

SCENES = {
    "full": ("?fixture=stemdeck-full&paused&labels=off&quality=high", 320 * 45 + 50),
    "stress": ("?stress=5000&commits=120&tpc=20&paused&labels=off&quality=high", 120 * 20 + 60),
}

# name -> JS run before timing (r = renderer). Override with FX_CONFIGS='{"name": "js", ...}' (e.g. '{"base": ""}').
CONFIGS = json.loads(os.environ["FX_CONFIGS"]) if os.environ.get("FX_CONFIGS") else None
DEFAULT_CONFIGS = {
    # the pre-effects renderer's shader work (no ghosts, no floods, no opaque-pass culling, no colour-by-meaning)
    "legacy": "r.setQuality('low'); r.setEffects({flood: false}); r.legacyShading = true",
    "low": "r.setQuality('low')",
    "medium": "r.setQuality('medium')",
    "high": "r.setQuality('high')",
    "high-streaming": "r.setQuality('high'); r.setEffects({streaming: 1})",
    "high-gel": "r.setQuality('high'); r.setEffects({gel: false})",
    "high-particles": "r.setQuality('high'); r.setEffects({particles: 0})",
    "high-ghosts": "r.setQuality('high'); r.setEffects({ghosts: false})",
    "high-flood": "r.setQuality('high'); r.setEffects({flood: false})",
    "high-pulse": "r.setQuality('high'); r.setEffects({radiusPulse: false})",
    "low+fringe-off": "r.setQuality('low'); r.fringe = false",
    # microscope lens (render/lens.ts): always on in the app, so every other config below runs WITH it; "lens-off" is the plain final pass
    "high+lens-off": "r.setQuality('high'); r.lensEnabled = false",
    "medium+lens-off": "r.setQuality('medium'); r.lensEnabled = false",
    "low+lens-off": "r.setQuality('low'); r.lensEnabled = false",
}

MEASURE_JS = """
async ({configs, rounds, frames}) => {
  const g = window.__phloem;
  const r = g.renderer, gl = r.gl, cam = g.camera;
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const names = Object.keys(configs);
  const acc = {};
  for (const n of names) acc[n] = [];
  for (let k = 0; k < rounds; k++) {
    for (const n of names) {
      r.fringe = true;
      if ('legacyShading' in r) r.legacyShading = false;
      r.lensEnabled = true;
      new Function('r', configs[n])(r);
      r.render(cam, 100); sync(); // warm-up: compile + upload for this config
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) { r.render(cam, 100 + i / 60); sync(); }
      acc[n].push((performance.now() - t0) / frames);
    }
  }
  const out = {};
  // minimum over rounds: the machine may be shared, and contention only ever adds time
  for (const n of names) out[n] = Math.min(...acc[n]);
  return { ms: out, segs: g.header[2], size: [r.width, r.height] };
}
"""


def wait_tick(page, tick, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = page.evaluate("() => Array.from(window.__phloem.header)")
        if h[0] >= tick and h[14] == 0:
            return h
        time.sleep(0.5)
    raise TimeoutError(f"tick {tick} not reached")


def main():
    configs = CONFIGS or DEFAULT_CONFIGS
    logs = []
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS)
        for scene in WHICH:
            query, tick = SCENES[scene]
            page = browser.new_page(viewport={"width": W, "height": H})
            page.on("console", lambda m: logs.append((m.type, m.text)))
            page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
            page.goto(BASE + query, wait_until="networkidle")
            page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=60000)
            page.evaluate(f"() => window.__phloem.seekTick({tick})")
            wait_tick(page, tick)
            page.wait_for_timeout(3000)
            res = page.evaluate(MEASURE_JS, {"configs": configs, "rounds": ROUNDS[scene], "frames": 1})
            base = res["ms"].get("legacy") or next(iter(res["ms"].values()))
            print(f"[{scene}] segs={res['segs']:.0f} size={res['size']}")
            for n, ms in res["ms"].items():
                print(f"  {n:18s} {ms:9.1f} ms   x{ms / base:5.2f}")
            results[scene] = res
            page.close()
        browser.close()
    with open(f"{OUT}/fx-cost.json", "w") as f:
        json.dump(results, f, indent=1)
    bad = [l for l in logs if l[0] in ("error", "warning", "pageerror") and "ReadPixels" not in l[1]]
    for l in bad:
        print("console:", l)
    print("console clean" if not bad else f"FAIL: {len(bad)} console errors/warnings")


main()
