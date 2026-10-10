# Ingestion: getting any repository into Phloem

Everything ends as `CommitEvent[]` (oldest first, first-parent; schema in `fixtures/README.md`, validated by `parseCommitEvents`).
Three ways in, from most to least recommended:

| Path | Cost | Fidelity | Limits |
|---|---|---|---|
| **A. Local `git log` file** (upload / drag-drop) | none, offline | exact: every commit, renames, line counts | you need a clone |
| **B. GitHub URL** (`?repo=owner/name` or the form) | 1 API request per commit (or per sample) | exact per commit, or sampled | 60 requests/hour unauthenticated, 5000 with a token |
| **C. CommitEvent JSON** (upload) | none | whatever you built | n/a |

**Recommendation.** Path A is the default answer for anything bigger than a few dozen commits: no rate limit, no token, no network, works
for 100k+ commits (parsed at ~25 MB/s in a worker), private repositories included. Path B is the convenience path for "let me look at this
public repo right now", and it is honest about what it can fetch (see below). If we later want "paste a URL, get the whole history of any
repo" the right investment is a small serverless proxy (section *Alternatives*), not more client-side tricks.

## A. The git log file

```
git log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s' > phloem.log
```

Run it inside a clone (git 2.31+, where `--first-parent` implies diffing merges against their first parent; on older git add `-m`).
Then drop `phloem.log` anywhere on the page or choose it under **Upload a git log instead** on the landing card (the brand button in the viewer reopens the card). The same command is shown there with a copy button.
Windows `cmd.exe` needs double quotes around the format; PowerShell works as written (its `>` writes UTF-16, which the loader detects).

Why `--raw --numstat` and not `--name-status --numstat`: with git 2.43, giving both prints **only** the name-status block (the numstat
lines are silently dropped), so you lose line counts. `--raw` prints the status letters (`A M D R100 old new ...`) *and* combines with `--numstat`.

What the parser (`src/ingest/gitlog.ts`) accepts, per commit, in any mix:

- header `@@<hash>\t<author date>\t<author>\t<email>\t<subject>` (tab separated; the subject may contain tabs), or git's default
  `commit <hash>` / `Author:` / `Date:` / indented message layout;
- raw lines `:100644 100644 abc def M\tpath`, `R100\told\tnew`; plain name-status lines (`M\tpath`, `R087\told\tnew`, `C100...`, `T`);
- numstat lines `12\t3\tpath`, binary `-\t-\tpath`, renames as `old => new` and `dir/{old => new}/f`;
- C-style quoted paths (`"caf\303\251/a b.txt"`, what git prints for non-ASCII unless `core.quotepath=off`), spaces, unicode, `\r\n`;
- merges (empty or first-parent diffs), empty commits, CRLF, a UTF-8 BOM or UTF-16 file.

Without a status source (numstat only) every file is a modify (the tree treats a modify of an unknown path as an add; renames are
recognised from the `=>` spelling). Unrecognised lines are counted and reported ("N lines skipped"), never fatal; a file with no commit
header at all gets an error that quotes the first offending line. JSON input (`[...]` or `{"commits": [...]}`) goes through `parseCommitEvents`.

Memory: a parsed commit costs about 6 KB (measured: 20k commits / 317k file changes = 125 MB), and the history lives on the main thread (labels, scrubber) and in the sim worker, so
practical limits are around 100k commits; one upload stops at 250,000 commits (`MAX_COMMITS` in `filestream.ts`; the status says so) and a single line longer than 1 MiB is skipped, so a hostile or binary file cannot exhaust the tab or make the parser quadratic. Add `-n 20000` or `--since=2.years` to the command for bigger repositories.

Parsing runs in `ingest.worker.ts` (streaming `Blob.stream()`, 256 KB slices, batches of ~1000 commits). The first batch is released after
~60 ms, so playback starts while the rest of a big file is still being read. Measured: 120k commits / 27.5 MB in 1.2 s (Node, vitest).

## B. GitHub, in the browser

`src/ingest/github.ts`, `src/ingest/session.ts`, UI in `src/ui/landing/` and `src/ui/chrome/status.ts` (see `docs/WEB.md`). `api.github.com` sends `Access-Control-Allow-Origin: *`, allows the
`Authorization` header in preflight and exposes `Link` and `X-RateLimit-*` (checked with curl while building this).

### What a history costs (the honest part)

| Request | Count | Notes |
|---|---|---|
| `GET /repos/o/r` | 1 | default branch, `private` flag, validates the repo |
| `GET /repos/o/r/commits?sha=&per_page=100&page=n` | ceil(window / 100) | newest first; carries `parents` and the tree SHA, so the **first-parent chain is built locally** (merge commits and side-branch commits are listed too, which is why up to 4x the pages may be read in merge-heavy repos) |
| `GET /repos/o/r/commits/{sha}` | **1 per commit** | the only place a commit's file list exists; max 300 files per page (up to 3 extra pages are followed) |
| `GET /repos/o/r/git/trees/{sha}?recursive=1` | 1 per sample | whole file tree at one commit (truncated by GitHub at 100k entries) |

