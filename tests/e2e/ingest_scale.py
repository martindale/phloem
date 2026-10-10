# SPDX-License-Identifier: AGPL-3.0-only
"""Browser-side scale check: upload a huge git log (e.g. 20k commits / 15k files, ~45 MB) and measure what the user feels.

  npm run synth-log -- scratch/big.log 15000 20000
  .venv/bin/python tests/e2e/ingest_scale.py http://localhost:5199/ scratch/big.log screenshots/ingest
Reports: time to first commit on screen, time until fully parsed, main-thread long tasks during the load (UI freezes), JS heap,
sim step cost, checkpoint stats, and seek timings (backward/forward).
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE, LOG, OUT = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "screenshots/ingest"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-precise-memory-info"]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    pg = b.new_page(viewport={"width": 1000, "height": 700})
    logs = []
    pg.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    pg.add_init_script("""
      window.__long = []; window.__raf = 0;
      new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({entryTypes: ['longtask']});
      (function tick(){ window.__raf++; requestAnimationFrame(tick); })();
    """)
    pg.goto(BASE + "?speed=8", wait_until="networkidle")
    t0 = time.time()
    pg.set_input_files(".gm-landing input[type=file]", LOG)
    pg.wait_for_function("() => window.__phloem.header[1] >= 0 && window.__phloem.commits.length > 0", timeout=120000)
    t_first = time.time() - t0
    pg.wait_for_function("() => window.__phloem.web.status && window.__phloem.web.status.state === 'done'", timeout=300000)
    t_done = time.time() - t0
    n = pg.evaluate("() => window.__phloem.commits.length")
    lt = pg.evaluate("() => window.__long")
    heap = pg.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null")
    print(f"first commits visible after {t_first:.2f}s; all {n} commits parsed+appended after {t_done:.2f}s")
    print(f"main-thread long tasks during load: {len(lt)} (max {max(lt) if lt else 0:.0f} ms, total {sum(lt):.0f} ms)")
    print(f"main-thread JS heap: {heap:.0f} MB")
    # let the sim run at 8x for a while
    t1 = time.time()
    pg.wait_for_timeout(25000)
    h = pg.evaluate("() => Array.from(window.__phloem.header)")
    cp = pg.evaluate("() => window.__phloem.client.checkpoints")
    print(f"after {time.time()-t1:.0f}s of 8x playback: commit {h[1]:.0f}/{h[15]:.0f} tick {h[0]:.0f} files {h[20]:.0f} segs {h[2]:.0f} sim {h[9]:.2f} ms/tick, streaming={h[28]:.0f} waiting={h[29]:.0f}")
    print("checkpoints:", json.dumps(cp))
    pg.screenshot(path=f"{OUT}/11-scale-20k-playing.png", timeout=300000)
    # seeks (paused, so the commit number is stable once a seek settles)
    pg.evaluate("() => window.__phloem.play(false)")
    pg.wait_for_timeout(1500)
    for target in (n - 1, 2000, 10, n // 2):
        t = time.time()
        pg.evaluate(f"() => window.__phloem.seek({target})")
        try:
            pg.wait_for_function(f"() => {{ const h = window.__phloem.header; return h[1] === {target} && h[14] === 0 && h[0] > 0; }}", timeout=240000)
            print(f"seek to commit {target}: {time.time()-t:.1f}s")
        except Exception as e:
            print(f"seek to commit {target}: TIMEOUT ({str(e)[:60]})")
    print("console:", logs[:5])
    b.close()
