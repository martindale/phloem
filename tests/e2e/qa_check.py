# SPDX-License-Identifier: AGPL-3.0-only
"""Integration QA of the combined app (production build): input bindings, labels, director, fps cap, quality tiers, hostile data,
keyboard accessibility, console/CSP cleanliness. Complements web_check.py (landing, loading, share link, states) and
ingest_check.py (uploads, mocked GitHub).

  npm run build:e2e && npx vite preview --outDir dist-e2e --port 5299 --strictPort &
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python tests/e2e/qa_check.py http://127.0.0.1:5299/ OUTDIR [section ...]

Sections: input touch labels director fps quality hostile a11y csp drop switch  (default: all). Software GL is slow, so the scenes are paused
and positioned with the window.__phloem hooks. Every request that would leave the origin is refused and reported.
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = args[0] if args else "http://127.0.0.1:5299/"
OUT = args[1] if len(args) > 1 else "screenshots/qa"
SECTIONS = args[2:] or ["input", "touch", "labels", "director", "fps", "quality", "hostile", "a11y", "csp", "drop", "switch"]
LAUNCH = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
Path(OUT).mkdir(parents=True, exist_ok=True)
fails = []

CSP_HOOK = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
window.__pwn = 0;
"""


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    if not cond:
        fails.append(msg)