So a 300-commit window is about 305 requests: **5 hours of the unauthenticated quota (60/h per IP, shared with anything else on your network
and with other tabs), or 6 % of a token's 5000/h**. There is no bulk endpoint: GraphQL has no per-commit file lists, `compare` aggregates
a range, and the zip/raw hosts do not send CORS headers for other origins (`codeload.github.com` allows only
`render.githubusercontent.com`; `raw.githubusercontent.com` is CORS-open but serves single files, not history).

### How the app copes

- **Window**: the default is **all available** (`max=all`): the whole first-parent history, up to 1,000 commits without a token and 20,000 with one, and within what the hourly quota can pay for (a repository too long for per-commit detail is sampled, see modes below). A smaller window ("most recent N commits") is optional narrowing. Nothing picks 200 or any other number silently. Listing stops as soon as the first-parent chain has N commits.
- **Detail modes** (`mode=auto|commits|snapshots`):
  - *commits*: one request per commit, results delivered **oldest first, contiguous**, so what is on screen is always a valid prefix.
    If the quota cannot cover the window, the newest commits that fit are fetched (and the UI says so) instead of failing.
  - *snapshots*: one request per **sample** (default up to 60, evenly spaced over the window, always including the newest commit). Each sample's file
    tree is diffed against the previous sample (`diffTrees`: adds, modifies by blob SHA, deletes, and a delete + add with the same blob is a rename)
    and shown as one combined commit ("subject (+k earlier commits)"). It covers the *whole* window for ~1/k of the cost, but has no per-commit
    authorship or timing, and line counts are estimated from blob sizes (~40 bytes/line). This is the right tool for a big repository with no token.
  - *auto*: commits if the window fits the remaining quota, else snapshots.
- **Rate-limit detection**: every response updates the quota from `X-RateLimit-Remaining/Reset`. At zero no further request is made until the
  reset; a 403/429 with `Retry-After` (secondary limit) is waited out if short (<= 15 s) and otherwise reported with its time; a 403 with
  `remaining: 0` or "rate limit" in the body is a primary-limit stop. The UI shows requests used, requests left, and the reset clock time.
  "Check my remaining requests" calls `/rate_limit`, which is free.
- **Partial results and resume**: nothing is lost on a limit, a cancel or a network failure. Delivered commits stay visible (and playable); fetched
  but not yet delivered details are kept; **Resume** continues where it stopped. Commit details of **public** repositories are also cached in
  IndexedDB by SHA (they are immutable), so even a reload or a retry after the reset spends no quota on commits already seen. Private
  repositories are never written to the cache. "Clear cached GitHub data" empties it.
- **Cancel** aborts in-flight requests (AbortController) and keeps what was delivered.
- **Errors**: 404 (wrong name, missing branch, or a private repository: the message says to add a token), 401 (bad token), empty repository (409),
  network failure (retried twice with backoff, then reported; Resume available), 403 for other reasons (e.g. org SSO or blocked repo), and
  "not JSON".
