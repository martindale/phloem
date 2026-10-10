# SPDX-License-Identifier: AGPL-3.0-only
"""Leak and cost sanity of the combined app (production build): load A -> B -> demo repeatedly and watch what survives.

  npm run build:e2e && npx vite preview --outDir dist-e2e --port 5299 --strictPort &
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python tests/e2e/leak_check.py http://127.0.0.1:5299/ OUTDIR A.log B.log [cycles] [play_seconds]

Per cycle it records (after a forced GC): JS heap, DOM nodes, event listeners, live Web Workers (CDP targets), live WebGL objects
(textures, buffers, framebuffers, renderbuffers, programs, shaders, vertex arrays; counted by wrapping create*/delete*), the label
bitmap cache, and the IndexedDB / storage estimate. Then it plays the full history for `play_seconds` at 16x and samples the heap
again. Pass logs of different size (e.g. the StemDeck clone's log and `npm run synth-log` output).
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
OUT = sys.argv[2]
LOG_A = sys.argv[3]
LOG_B = sys.argv[4]
CYCLES = int(sys.argv[5]) if len(sys.argv) > 5 else 4
PLAY_S = int(sys.argv[6]) if len(sys.argv) > 6 else 90
LAUNCH = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info", "--js-flags=--expose-gc"]
Path(OUT).mkdir(parents=True, exist_ok=True)

GL_HOOK = """
(() => {
  const live = {}; window.__gl = live;
  for (const [mk, rm, kind] of [['createTexture','deleteTexture','tex'],['createBuffer','deleteBuffer','buf'],['createFramebuffer','deleteFramebuffer','fbo'],
      ['createRenderbuffer','deleteRenderbuffer','rbo'],['createProgram','deleteProgram','prog'],['createShader','deleteShader','shader'],['createVertexArray','deleteVertexArray','vao']]) {
    const P = WebGL2RenderingContext.prototype, a = P[mk], d = P[rm];
    P[mk] = function (...x) { live[kind] = (live[kind] || 0) + 1; return a.apply(this, x); };
    P[rm] = function (o) { if (o) live[kind] = (live[kind] || 0) - 1; return d.call(this, o); };
  }
  window.__workers = 0; const W = window.Worker;
  window.Worker = function (...a) { window.__workers++; const w = new W(...a); const t = w.terminate.bind(w); let dead = false;
    w.terminate = () => { if (!dead) { dead = true; window.__workers--; } return t(); }; return w; };
  window.Worker.prototype = W.prototype;
})();
"""


def main():
    rows = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, args=LAUNCH)
        ctx = b.new_context(viewport={"width": 1000, "height": 640})
        ctx.add_init_script(GL_HOOK)
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        cdp = ctx.new_cdp_session(page)
        cdp.send("Performance.enable")
        cdp.send("Target.setDiscoverTargets", {"discover": True})
        targets = {}
        cdp.on("Target.targetCreated", lambda e: targets.__setitem__(e["targetInfo"]["targetId"], e["targetInfo"]))
        cdp.on("Target.targetDestroyed", lambda e: targets.pop(e["targetId"], None))
        cdp.on("Target.targetInfoChanged", lambda e: targets.__setitem__(e["targetInfo"]["targetId"], e["targetInfo"]))
        page.goto(BASE + "?quality=low", wait_until="networkidle")
        page.wait_for_function("() => window.__phloem && window.__phloem.header[23] > 0", timeout=120000)

        def sample(tag):
            for _ in range(2):
                cdp.send("HeapProfiler.collectGarbage")
            m = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
            gl = page.evaluate("() => ({...window.__gl})")
            lab = page.evaluate("() => { const l = window.__phloem.labels; return { keys: [['cap', l.cap], ['str', l.str.length], ['anchors', l.ancN]] }; }")
            workers_cdp = sum(1 for t in targets.values() if t["type"] == "worker")
            wheap = None
            for w in page.workers:
                try:
                    wheap = round(w.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null"), 1)
                except Exception:
                    pass
            cp = page.evaluate("() => window.__phloem.client.checkpoints && { count: window.__phloem.client.checkpoints.count, mb: Math.round(window.__phloem.client.checkpoints.bytes / 1048576) }")
            est = page.evaluate("() => navigator.storage.estimate().then((e) => e.usage)")
            r = {
                "tag": tag,
                "heapMB": round(m["JSHeapUsedSize"] / 1048576, 1),
                "nodes": int(m["Nodes"]),
                "listeners": int(m["JSEventListeners"]),
                "documents": int(m["Documents"]),
                "simWorkerHeapMB": wheap,
                "checkpoints": cp,
                "workersLive": workers_cdp,
                "workersJs": page.evaluate("() => window.__workers"),
                "gl": gl,
                "labels": lab["keys"],
                "storageKB": round((est or 0) / 1024),
                "commits": page.evaluate("() => window.__phloem.commits.length"),
            }
            rows.append(r)
            print(json.dumps(r), flush=True)

        def upload(path, label):
            page.click(".gm-new") if page.locator(".gm-new").is_visible() else None
            page.evaluate("(l) => { window.__phloem.source = ''; }", label)
            page.set_input_files(".gm-landing input[type=file]", path)
            page.wait_for_function(f"() => window.__phloem.source === {json.dumps(Path(path).name)} && window.__phloem.web.status && window.__phloem.web.status.state === 'done'", timeout=300000)
            page.wait_for_function("() => window.__phloem.header[1] >= 3", timeout=120000)

        def demo():
            page.evaluate("() => window.__phloem.web.loadDemo()")  # dev-only history (no landing button any more)
            page.wait_for_function("() => window.__phloem.commits.length === 336 && window.__phloem.header[1] >= 3", timeout=120000)

        sample("landing backdrop")
        for i in range(CYCLES):
            upload(LOG_A, "A")
            page.evaluate("() => window.__phloem.speed(16)")
            page.wait_for_timeout(2500)
            sample(f"cycle {i + 1}: A")
            upload(LOG_B, "B")
            page.wait_for_timeout(2500)
            sample(f"cycle {i + 1}: B")
            demo()
            page.wait_for_timeout(2500)
            sample(f"cycle {i + 1}: demo")

        # long playback on the full history at 16x
        page.evaluate("() => { window.__phloem.speed(16); window.__phloem.play(true); window.__phloem.setLabelMode('all'); }")
        t0 = time.time()
        k = 0
        while time.time() - t0 < PLAY_S:
            page.wait_for_timeout(PLAY_S * 1000 // 6)
            k += 1
            sample(f"playback {k} (commit {page.evaluate('() => window.__phloem.header[1]')})")
        perf = page.evaluate("() => ({fps: window.__phloem.perf.fps, frameMs: window.__phloem.perf.frameMs, uploadMs: window.__phloem.perf.uploadMs, labelMs: window.__phloem.perf.labelMs, stepMs: window.__phloem.header[9], packMs: window.__phloem.header[10], segs: window.__phloem.header[2]})")
        print("perf during playback:", json.dumps(perf))
        print("console errors/warnings:", errors[:5])
        Path(OUT, "leak.json").write_text(json.dumps({"rows": rows, "perf": perf, "errors": errors[:20]}, indent=1))
        b.close()


main()
