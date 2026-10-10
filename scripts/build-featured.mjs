#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build the prebuilt histories of the featured repositories (src/web/featured.config.json) into public/featured/.
 *
 *   node scripts/build-featured.mjs [--only owner/name] [--out public/featured]
 *
 * For each repo: `gh repo view` must say PUBLIC (this data ships to a public site); clone it into a NEW EMPTY temp directory
 * (PHLOEM_TMP or the OS temp dir; the clone is untrusted, only `git -C` runs on it, never a script from it); run
 * scripts/extract-history.mjs on the full first-parent history; blank the author emails; write <owner>__<repo>.json (compact) and
 * index.json. Prints the author names that become public. See docs/INGESTION.md.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertClean, assertPublic, authorNames, featuredFileName, indexEntry, scrubCommits, stableEntry, validateConfig } from './featured-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('--only')?.toLowerCase();
const outDir = resolve(opt('--out') ?? join(root, 'public/featured'));
const entries = validateConfig(JSON.parse(readFileSync(join(root, 'src/web/featured.config.json'), 'utf8'))).filter(
  (e) => !only || e.repo.toLowerCase() === only,
);
if (entries.length === 0) {
  console.error('nothing to build');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const run = (cmd, argv, o = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...o });

// index.json keeps entries of repos not rebuilt in this run (--only)
const indexPath = join(outDir, 'index.json');
let previous = [];
try {
  previous = JSON.parse(readFileSync(indexPath, 'utf8')).repos ?? [];
} catch {
  /* first run */
}
const built = new Map(previous.map((p) => [p.repo.toLowerCase(), p]));
const report = [];

for (const e of entries) {
  console.error(`\n== ${e.repo} (${e.branch})`);
  const { visibility } = JSON.parse(run('gh', ['repo', 'view', e.repo, '--json', 'visibility']));
  assertPublic(visibility, e.repo);
  const tmp = mkdtempSync(join(process.env.PHLOEM_TMP ?? tmpdir(), 'featured-'));
  try {
    const clone = join(tmp, 'clone');
    // no token in the URL: public repos clone anonymously; --no-checkout: no file from the repo is ever written, let alone run
    run('git', ['clone', '--quiet', '--no-checkout', '--single-branch', '--branch', e.branch, `https://github.com/${e.repo}.git`, clone], { stdio: ['ignore', 'pipe', 'inherit'] });
    const git = (...a) => run('git', ['-C', clone, ...a]).trim();
    const head = git('rev-parse', 'HEAD');
    const raw = join(tmp, 'raw.json');
    run('node', [join(root, 'scripts/extract-history.mjs'), clone, raw, 'HEAD'], { stdio: ['ignore', 'inherit', 'inherit'] });
    const commits = scrubCommits(JSON.parse(readFileSync(raw, 'utf8')), e.authorMap);
    if (commits.length === 0) throw new Error(`${e.repo}: no commits`);
    const json = JSON.stringify(commits);
    assertClean(json, [tmp, homedir(), root]);
    const file = featuredFileName(e.repo);
    writeFileSync(join(outDir, file), json + '\n');
    const bytes = Buffer.byteLength(json) + 1;
    // an unchanged repository keeps its previous generatedAt, so the weekly workflow commits nothing
    const entry = stableEntry(indexEntry(e, commits, { head, generatedAt: new Date().toISOString(), bytes }), built.get(e.repo.toLowerCase()));
    built.set(e.repo.toLowerCase(), entry);
    report.push({ entry, gzip: gzipSync(json).length, authors: authorNames(commits) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// keep config order
const cfgOrder = validateConfig(JSON.parse(readFileSync(join(root, 'src/web/featured.config.json'), 'utf8'))).map((c) => c.repo.toLowerCase());
const repos = cfgOrder.map((k) => built.get(k)).filter(Boolean);
writeFileSync(indexPath, JSON.stringify({ repos }, null, 2) + '\n');
if (!existsSync(indexPath)) throw new Error('index.json missing');

for (const r of report) {
  const x = r.entry;
  console.error(`\n${x.repo}: ${x.commits} commits, ${x.files} files, ${x.first} .. ${x.last}, ${x.bytes} bytes (${r.gzip} gzip), head ${x.head.slice(0, 10)}`);
  console.error(`  public author names: ${r.authors.map((a) => `${a.name} (${a.commits})`).join(', ')}`);
}
