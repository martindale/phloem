# SPDX-License-Identifier: AGPL-3.0-only
"""Browser check of the one-time migration from the former name ("gitmold") to Phloem (src/web/migrate.ts).

Seeds the OLD localStorage / sessionStorage keys and the OLD IndexedDB databases on the app's origin (through a static page, before the
app has ever run), loads the app, and checks that everything moved to the new names and the old ones are gone. Also checks that a
fresh profile ends up without any old-named database (the probe must not create one) and that the console stays clean.

  npm run build:e2e && npx vite preview --outDir dist-e2e --port 5481 --strictPort &
  LD_LIBRARY_PATH=.venv/syslibs/usr/lib/x86_64-linux-gnu .venv/bin/python tests/e2e/migrate_check.py http://localhost:5481/
"""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5481/"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


SEED = """async () => {
  localStorage.setItem('gitmold.ghtoken.saved', 'github_pat_MIGRATIONTEST');
  sessionStorage.setItem('gitmold.ghtoken', 'old-session');
  const mk = (name, stores, rows) => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { for (const s of stores) r.result.createObjectStore(s); };
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction(stores, 'readwrite');
      for (const [s, k, v] of rows) tx.objectStore(s).put(v, k);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  await mk('gitmold-histories', ['meta', 'data'], [
    ['meta', 'a/b@main', { key: 'a/b@main', repo: 'a/b', branch: 'main', max: 10, mode: 'commits', fetchedAt: 1, count: 1 }],
    ['data', 'a/b@main', [{ sha: 'abc', marker: 'migrated-history' }]],
  ]);
  await mk('gitmold-cache', ['commits'], [['commits', 'sha1', { sha: 'sha1', marker: 'migrated-commit' }]]);
}"""

READ = """async () => {
  const names = (await indexedDB.databases()).map((d) => d.name).sort();
  const dump = (name, store, key) => new Promise((res) => {
    const r = indexedDB.open(name);
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); return res(null); }
      const q = db.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => { db.close(); res(q.result ?? null); };
      q.onerror = () => { db.close(); res(null); };
    };
  });
  return {
    names,
    token: localStorage.getItem('phloem.ghtoken.saved'),
    oldToken: localStorage.getItem('gitmold.ghtoken.saved'),
    oldSession: sessionStorage.getItem('gitmold.ghtoken'),
    history: await dump('phloem-histories', 'data', 'a/b@main'),
    meta: await dump('phloem-histories', 'meta', 'a/b@main'),
    commit: await dump('phloem-cache', 'commits', 'sha1'),
    hookPresent: typeof window.__phloem !== 'undefined',
  };
}"""


def watch(page, logs):
    # Chromium warns about the preloaded font on a RELOAD (it predates the migration and is unrelated to it); ignore only that message
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") and "preloaded using link preload" not in m.text else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)

    # 1. old data present
    ctx = b.new_context(viewport={"width": 1000, "height": 700})
    pg = ctx.new_page()
    logs = []
    watch(pg, logs)
    pg.goto(BASE + "robots.txt")  # same origin, no app code
    pg.evaluate(SEED)
    pre = pg.evaluate("async () => (await indexedDB.databases()).map((d) => d.name).sort()")
    check(pre == ["gitmold-cache", "gitmold-histories"], f"seeded the old databases: {pre}")
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_function(
        "async () => { const n = (await indexedDB.databases()).map((d) => d.name); return n.includes('phloem-histories') && n.includes('phloem-cache') && !n.includes('gitmold-histories') && !n.includes('gitmold-cache'); }",
        timeout=60000,
    )
    r = pg.evaluate(READ)
    print(json.dumps({k: v for k, v in r.items() if k != "token"}))
    check(r["names"] == ["phloem-cache", "phloem-histories"], f"only the new databases remain: {r['names']}")
    check(r["token"] == "github_pat_MIGRATIONTEST", "saved token moved to phloem.ghtoken.saved")
    check(r["oldToken"] is None and r["oldSession"] is None, "old localStorage / sessionStorage keys removed")
    check(r["history"] == [{"sha": "abc", "marker": "migrated-history"}], "history records copied")
    check(r["meta"] and r["meta"]["repo"] == "a/b", "history meta copied")
    check(r["commit"] == {"sha": "sha1", "marker": "migrated-commit"}, "per-commit cache copied")
    check(r["hookPresent"], "e2e build exposes window.__phloem (this script needs the e2e build)")
    # the migrated token is the one the app uses
    used = pg.evaluate("() => window.__phloem && window.__phloem.web ? true : false")
    check(used, "app is up after migration")
    # second load: nothing to do, nothing breaks
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1500)
    r2 = pg.evaluate(READ)
    check(r2["names"] == ["phloem-cache", "phloem-histories"] and r2["token"] == "github_pat_MIGRATIONTEST", "second load is a no-op")
    check(not logs, f"console clean (old data): {logs}")
    ctx.close()

    # 2. fresh profile: the migration must not create the old databases
    ctx = b.new_context(viewport={"width": 1000, "height": 700})
    pg = ctx.new_page()
    logs = []
    watch(pg, logs)
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(3000)
    names = pg.evaluate("async () => (await indexedDB.databases()).map((d) => d.name).sort()")
    check(not any(n.startswith("gitmold") for n in names), f"fresh profile has no old-named database: {names}")
    check(pg.evaluate("() => localStorage.length") == 0, "fresh profile writes nothing to localStorage")
    check(not logs, f"console clean (fresh): {logs}")
    ctx.close()

    # 3. an existing new token wins over an old one
    ctx = b.new_context()
    pg = ctx.new_page()
    pg.goto(BASE + "robots.txt")
    pg.evaluate("() => { localStorage.setItem('gitmold.ghtoken.saved', 'old'); localStorage.setItem('phloem.ghtoken.saved', 'new'); }")
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_timeout(1000)
    check(pg.evaluate("() => [localStorage.getItem('phloem.ghtoken.saved'), localStorage.getItem('gitmold.ghtoken.saved')]") == ["new", None], "an existing new token is kept; the old one is dropped")
    ctx.close()
    b.close()

print("\nFAILED: " + "; ".join(fails) if fails else "\nall migration checks passed")
sys.exit(1 if fails else 0)
