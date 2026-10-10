# Deploying Phloem on Vercel

Phloem is a static site (`npm run build` writes `dist/`). The primary host is **Vercel**, at **https://phloem.stemdeck.app**, from the public repository
**https://github.com/thcp/phloem**. `vercel.json` already carries everything Vercel needs (build command, output directory, security headers, cache rules);
nothing here has been deployed yet.

## 1. Push the code (once)

From the project folder, after reviewing `git status` (no `screenshots/`, `node_modules/`, `dist/`, `.venv/`, `.claude/` or `scratch/` must be listed; they are in `.gitignore`):

```
git add -A
git status                      # read it once more
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/thcp/phloem.git
git push -u origin main
```

GitHub Actions then runs `.github/workflows/ci.yml` (type-check, tests, build). It does not deploy anything. `featured.yml` is manual-only (its weekly schedule is commented out).

## 2. Import the repository in Vercel

1. vercel.com > **Add New... > Project** > **Import Git Repository** > choose `thcp/phloem` (install/authorize the Vercel GitHub app for that repository if asked).
2. **Framework Preset: Vite.** Root Directory: `./`. The rest comes from `vercel.json`, so you do not need to change it: Install `npm ci`, Build `npm run build`, Output `dist`.
   (Project Settings > General > Node.js Version: 20.x or 22.x.)
3. **Environment Variables** (Settings > Environment Variables; Production and Preview). Both have the right defaults baked in, so this step is only needed to override them:

   | Name | Value | What it does |
   |---|---|---|
   | `SITE_URL` | `https://phloem.stemdeck.app/` | Absolute address for `canonical`, `og:url` and `og:image` (social crawlers need absolute URLs). Default: this value. |
   | `VITE_SOURCE_URL` | `https://github.com/thcp/phloem` | Target of the "Source code (AGPL-3.0)" links (AGPL section 13). Default: this value. |

   Do **not** set `VITE_EXPOSE_TEST_HOOKS`: it would put the `window.__phloem` test hook (which can reach the in-memory GitHub token) into the production page.
   `npm run build` runs `scripts/check-dist.mjs` and fails the deployment if the hook ever ships.
4. **Deploy.** The first build gives you a `*.vercel.app` URL; open it and check the page loads, a Featured card opens instantly and the browser console is clean.

## 3. Add the domain `phloem.stemdeck.app`

1. Project > **Settings > Domains > Add** > `phloem.stemdeck.app`. Choose "Connect to Production". Vercel then shows the DNS record it expects.
2. At the DNS provider that serves **stemdeck.app**, create:

   | Type | Name | Target | TTL |
   |---|---|---|---|
   | `CNAME` | `phloem` | **the exact target Vercel shows** (a project-specific `...vercel-dns-0xx.com` name, or `cname.vercel-dns.com`) | Auto |

   Only the `phloem` subdomain is touched; `stemdeck.app` itself and other records stay as they are.
3. **If the DNS is on Cloudflare:** set the record's proxy status to **DNS only** (grey cloud), at least while Vercel verifies the domain and issues the certificate (Let's Encrypt). Leaving it DNS only is the simplest and supported setup.
   If you really want the orange cloud later, set SSL/TLS to *Full (strict)* first and re-test; the page's CSP, caching and headers are meant to come from Vercel.
   If stemdeck.app has CAA records, they must allow `letsencrypt.org`.
4. Wait until the Domains page shows **Valid Configuration** (usually minutes; DNS can take longer). Check from a terminal:

   ```
   dig +short CNAME phloem.stemdeck.app
   curl -sI https://phloem.stemdeck.app/ | grep -i -E 'content-security-policy|x-content-type|cache-control'
   ```

## 4. After it is live

* `https://phloem.stemdeck.app/` loads, console clean, no CSP messages; Featured cards open instantly (no request to api.github.com in the Network tab).
* The test hook is absent: type `window.__phloem` in the console, it must be `undefined`.
* Share preview: paste the URL into a social/Slack unfurl tester; the image is `/og.png` (1200x630).
* Response headers: `Content-Security-Policy` (same as the `<meta>` tag), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`;
  `/assets/*` is `max-age=31536000, immutable`, `/featured/*` is `max-age=3600`, `index.html` is revalidated on each visit (Vercel default).
* Every push to `main` redeploys production; pull requests and other branches get preview URLs (their canonical/og tags still point at production, which is intended).

## Notes

* **Vercel Hobby is for non-commercial, personal use** (see Vercel's Fair Use / terms). If Phloem becomes part of a commercial product or business, or you want a team, use a paid plan. Hobby also has monthly usage limits; the page itself is small (about 40 KB on the first paint, about 1.5 MB of files in total, source maps excluded), and all GitHub traffic goes straight from the visitor's browser to api.github.com, not through Vercel.
* **AGPL-3.0 section 13:** if you (or anyone) host a *modified* version, the page must offer its users the corresponding source. The footer and viewer link do that via `VITE_SOURCE_URL`; a fork must set it to its own source URL.
* `public/_headers` is for Netlify / Cloudflare Pages; Vercel ignores it and just serves it as a static file (harmless: it contains the same public header values as `vercel.json`).
* No rewrites, `cleanUrls` or `trailingSlash` are configured on purpose: the site is one `index.html` with query parameters.
* Rollback: Vercel > Deployments > pick an earlier deployment > Promote to Production (or Instant Rollback).
* Data saved by the app under its former name (`gitmold`) in a visitor's browser (saved token, saved histories) is moved to the Phloem names once, automatically (`src/web/migrate.ts`). For a new public site there is nothing to migrate; the code can be removed later.
