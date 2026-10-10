# SPDX-License-Identifier: AGPL-3.0-only
"""Featured repositories: landing section, and ?repo= loads of the prebuilt histories make ZERO requests to api.github.com.

  npm run build:e2e && npx vite preview --outDir dist-e2e --port 5391 --strictPort &
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python tests/e2e/featured_check.py http://localhost:5391/ screenshots/featured
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5391/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots/featured"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
Path(OUT).mkdir(parents=True, exist_ok=True)
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def session(browser, query, expect=None, shot=None, click=None):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));")
    gh = []
    ctx.on("request", lambda r: gh.append(r.url) if "api.github.com" in r.url else None)
    page = ctx.new_page()
    logs = []
    page.on("pageerror", lambda e: logs.append(str(e)))
    page.goto(BASE + query, wait_until="networkidle")
    page.wait_for_function("() => !!window.__phloem", timeout=90000)
    if click:
        page.wait_for_selector(".gm-landing:not([hidden]) " + click, timeout=30000)
        page.click(click)
    if expect:
        page.wait_for_function("(n) => window.__phloem.web.ctx.commits().length === n && !window.__phloem.loader.active", arg=expect, timeout=120000)
    return ctx, page, gh, logs


with sync_playwright() as pw:
    b = pw.chromium.launch(args=ARGS)

    # landing: Featured section with numbers from index.json
    ctx, page, gh, logs = session(b, "")
    page.wait_for_selector(".gm-feat")
    page.wait_for_function("() => [...document.querySelectorAll('.gm-feat-meta')].every(e => /commits/.test(e.textContent))", timeout=30000)
    txt = page.inner_text(".gm-featured")
    print(txt.replace("\n", " | "))
    check(len(page.query_selector_all(".gm-feat")) == 3, "three featured cards on the landing")
    check("netbattle" in txt and "336 commits" in txt and "instant" in txt, "cards show display name, commit count, instant")
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/landing-featured.png")
    check(not any("api.github.com" in u for u in gh), "landing makes no GitHub request")
    ctx.close()

    for query, n in [("?repo=stemdeckapp/stemdeck&max=all", 336), ("?repo=thcp/netbattle&max=all", 6), ("?repo=Encore-Karaoke-Labs/Encore-Karaoke&max=all", 960), ("?repo=StemDeckApp/StemDeck&max=50&t=10", 50)]:
        ctx, page, gh, logs = session(b, query, expect=n)
        total = page.evaluate("() => window.__phloem.web.ctx.commits().length")
        check(total == n, f"{query}: {total} commits shown")
        check(len(gh) == 0, f"{query}: zero api.github.com requests ({len(gh)})")
        check(page.evaluate("() => window.__csp.length") == 0, f"{query}: no CSP violations")
        check(not logs, f"{query}: no page errors {logs}")
        page.wait_for_timeout(2500)
        pill = page.inner_text(".gm-status") if page.query_selector(".gm-status") else ""
        print("pill:", pill.replace("\n", " | "))
        check("prebuilt" in pill, "status says prebuilt")
        if "Encore" in query:
            page.screenshot(path=f"{OUT}/featured-load-encore.png")
        if "netbattle" in query:
            page.screenshot(path=f"{OUT}/featured-load-netbattle.png")
        if "stemdeckapp/stemdeck&" in query:
            page.screenshot(path=f"{OUT}/featured-load-stemdeck.png")
        ctx.close()

    # landing card click loads instantly too
    ctx, page, gh, logs = session(b, "", expect=6, click=".gm-feat[data-repo='thcp/netbattle']")
    check(len(gh) == 0, "landing featured click: zero GitHub requests")
    check(page.evaluate("() => location.search").startswith("?repo=thcp/netbattle"), "URL written back: " + page.evaluate("() => location.search"))
    ctx.close()

    # fetch failure falls back to GitHub (mocked here as a 500 so nothing real is hit)
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    ctx.route("**/featured/**", lambda r: r.fulfill(status=404, body="no"))
    gh = []
    ctx.route("https://api.github.com/**", lambda r: (gh.append(r.request.url), r.fulfill(status=500, body="{}"))[0])
    page = ctx.new_page()
    page.goto(BASE + "?repo=thcp/netbattle", wait_until="networkidle")
    page.wait_for_timeout(8000)
    check(len(gh) > 0, f"featured fetch failure falls back to GitHub ({len(gh)} requests)")
    ctx.close()
    b.close()

print("FAILED: " + "; ".join(fails) if fails else "all ok")
sys.exit(1 if fails else 0)