- **Token**: optional password field (landing card, or the viewer's "GitHub token" popover; `src/ui/tokenpanel.ts`, `src/web/token.ts`). Kept in memory; "Save on this device" (explicit) stores it in `localStorage`, "Remove saved token" erases it. It is sent only as
  `Authorization: Bearer ...` to `https://api.github.com` (all request URLs are built from a fixed base; the `Link` header is never followed),
  never put in a URL or the query string (`?token=` is deliberately unsupported), never logged, and not part of any error text (tested).
  Fine-grained tokens need *Contents: read* and *Metadata: read*; classic tokens need `repo` only for private repositories.
- URL: `?repo=owner/name` (also `&branch=`, `&max=500` to narrow, `&mode=snapshots`) starts loading immediately (unauthenticated, or with the saved token).

Not covered: commits with more than ~1200 changed files have the rest omitted (noted in the UI); forks/PR refs; GitHub Enterprise hosts.

## Featured repositories (prebuilt)

`stemdeckapp/stemdeck`, `thcp/netbattle` and `Encore-Karaoke-Labs/Encore-Karaoke` (config: `src/web/featured.config.json`, entries `repo`, `name` (display), `branch`, optional `note`, optional `authorMap` to rename an author)
ship as static JSON so they open instantly with no GitHub request. `npm run featured` (`scripts/build-featured.mjs`, pure helpers in `scripts/featured-lib.mjs`):
checks `gh repo view --json visibility` is PUBLIC (a private repo aborts the run), clones it with `--no-checkout` into a fresh temp dir (`PHLOEM_TMP` or the OS temp dir; only `git -C` ever runs on the clone),
runs `scripts/extract-history.mjs` over the whole first-parent history (the extractor and its output are unchanged), blanks every author email, refuses output containing a token-like string, an email or a local path,
and writes `public/featured/<owner>__<repo>.json` (compact CommitEvent[]) plus `index.json` (repo, name, branch, file, commits, distinct files touched, first/last date, head sha, generatedAt, bytes). It prints the author names that become public.
Author colour is keyed on the author name only, so blank emails change nothing visible. `--only owner/name` rebuilds one entry. Sizes are small (about 0.2 MB, 0.06 MB and 0.5 MB raw; 40 KB, 4 KB and 78 KB gzip), so no compact encoding is used.
`.github/workflows/featured.yml` (manual + weekly) runs it and commits `public/featured/` when it changed (config only, never run from here).
The app side is `src/web/featured.ts`: see "Featured repositories" in `docs/WEB.md`.

## Scale (measured)

`npm run scale -- 15000 20000 20000 2` (Node, no GPU; synthetic 20,000 commits / 317k file changes / 15k live files at the end, 44.6 MB of git log) and
`tests/e2e/ingest_scale.py` (the same file uploaded in Chromium). The machine was heavily loaded by other jobs (load average 15 on 10 cores), so absolute times are pessimistic.

| What | Result |
|---|---|
| Parse (Node, streaming, validated) | 20k commits in 2.1-2.6 s (18-23 MB/s); +125 MB heap for the `CommitEvent[]` (6 KB/commit) |
| Parse in the browser (worker) | first commits on screen after 0.26 s; all 20k parsed, appended to the sim worker and the label replica after 4.5 s |
| Main thread while loading | 5 long tasks, max 185 ms, total 0.4 s (mostly the software-GL renderer, not ingestion); JS heap 44 MB |
| `append` | all 19,850 remaining commits in 20 batches: 124 ms total, 22 ms worst batch |
| Sim step | p50 7.5 ms, p99 44 ms (the 482 ms max includes snapshot captures); 20-35 ms/tick near the end (15k files, 123k network nodes). A huge commit is applied in 300-file slices: an 8.8k-file import costs ~50 ms in its first tick instead of 233 ms |
| Auto pacing | 20k commits -> 2 ticks/commit -> 40k ticks (11 minutes at 1x, 1.4 at 8x) instead of 4 hours at 45 |
| Snapshots | 11 MB at 36k nodes, 32 MB at 123k nodes (lean); 12-17 stored under the 320 MB budget; capture 50-300 ms |
| Seek (checkpoints) | after a full play-through: to 95 %: 47 s, 90 %: 86 s, 50 %: 120 s, 10 %: 91 s, to 0: 0.2 s. Without the lean snapshots and the cost-aware thinning (first measurement): 380 s / 280 s / 21 s / 98 s |
| Seek forward into never-simulated territory | the full simulation cost (here 7-11 min); the browser check of a seek to the last commit timed out at 240 s |
| Process memory | rss ~950 MB for the Node run (heap 350 MB + 270 MB of snapshots) |

What this means: a 20k-commit / 15k-file history **loads and starts playing in under a second and plays**, but scrubbing late in it is slow (tens of seconds to minutes, bounded by
the snapshot budget), and the snapshot memory is a real cost (hundreds of MB). For repositories of that size prefer `git log -n 5000` (or `--since`).

## C. Alternatives considered

1. **isomorphic-git in the browser.** It speaks the git smart-HTTP protocol directly. `github.com/o/r.git/info/refs` returns 200 but **without
   CORS headers** (checked), so it needs a CORS proxy. The public proxy (`cors.isomorphic-git.org`) is a third party that sees your traffic
   and any credentials, and is rate-limited; self-hosting one is a backend. On top of that, isomorphic-git (as far as I know) has no partial-clone
   `filter=blob:none`, so a fetch downloads blobs too: far more data than a log needs, and a full pack parse in the browser. Rejected as the primary path.
2. **A tiny optional serverless proxy** (Cloudflare Worker / Deno Deploy): either (a) only adds CORS to the git smart-HTTP endpoints and lets the
   browser do a blobless fetch itself, or (b) runs the equivalent of path A server-side (`git clone --filter=blob:none --bare` +
   `git log --raw --numstat`) and streams the log back, or (c) just proxies `api.github.com` with a server-held token (shared 5000/h quota).
   (b) gives exact full history for any public repo with one request; it is the best future "paste a URL" experience and it is the only option
   here that needs infrastructure (compute time, abuse limits). **Not built**, by instruction; the file format above is exactly what (b) would return,
   so the client needs no change.
3. **User runs the log locally and uploads it** (path A). Zero infrastructure, zero limits, private repos, and the data never leaves the machine.
   Cost: a copy-paste step. **Recommended.**
4. **GitHub GraphQL**: needs a token for everything and exposes no per-commit file names. No gain over REST.

## Worker protocol notes (for contributors)

`worker/protocol.ts`: `load` (with `streaming`), `append`, `finish`, `options` (pacing / ticksPerCommit; rebuilds and returns to the current
commit), `frame`, `play`, `speed`, `seek`, `seekTick`; worker -> main `ready`, `frame`, `info` (checkpoint stats), `error`. See ARCHITECTURE.md for
streaming, checkpoints, pacing and big-commit slicing.
