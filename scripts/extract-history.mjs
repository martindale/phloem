#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extract first-parent commit events (oldest first) from a git repo into the
 * fixture schema documented in fixtures/README.md.
 *
 *   node scripts/extract-history.mjs <repo-path> <out.json> [ref=HEAD] [max-commits]
 *
 * Only runs `git -C <repo>`; nothing from the repo is executed.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [repo, out, ref = 'HEAD', max] = process.argv.slice(2);
if (!repo || !out) {
  console.error('usage: extract-history.mjs <repo-path> <out.json> [ref] [max-commits]');
  process.exit(2);
}
const git = (...args) =>
  execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });

let hashes = git('rev-list', '--first-parent', '--reverse', ref).split('\n').filter(Boolean);
if (max) hashes = hashes.slice(0, Number(max));

const commits = hashes.map((hash) => {
  const meta = git('show', '-s', '--format=%an%x00%ae%x00%aI%x00%s', hash).replace(/\n$/, '').split('\0');
  const [author, email, date, message] = meta;
  const common = ['show', '--first-parent', '-M', '-z', '--format=', hash];
  const ns = git(...common, '--name-status').split('\0').filter((s) => s !== '');
  const nu = git(...common, '--numstat').split('\0').filter((s) => s !== '');
  // numstat -z: "a\tr\tpath" or, for renames, "a\tr\t" followed by old, new tokens.
  const counts = new Map();
  for (let i = 0; i < nu.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nu[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') { i += 2; path = nu[i]; }
    counts.set(path, { added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2] });
  }
  const files = [];
  for (let i = 0; i < ns.length; i++) {
    const st = ns[i][0];
    if (st === 'R' || st === 'C') {
      const old_path = ns[++i];
      const path = ns[++i];
      files.push({ path, status: st, ...(counts.get(path) ?? { added: 0, removed: 0 }), old_path });
    } else {
      const path = ns[++i];
      const status = st === 'T' ? 'M' : st;
      files.push({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
    }
  }
  return { hash, author, email, date, message, files };
});

writeFileSync(out, JSON.stringify(commits, null, 2) + '\n');
console.error(`${commits.length} commits -> ${out}`);