class Page:
    def __init__(self, browser, query="", size=(1100, 720), touch=False, mock=None, **ctx_opts):
        self.ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, has_touch=touch, **ctx_opts)
        self.ctx.add_init_script(CSP_HOOK)
        self.external = []

        def guard(route):
            self.external.append(route.request.url)
            route.abort()

        self.ctx.route(lambda u: not u.startswith(BASE) and not u.startswith("data:") and not u.startswith("blob:"), mock.handler if mock else guard)
        self.page = self.ctx.new_page()
        self.logs = []
        self.page.on("console", lambda m: self.logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
        self.page.on("pageerror", lambda e: self.logs.append(("pageerror", str(e))))
        self.page.goto(BASE + query, wait_until="networkidle")

    def js(self, expr, arg=None):
        return self.page.evaluate(expr, arg) if arg is not None else self.page.evaluate(expr)

    def wait(self, expr, timeout=90):
        self.page.wait_for_function(expr, timeout=timeout * 1000)

    def engine(self):
        self.wait("() => !!window.__phloem && window.__phloem.header[23] > 0", 120)

    def at_commit(self, n, timeout=180):
        self.js(f"() => window.__phloem.seek({n})")
        self.wait(f"() => {{ const h = window.__phloem.header; return h[1] === {n} && h[14] === 0; }}", timeout)

    def frames(self, n=3):
        self.js("(n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); })", n)

    def cam(self):
        return self.js("() => { const c = window.__phloem.camera; return {yaw: c.yaw, pitch: c.pitch, dist: c.dist, tx: c.tx, ty: c.ty, tz: c.tz, auto: c.auto, rot: c.autoRotate}; }")

    def shot(self, name):
        self.page.screenshot(path=f"{OUT}/{name}.png")

    def errors(self):
        return [l for l in self.logs if l[0] in ("error", "pageerror", "warning")]

    def clean(self, what):
        csp = self.js("() => window.__csp")
        check(not csp, f"{what}: no CSP violations {csp[:2]}")
        check(not self.errors(), f"{what}: no console errors/warnings {self.errors()[:3]}")
        check(not self.external, f"{what}: no request left the origin {self.external[:3]}")

    def close(self):
        self.ctx.close()


def demo(b, query="?demo&paused&quality=low", **kw):
    p = Page(b, query, **kw)
    p.engine()
    p.wait("() => window.__phloem.commits.length === 336", 60)
    return p


# ---------------------------------------------------------------------------------------------------------------------------------
def s_input(b):
    p = demo(b)
    p.at_commit(40)
    p.js("() => { const g = window.__phloem; g.manualDirector = true; g.camera.reset(); }")  # the director is always on: freeze its stepping so the poses below are deterministic
    p.js("() => window.__phloem.camera.snap()")
    p.frames(2)
    pg = p.page
    c0 = p.cam()
    check(c0["auto"], "starts in auto framing")
    # left drag = pan
    pg.mouse.move(500, 300)
    pg.mouse.down()
    for i in range(1, 9):
        pg.mouse.move(500 + i * 12, 300 + i * 6)
    pg.mouse.up()
    p.frames(6)
    c1 = p.cam()
    moved = abs(c1["tx"] - c0["tx"]) + abs(c1["ty"] - c0["ty"]) + abs(c1["tz"] - c0["tz"])
    check(moved > 0.5 and abs(c1["yaw"] - c0["yaw"]) < 1e-6 and abs(c1["pitch"] - c0["pitch"]) < 1e-6 and not c1["auto"], f"left-drag pans (target moved {moved:.1f}, angles unchanged, manual)")
    # wheel zoom
    pg.mouse.move(500, 300)
    pg.mouse.wheel(0, -400)
    p.frames(8)
    c2 = p.cam()
    check(c2["dist"] < c1["dist"] * 0.9, f"wheel up zooms in ({c1['dist']:.0f} -> {c2['dist']:.0f})")
    pg.mouse.wheel(0, 800)
    p.frames(8)
    c3 = p.cam()
    check(c3["dist"] > c2["dist"] * 1.1, f"wheel down zooms out ({c2['dist']:.0f} -> {c3['dist']:.0f})")
    # double click resets
    pg.mouse.dblclick(500, 300)
    p.frames(3)
    c4 = p.cam()
    check(c4["auto"], "double-click resets to auto framing")
    # middle drag = orbit
    pg.mouse.move(500, 300)
    pg.mouse.down(button="middle")
    for i in range(1, 9):
        pg.mouse.move(500 + i * 15, 300 - i * 4)
    pg.mouse.up(button="middle")
    p.frames(6)
    c5 = p.cam()
    check(abs(c5["yaw"] - c4["yaw"]) > 0.05 and c5["auto"], f"middle-drag orbits (yaw {c4['yaw']:.2f} -> {c5['yaw']:.2f}) and keeps auto framing")
    p.js("() => window.__phloem.camera.reset()")
    p.frames(3)
    c6 = p.cam()
    # right button is inert
    pg.mouse.move(500, 300)
    pg.mouse.down(button="right")
    for i in range(1, 9):
        pg.mouse.move(500 + i * 15, 300 + i * 9)
    pg.mouse.up(button="right")
    p.frames(5)
    c7 = p.cam()
    check(abs(c7["yaw"] - c6["yaw"]) < 1e-6 and abs(c7["pitch"] - c6["pitch"]) < 1e-6 and c7["auto"], "right-drag does nothing (no orbit, no pan)")
    prevented = p.js("() => !document.getElementById('stage').dispatchEvent(new MouseEvent('contextmenu', {cancelable: true, bubbles: true}))")
    check(prevented, "context menu is suppressed on the canvas")
    # keys: the cinematic camera is always on; O (turntable) and C (director toggle) were retired and do nothing
    pg.mouse.move(520, 320)
    pg.keyboard.press("o")
    pg.keyboard.press("c")
    check(not p.js("() => window.__phloem.camera.autoRotate") and p.js("() => window.__phloem.director.enabled"), "O and C do nothing; the director stays on")
    check(pg.locator(".gm-director").count() == 0, "there is no Director button")
    # drag then R resets
    pg.mouse.move(500, 300)
    pg.mouse.down()
    pg.mouse.move(560, 340, steps=4)
    pg.mouse.up()
    p.frames(4)
    check(not p.cam()["auto"], "manual after a pan")
    pg.keyboard.press("r")
    p.frames(3)
    check(p.cam()["auto"], "R resets")
    # play/pause with Space, arrows seek
    check(p.js("() => document.querySelector('.gm-play').getAttribute('aria-label')") == "Play", "paused at start (?paused)")
    pg.keyboard.press("Space")
    check(p.js("() => document.querySelector('.gm-play').getAttribute('aria-label')") == "Pause", "Space plays")
    pg.keyboard.press("Space")
    pg.keyboard.press("ArrowRight")
    p.wait("() => window.__phloem.header[1] >= 41 && window.__phloem.header[14] === 0", 90)
    check(True, "ArrowRight steps to the next commit")
    p.shot("input-final")
    p.clean("input")
    p.close()


def s_touch(b):
    p = demo(b, size=(480, 800), touch=True)
    p.at_commit(40)
    p.js("() => { const g = window.__phloem; g.manualDirector = true; g.camera.reset(); }")  # the director is always on: freeze its stepping so the poses below are deterministic
    p.js("() => window.__phloem.camera.snap()")
    p.frames(2)
    cdp = p.ctx.new_cdp_session(p.page)

    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    c0 = p.cam()
    touch("touchStart", [(240, 400)])
    for i in range(1, 9):
        touch("touchMove", [(240 + i * 14, 400 + i * 4)])
    touch("touchEnd", [])
    p.frames(6)
    c1 = p.cam()
    check(abs(c1["yaw"] - c0["yaw"]) > 0.03, f"one-finger drag orbits (yaw {c0['yaw']:.2f} -> {c1['yaw']:.2f})")
    d0 = c1["dist"]
    touch("touchStart", [(200, 400), (280, 400)])
    for i in range(1, 8):
        touch("touchMove", [(200 - i * 12, 400), (280 + i * 12, 400)])
    touch("touchEnd", [])
    p.frames(4)
    c2 = p.cam()
    check(c2["dist"] < d0 * 0.8, f"pinch out zooms in ({d0:.0f} -> {c2['dist']:.0f})")
    for _ in range(2):
        touch("touchStart", [(240, 400)])
        touch("touchEnd", [])
        time.sleep(0.08)
    p.frames(4)
    check(p.cam()["auto"], "double tap resets")
    p.shot("touch-final")
    p.clean("touch")
    p.close()


def s_labels(b):
    p = demo(b, "?demo&paused&quality=low&labels=all", size=(1280, 800))
    p.at_commit(60)
    p.js("() => { const g = window.__phloem; g.manualDirector = true; g.camera.reset(); }")  # the director is always on: freeze its stepping so the poses below are deterministic
    p.js("() => window.__phloem.camera.snap()")
    p.frames(6)
    check(p.js("() => window.__phloem.labels.mode") == "all", "?labels=all starts in all mode")
    p.shot("labels-all")
    for want in ("active", "off", "all"):
        p.page.keyboard.press("l")
        check(p.js("() => window.__phloem.labels.mode") == want, f"L cycles to {want}")
    check("Names: all" in p.page.locator(".gm-names").inner_text(), "Names button text follows")
    # hover: find a reached file anchor on screen and move the pointer over it
    pos = p.js(
        """() => { const g = window.__phloem, l = g.labels, c = g.camera, out = [0, 0, 0, 0];
        for (let i = 0; i < l.ancN; i++) { if (l.anc[i*5+4] < 0.5) continue; const id = l.anc[i*5];
          if (!c.project(l.anc[i*5+1], l.anc[i*5+2], l.anc[i*5+3], out)) continue;
          const dpr = g.renderer.width / document.getElementById('stage').clientWidth;
          const x = out[0] / dpr, y = out[1] / dpr; if (x > 80 && x < innerWidth - 80 && y > 140 && y < innerHeight - 200) return {x, y, id}; }
        return null; }"""
    )
    check(pos is not None, "found a reached anchor on screen")
    if pos:
        p.page.mouse.move(pos["x"], pos["y"])
        p.page.mouse.move(pos["x"] + 1, pos["y"] + 1)
        p.wait("() => window.__phloem.labels.hoverId >= 0", 30)
        p.frames(2)
        tip = p.page.locator(".tip")
        check(tip.is_visible() and len(tip.inner_text()) > 3, f"hover shows the tooltip: {tip.inner_text()[:80]!r}")
        p.shot("labels-hover")
        p.page.mouse.move(5, 400)
        p.wait("() => window.__phloem.labels.hoverId < 0", 30)
        check(p.page.locator(".tip").is_hidden(), "tooltip hides when the pointer leaves")
    # reached-gating: right after the first commits only reached nodes may carry a visible label
    p.at_commit(2)
    p.frames(4)
    viol = p.js(
        """() => { const l = window.__phloem.labels; let v = 0;
        for (let i = 0; i < l.liveN; i++) { const key = l.live[i]; if (key < 32 || l.alpha[key] < 0.05 || l.tgt[key] <= 0) continue;
          const ai = l.anchorIndex(key - 32); if (ai < 0 || l.anc[ai*5+4] < 0.5) v++; } return v; }"""
    )
    check(viol == 0, f"no visible label belongs to an unreached node ({viol})")
    p.clean("labels")
    p.close()


def s_director(b):
    p = demo(b, "?demo&paused&quality=low", size=(1100, 720))
    p.at_commit(30)
    check(p.js("() => window.__phloem.director.enabled"), "the director is on from the first frame (no parameter needed)")
    check(p.js("() => window.__phloem.camera.autoRotateSuppressed"), "the turntable is suppressed while it directs")
    check(p.page.locator(".gm-director").count() == 0, "no Director button in the chrome")
    p.page.keyboard.press("c")
    check(p.js("() => window.__phloem.director.enabled"), "C does not switch it off")
    p.page.mouse.move(500, 300)
    p.page.mouse.down()
    p.page.mouse.move(540, 330, steps=3)
    p.frames(2)
    check(p.js("() => window.__phloem.director.state") == "user", "user input hands the camera over at once")
    p.page.mouse.up()
    p.page.wait_for_timeout(1500)
    check("director" not in p.js("() => location.search") and "orbit" not in p.js("() => location.search"), "the shared URL carries no director/orbit parameter")
    p.shot("director-user")
    p.clean("director")
    p.close()
    p = Page(b, "?demo&paused&quality=low&director=0&orbit=0")
    p.engine()
    check(p.js("() => window.__phloem.director.enabled"), "the retired ?director=0 does not switch it off")
    p.page.wait_for_timeout(1500)
    check("director" not in p.js("() => location.search"), "...and is dropped from the address bar")
    p.close()
    p = Page(b, "")
    p.engine()
    p.wait("() => window.__phloem.header[1] > 3", 90)
    check(p.js("() => window.__phloem.director.enabled"), "landing backdrop runs with the director on")
    p.close()
    p = Page(b, "", reduced_motion="reduce")
    p.engine()
    p.wait("() => window.__phloem.header[1] > 3", 90)
    check(p.js("() => window.__phloem.director.enabled && window.__phloem.director.reduced"), "reduced motion: the director still runs, at a reduced rate")
    p.close()


def s_fps(b):
    # a tiny canvas renders fast enough even under software GL to see the cap bite
    for q, expect in (("?demo&quality=low&fps=15&stats", 15), ("?demo&quality=low&fps=off&stats", 0), ("?demo&quality=low&stats", 100), ("?demo&quality=low&fps=9999&stats", 240), ("?demo&quality=low&fps=abc&stats", 100)):
        p = Page(b, q, size=(160, 120))
        p.engine()
        p.wait("() => document.querySelector('.gm-stats').textContent.includes('fps cap')", 60)
        text = p.js("() => document.querySelector('.gm-stats').textContent")
        want = "fps cap off" if expect == 0 else f"fps cap {expect}"
        check(want in text, f"{q}: stats say '{want}'")
        if expect == 15:
            p.page.wait_for_timeout(3000)
            fr = p.js("() => window.__phloem.perf.fps")
            check(0 < fr <= 17, f"fps cap 15 holds the measured frame rate at {fr:.1f}")
        p.close()


def s_quality(b):
    for tier in ("high", "medium", "low"):
        p = Page(b, f"?demo&paused&quality={tier}", size=(640, 420))
        p.engine()
        q = p.js("() => ({tier: window.__phloem.quality.tier, auto: window.__phloem.quality.auto, fx: window.__phloem.renderer.effects})")
        check(q["tier"] == tier and not q["auto"], f"?quality={tier} pins the tier ({q['tier']})")
        if tier == "low":
            check(not q["fx"]["gel"] and not q["fx"]["radiusPulse"], "low: gel and radius pulse off")
        if tier == "high":
            check(q["fx"]["gel"], "high: gel on")
        p.clean(f"quality {tier}")
        p.close()
    p = Page(b, "?demo&paused&quality=high", size=(640, 420), reduced_motion="reduce")
    p.engine()
    check(p.js("() => window.__phloem.renderer.reducedMotion") is True, "prefers-reduced-motion reaches the renderer (calmer streaming, no motes)")
    p.clean("reduced motion viewer")
    p.close()
    p = Page(b, "?demo&paused&quality=bogus", size=(640, 420))
    p.engine()
    check(p.js("() => window.__phloem.quality.auto") is True, "an unknown ?quality value means auto")
    p.close()


HOSTILE_LOG = """@@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t2024-01-01T10:00:00Z\t<img src=x onerror=window.__pwn=1>\tx@y.z\t<svg onload=window.__pwn=2> first
:000000 100644 0000000 1111111 A\tsrc/<img src=x onerror=window.__pwn=3>/a.ts
:000000 100644 0000000 1111111 A\t__proto__/constructor/prototype/polluted.txt
:000000 100644 0000000 1111111 A\tconstructor/x.ts
10\t0\tsrc/<img src=x onerror=window.__pwn=3>/a.ts
@@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t2024-01-02T10:00:00Z\t"><script>window.__pwn=4</script>\tx@y.z\t</div><iframe src=javascript:window.__pwn=5>
:100644 100644 1111111 2222222 M\tsrc/<img src=x onerror=window.__pwn=3>/a.ts
:000000 100644 0000000 1111111 A\tdocs/weird name.md
3\t1\tsrc/<img src=x onerror=window.__pwn=3>/a.ts
"""


def s_hostile(b):
    d = Path(OUT, "_hostile")
    d.mkdir(exist_ok=True)
    f = d / "hostile.log"
    f.write_text(HOSTILE_LOG)
    j = d / "hostile.json"
    # JSON.stringify never emits an own "__proto__" key, so write the text by hand
    j.write_text(
        '[{"hash":"' + "c" * 40 + '","author":"<img src=x onerror=window.__pwn=6>","email":"a@b","date":"2024-01-01T00:00:00Z","message":"<b>m</b>",'
        '"__proto__":{"polluted":1},"files":[{"path":"a/b.txt","status":"A","added":1,"removed":0,"__proto__":{"polluted":2}}]}]'
    )
    p = Page(b, "")
    p.engine()
    p.page.set_input_files(".gm-landing input[type=file]", str(f))
    p.wait("() => window.__phloem.web.status && window.__phloem.web.status.state === 'done'", 60)
    p.wait("() => !document.querySelector('.gm-chrome').classList.contains('is-backdrop')", 60)
    p.js("() => window.__phloem.play(false)")
    p.at_commit(1)
    p.js("() => window.__phloem.camera.snap()")
    p.page.mouse.move(600, 400)
    p.frames(4)
    p.page.click(".gm-legend-btn")
    p.shot("hostile-viewer")
    check(p.js("() => window.__pwn") == 0, "no hostile string executed in the viewer")
    check(p.js("() => document.querySelectorAll('body img, body iframe, body script:not([src])').length") == 0, "no injected elements in the DOM")
    text = p.page.locator(".gm-caption").inner_text() + p.page.locator(".gm-legend").inner_text()
    check("<img" in text or "<svg" in text or "<script" in text, f"hostile strings are shown as plain text: {text[:80]!r}")
    check(p.js("() => ({}).polluted") is None, "prototype untouched after a __proto__ path")
    p.js("() => window.__phloem.setLabelMode('all')")
    p.frames(4)
    check(p.js("() => window.__pwn") == 0, "labels did not execute anything")
    # hover a hostile-named label
    pos = p.js(
        """() => { const g = window.__phloem, l = g.labels, c = g.camera, out = [0, 0, 0, 0];
        for (let i = 0; i < l.ancN; i++) { if (l.anc[i*5+4] < 0.5) continue;
          if (!c.project(l.anc[i*5+1], l.anc[i*5+2], l.anc[i*5+3], out)) continue;
          const dpr = g.renderer.width / document.getElementById('stage').clientWidth; return {x: out[0] / dpr, y: out[1] / dpr}; } return null; }"""
    )
    if pos:
        p.page.mouse.move(pos["x"], pos["y"])
        p.page.mouse.move(pos["x"] + 1, pos["y"])
        p.frames(3)
        check(p.js("() => window.__pwn") == 0, "hovering a hostile label executed nothing")
    # JSON upload with a __proto__ key
    p.page.click(".gm-new")
    p.page.click(".gm-log-box summary")
    p.page.set_input_files(".gm-landing input[type=file]", str(j))
    p.wait("() => window.__phloem.web.status && window.__phloem.web.status.state === 'done' && window.__phloem.source === 'hostile.json'", 60)
    check(p.js("() => ({}).polluted") is None and p.js("() => Object.prototype.polluted") is None, "JSON with a __proto__ key does not pollute Object.prototype")
    check(p.js("() => window.__pwn") == 0, "no hostile string executed (JSON)")
    p.clean("hostile upload")
    p.close()
    # hostile ?repo= reflected in the card
    p = Page(b, "?repo=%3Cimg%20src%3Dx%20onerror%3Dwindow.__pwn%3D7%3E")
    p.page.wait_for_selector(".gm-landing:not([hidden])")
    check(p.js("() => window.__pwn") == 0, "hostile ?repo= is not executed")
    check("<img" in p.page.locator("#gm-err").inner_text(), "hostile ?repo= is echoed as text")
    check(p.js("() => document.querySelectorAll('.gm-landing img').length") == 0, "no <img> injected on the card")
    p.close()
    p = Page(b, "?demo&paused&quality=low&labels=%3Cscript%3E&speed=%3Cb%3E&t=%3Cimg%3E&mode=%22%3E&branch=%3Cb%3E")
    p.engine()
    check(p.js("() => window.__pwn") == 0, "hostile enum/number parameters are ignored")
    p.clean("hostile params")
    p.close()


def s_a11y(b):
    p = Page(b, "", size=(1100, 720))
    pg = p.page
    pg.wait_for_selector(".gm-landing:not([hidden])")
    order = []
    for _ in range(16):
        order.append(p.js("() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName).toString().slice(0, 40) + '|' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 24) : ''; }"))
        pg.keyboard.press("Tab")
    print("   landing focus order:", order)
    check(order[0].startswith("gm-repo"), "focus starts in the repository field")
    check(any("Visualize" in o for o in order), "Visualize is reachable by Tab")
    check(any("gm-feat" in o for o in order), "the featured repositories are reachable by Tab")
    check(len(set(order)) >= 10, "focus visits distinct controls (no trap)")
    h = p.js("() => ({lang: document.documentElement.lang, h1: document.querySelectorAll('h1').length, main: document.querySelectorAll('main').length, inputs: [...document.querySelectorAll('input,select')].filter((e) => !e.labels?.length && !e.getAttribute('aria-label') && e.type !== 'file' && !e.closest('[hidden]')).map((e) => e.id || e.className)})")
    check(h["lang"] == "en" and h["h1"] == 1 and h["main"] == 1, f"document language and landmarks: {h['lang']} h1={h['h1']} main={h['main']}")
    check(not h["inputs"], f"every visible form control has a label {h['inputs']}")
    src = p.js("() => [...document.querySelectorAll('a.gm-src')].map((a) => ({t: a.textContent, rel: a.rel, target: a.target, href: a.href}))")
    check(len(src) == 2 and all(a["t"] == "Source code (AGPL-3.0)" and "noopener" in a["rel"] and "noreferrer" in a["rel"] and a["target"] == "_blank" for a in src), f"AGPL source link in the landing footer and the viewer chrome: {src}")
    pg.click(".gm-feat[data-repo='stemdeckapp/stemdeck']")  # prebuilt: 336 commits, no GitHub request
    p.wait("() => window.__phloem && window.__phloem.commits.length === 336 && !document.querySelector('.gm-chrome').classList.contains('is-backdrop')", 90)
    p.js("() => window.__phloem.play(false)")
    pg.mouse.move(300, 300)
    names = p.js("() => [...document.querySelectorAll('.gm-chrome button, .gm-chrome select, .gm-chrome input, .gm-chrome a')].filter((e) => !e.closest('[hidden]')).map((e) => ({n: (e.getAttribute('aria-label') || e.textContent || e.title || '').trim()}))")
    unnamed = [n for n in names if not n["n"]]
    check(not unnamed, f"every viewer control has an accessible name ({len(names)} controls, unnamed {unnamed})")
    pg.focus(".gm-tok-btn")
    pg.keyboard.press("Enter")
    check(pg.locator(".gm-pop").is_visible(), "token popover opens with Enter")
    check(p.js("() => document.activeElement.classList.contains('gm-tp-input')"), "focus moves into the popover")
    pg.keyboard.press("Escape")
    check(pg.locator(".gm-pop").is_hidden(), "Escape closes the popover")
    check(p.js("() => document.activeElement.classList.contains('gm-tok-btn')"), "focus returns to the trigger")
    pg.focus(".gm-clear")
    pg.keyboard.press("Enter")
    pg.wait_for_selector(".gm-pop button")
    pg.keyboard.press("Escape")
    check(pg.locator(".gm-pop").is_hidden(), "Escape closes the clear-saved dialog")
    pg.focus(".gm-legend-btn")
    pg.keyboard.press("Enter")
    check(pg.locator(".gm-legend").is_visible() and pg.get_attribute(".gm-legend-btn", "aria-expanded") == "true", "legend opens with the keyboard")
    pg.keyboard.press("Escape")
    check(pg.locator(".gm-legend").is_hidden(), "Escape closes the legend")
    pg.focus(".gm-new")
    pg.keyboard.press("Enter")
    check(pg.locator(".gm-landing.is-overlay").is_visible(), "brand button opens the card")
    check(p.js("() => document.querySelector('.gm-chrome').hasAttribute('inert')"), "viewer chrome is inert behind the open card")
    pg.keyboard.press("Escape")
    check(pg.locator(".gm-landing").is_hidden(), "Escape closes the card")
    check(p.js("() => document.activeElement.classList.contains('gm-new')"), "focus returns to the brand button")
    check(pg.get_attribute(".gm-scrub", "aria-label") == "Commit", "scrubber has a name")
    pg.focus(".gm-scrub")
    pg.keyboard.press("ArrowRight")
    p.wait("() => window.__phloem.header[1] >= 1", 60)
    check(True, "scrubber responds to the arrow keys")
    p.clean("a11y")
    p.close()


def s_csp(b):
    """Workers, fonts, IndexedDB and the engine under the production CSP, on each way in (the GitHub path is covered by web_check)."""
    for q in ("", "?demo&paused&quality=low", "?repo=acme/none"):
        p = Page(b, q, size=(900, 600))
        if "repo" in q:
            p.wait("() => !!window.__phloem", 120)
        else:
            p.engine()
        p.wait("() => document.fonts.check('16px \"Fraunces GM\"')", 20)
        p.js("() => new Promise((r) => { const q = indexedDB.open('phloem-qa'); q.onsuccess = () => { q.result.close(); r(); }; q.onerror = () => r(); })")
        if "repo" not in q:
            p.clean(f"csp {q or 'landing'}")
        p.close()


class SlowGithub:
    """Minimal fake api.github.com: one repo with `commits` commits, `delay` seconds per commit-detail request."""

    def __init__(self, commits=40, delay=0.15):
        self.commits, self.delay, self.calls = commits, delay, []

    def handler(self, route):
        path = route.request.url.split("api.github.com", 1)[1]
        self.calls.append(path)
        h = {"access-control-allow-origin": "*", "access-control-expose-headers": "x-ratelimit-remaining, x-ratelimit-limit, x-ratelimit-reset", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": str(int(time.time()) + 1800), "content-type": "application/json"}
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers={**h, "access-control-allow-headers": "authorization, accept"})
        base = path.split("?")[0]
        if base.startswith("/rate_limit"):
            return route.fulfill(status=200, headers=h, body=json.dumps({"resources": {"core": {"limit": 5000, "remaining": 4000, "reset": int(time.time()) + 1800}}}))
        if base.count("/") == 3:
            return route.fulfill(status=200, headers=h, body=json.dumps({"default_branch": "main", "private": False}))
        if "/commits?" in path:
            items = [{"sha": f"{i:040x}", "parents": [{"sha": f"{i-1:040x}"}] if i > 1 else [], "commit": {"message": f"commit {i}", "tree": {"sha": f"t{i}"}, "author": {"name": f"Dev {i % 3}", "email": "d@x", "date": f"2024-02-{(i % 28) + 1:02d}T10:00:00Z"}}} for i in range(self.commits, 0, -1)]
            return route.fulfill(status=200, headers=h, body=json.dumps(items))
        if "/commits/" in path:
            time.sleep(self.delay)
            i = int(base.split("/commits/")[1], 16)
            return route.fulfill(status=200, headers=h, body=json.dumps({"sha": f"{i:040x}", "files": [{"filename": f"pkg{i % 5}/f{i}.ts", "status": "added", "additions": 5, "deletions": 0}]}))
        return route.fulfill(status=404, headers=h, body=json.dumps({"message": "Not Found"}))


def s_drop(b):
    """Drag-and-drop anywhere: on the landing card and over the viewer, with a git log and with junk."""
    log = Path(OUT, "_drop.log")
    log.write_text(Path(__file__).resolve().parent.parent.parent.joinpath("fixtures", "stemdeck-first10.json").read_text())
    DROP = """async ({name, text}) => {
      const dt = new DataTransfer(); dt.items.add(new File([text], name, {type: 'text/plain'}));
      const fire = (type, target) => target.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt}));
      fire('dragenter', document.body); fire('dragover', document.body);
      const overlay = document.documentElement.classList.contains('gm-dropping');
      const prevented = !fire('drop', document.body);
      return {overlay, prevented, after: document.documentElement.classList.contains('gm-dropping')};
    }"""
    text = Path(OUT, "_drop.log").read_text()
    p = Page(b, "")
    p.engine()
    r = p.js(DROP, {"name": "dropped.json", "text": text})
    check(r["overlay"] and r["prevented"] and not r["after"], f"drop shows the overlay, is handled and clears it {r}")
    p.wait("() => window.__phloem.source === 'dropped.json' && window.__phloem.commits.length === 10", 90)
    check(p.page.locator(".gm-landing").is_hidden(), "the landing card closes on a drop")
    check("dropped.json" in p.page.locator(".gm-repo").inner_text(), "the dropped file is the title")
    # again, now over the viewer
    r = p.js(DROP, {"name": "second.log", "text": "@@" + "a" * 40 + "\t2024-01-01T00:00:00Z\tA\ta@b\tonly\n:000000 100644 0000000 1111111 A\tx.ts\n"})
    p.wait("() => window.__phloem.source === 'second.log' && window.__phloem.commits.length === 1", 90)
    check(True, "a second drop replaces the history")
    # junk: error on the card, history kept? (a failed file load must not leave the app in a half state)
    p.js(DROP, {"name": "junk.txt", "text": "hello\nnot a log\n"})
    p.page.wait_for_selector(".gm-landing:not([hidden]) .gm-banner:not([hidden])", timeout=60000)
    check("No commits found" in p.page.locator(".gm-banner").inner_text(), "junk drop explains itself on the card")
    # a text drag (no files) is left alone
    r = p.js("() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hi'); const e = new DragEvent('dragenter', {bubbles: true, cancelable: true, dataTransfer: dt}); document.body.dispatchEvent(e); return document.documentElement.classList.contains('gm-dropping'); }")
    check(not r, "dragging text does not show the drop overlay")
    p.clean("drop")
    p.close()


def s_switch(b):
    """Switch history mid-load and repeatedly: nothing from the old session may leak into the new one."""
    mock = SlowGithub(commits=40, delay=0.3)
    p = Page(b, "", mock=mock)
    p.engine()
    pg = p.page
    pg.fill("#gm-repo", "acme/mold")
    pg.click(".gm-go")
    p.wait("() => window.__phloem.commits.length >= 3 && window.__phloem.web.status && window.__phloem.web.status.state === 'running'", 60)
    n_before = p.js("() => window.__phloem.commits.length")
    pg.click(".gm-new")
    pg.click(".gm-feat[data-repo='stemdeckapp/stemdeck']")
    p.wait("() => window.__phloem.commits.length === 336", 60)
    calls = len(mock.calls)
    pg.wait_for_timeout(2500)
    check(p.js("() => window.__phloem.commits.length") == 336, "the featured history is untouched by the abandoned GitHub load")
    check(len(mock.calls) - calls <= 1, f"the abandoned GitHub load stopped requesting ({len(mock.calls) - calls} more calls)")
    check(not pg.locator(".gm-status:not([hidden])").count() or "acme" not in pg.locator(".gm-status").inner_text(), "no stale GitHub status after switching to a featured repository")
    check("stemdeckapp/stemdeck" in pg.url and "acme" not in pg.url, f"URL follows the featured repository: {pg.url}")
    # GitHub -> file mid-load
    pg.click(".gm-new")
    pg.fill("#gm-repo", "acme/mold2")
    pg.click(".gm-go")
    p.wait("() => window.__phloem.web.status && window.__phloem.web.status.state === 'running' && window.__phloem.commits.length >= 2", 60)
    f = Path(OUT, "_switch.json")
    f.write_text(Path(__file__).resolve().parent.parent.parent.joinpath("fixtures", "stemdeck-first10.json").read_text())
    pg.click(".gm-new")
    pg.click(".gm-log-box summary")
    pg.set_input_files(".gm-landing input[type=file]", str(f))
    p.wait("() => window.__phloem.source === '_switch.json' && window.__phloem.web.status && window.__phloem.web.status.state === 'done'", 60)
    calls = len(mock.calls)
    pg.wait_for_timeout(2500)
    check(p.js("() => window.__phloem.commits.length") == 10 and len(mock.calls) - calls <= 1, "a file replaces a GitHub load in flight; the old session stays quiet")
    p.clean("switch")
    p.close()


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, args=LAUNCH)
        for s in SECTIONS:
            print(f"== {s}", flush=True)
            globals()[f"s_{s}"](b)
        b.close()
    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all qa checks passed")


main()
