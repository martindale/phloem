# SPDX-License-Identifier: AGPL-3.0-only
"""Regenerate the raster assets in public/ (favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png, og.png).

The icons are rendered from public/favicon.svg; og.png is a real screenshot of the app (StemDeck history, late in the replay,
chrome hidden, zoomed in a little) with the wordmark drawn over it. Needs a running e2e build (`npm run build:e2e`, which keeps the test hook; serve it as in tests/e2e/README.md) and Playwright:
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python scripts/web-assets.py http://localhost:5481/
"""
import shutil
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5290/"
PUB = Path(__file__).resolve().parent.parent / "public"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

SVG = (PUB / "favicon.svg").read_text()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    for name, size, pad in (("favicon-32.png", 32, 0), ("apple-touch-icon.png", 180, 0), ("icon-192.png", 192, 0), ("icon-512.png", 512, 0)):
        ctx = b.new_context(viewport={"width": 600, "height": 600}, device_scale_factor=1)
        page = ctx.new_page()
        page.set_content(f"<body style='margin:0;background:#0f0b06'><div style='width:{size}px;height:{size}px'>{SVG.replace('<svg ', f'<svg width=\"{size}\" height=\"{size}\" ', 1)}</div></body>")
        page.screenshot(path=str(PUB / name), clip={"x": 0, "y": 0, "width": size, "height": size})
        ctx.close()

    ctx = b.new_context(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
    page = ctx.new_page()
    page.goto(BASE + "?demo&labels=off&speed=1&paused", wait_until="networkidle")
    page.wait_for_function("() => window.__phloem && window.__phloem.commits.length === 336", timeout=120000)
    page.evaluate("() => window.__phloem.seek(330)")
    page.wait_for_function("() => window.__phloem.header[1] >= 329", timeout=120000)
    page.keyboard.press("h")  # hide the chrome
    page.evaluate("() => { const c = window.__phloem.camera; c.snap(); }")
    page.wait_for_timeout(6000)
    page.evaluate("() => window.__phloem.camera.snap()")
    page.wait_for_timeout(4000)
    # zoom in a little and pan the mold to the right so the wordmark has room on the left (this also takes the camera from the
    # director for a few seconds)
    page.mouse.move(570, 260)
    page.mouse.wheel(0, -260)
    page.wait_for_timeout(2500)
    page.mouse.move(570, 260)
    page.mouse.down()
    page.mouse.move(700, 270, steps=8)
    page.mouse.up()
    page.wait_for_timeout(1500)
    page.wait_for_timeout(3000)
    page.evaluate(
        """() => {
          const d = document.createElement('div');
          const s = d.style;
          s.position = 'fixed'; s.left = '0'; s.top = '0'; s.right = '0'; s.bottom = '0'; s.zIndex = '99'; s.pointerEvents = 'none';
          s.background = 'linear-gradient(to right, rgba(10,7,3,0.92) 0%, rgba(10,7,3,0.6) 38%, rgba(10,7,3,0) 62%)';
          const t = document.createElement('div');
          const ts = t.style;
          ts.position = 'absolute'; ts.left = '64px'; ts.bottom = '70px'; ts.width = '480px';
          ts.fontFamily = "'Fraunces GM', Georgia, serif"; ts.color = '#ffe7a3'; ts.fontWeight = '380';
          const h = document.createElement('div'); h.textContent = 'Phloem'; h.style.fontSize = '84px'; h.style.lineHeight = '1'; h.style.letterSpacing = '-0.01em';
          const q = document.createElement('div'); q.textContent = 'Watch a repository grow like a slime mold.'; q.style.fontSize = '32px'; q.style.lineHeight = '1.2'; q.style.marginTop = '18px'; q.style.color = '#e6c477';
          t.append(h, q); d.append(t); document.body.append(d);
        }"""
    )
    page.wait_for_timeout(500)
    raw = PUB / "og.raw.png"
    page.screenshot(path=str(raw))
    ctx.close()
    b.close()
# keep og.png small (crawlers prefer well under 1 MB): a 256-colour palette with error diffusion looks the same on this dark artwork
# (ffmpeg is optional; without it the full-colour screenshot is used as is)
raw = PUB / "og.raw.png"
if shutil.which("ffmpeg"):
    vf = "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-vf", vf, "-frames:v", "1", str(PUB / "og.png")], check=True)
    raw.unlink()
else:
    raw.replace(PUB / "og.png")
print("wrote", [f.name for f in sorted(PUB.glob("*.png"))])
