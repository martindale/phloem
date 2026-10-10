// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent, FileChange } from '../model/events';
import { Rng } from '../model/rng';

/**
 * Synthetic repository history for performance testing (not a fixture).
 * Produces a plausible CommitEvent[] with nested folders, hot files, deletes
 * and renames. Deterministic for a given seed.
 */
export interface StressOptions {
  files: number; // approx. live files at the end
  commits: number;
  authors: number;
  seed: number;
}

const WORDS = [
  'core', 'api', 'ui', 'net', 'util', 'model', 'view', 'store', 'io', 'db', 'auth', 'cli',
  'render', 'sim', 'test', 'docs', 'build', 'web', 'lib', 'pkg', 'cmd', 'internal', 'svc', 'proto',
];
const EXT = ['.ts', '.ts', '.ts', '.py', '.go', '.rs', '.md', '.json', '.css', '.c', '.h'];

export function generateStressCommits(opts: Partial<StressOptions> = {}): CommitEvent[] {
  const o: StressOptions = { files: 5000, commits: 120, authors: 7, seed: 7, ...opts };
  const rng = new Rng(o.seed);
  // folder tree: ~1 folder per 14 files, branching outward
  const folders: string[] = [''];
  const nFolders = Math.max(4, Math.round(o.files / 14));
  for (let i = 1; i < nFolders; i++) {
    // prefer shallow parents early, deeper later
    const parent = folders[Math.floor(Math.pow(rng.next(), 0.7) * folders.length)];
    const depth = parent === '' ? 0 : parent.split('/').length;
    if (depth >= 7) {
      i--;
      continue;
    }
    const name = `${WORDS[rng.int(WORDS.length)]}${rng.int(40)}`;
    const path = parent ? `${parent}/${name}` : name;
    if (folders.includes(path)) {
      i--;
      continue;
    }
    folders.push(path);
  }
  const authors = Array.from({ length: o.authors }, (_, i) => `dev${i + 1}`);
  const live: string[] = [];
  const liveSet = new Set<string>();
  let serial = 0;
  const newPath = (): string => {
    const f = folders[Math.floor(Math.pow(rng.next(), 1.3) * folders.length)];
    const name = `f${serial++}${EXT[rng.int(EXT.length)]}`;
    return f ? `${f}/${name}` : name;
  };
  const commits: CommitEvent[] = [];
  const t0 = Date.UTC(2024, 0, 1);
  let remaining = o.files;
  for (let c = 0; c < o.commits; c++) {
    const files: FileChange[] = [];
    const used = new Set<string>();
    const left = o.commits - c;
    let adds = c === 0 ? Math.round(o.files * 0.12) : Math.round((remaining / left) * rng.range(0.2, 1.8));
    adds = Math.min(adds, remaining);
    for (let k = 0; k < adds; k++) {
      const p = newPath();
      files.push({ path: p, status: 'A', added: 5 + rng.int(300), removed: 0 });
      used.add(p);
      live.push(p);
      liveSet.add(p);
    }
    remaining -= adds;
    if (c > 0 && live.length > 0) {
      const mods = 1 + rng.int(25);
      for (let k = 0; k < mods; k++) {
        // hot set: early files are touched more often
        const p = live[Math.floor(Math.pow(rng.next(), 2) * live.length)];
        if (used.has(p)) continue;
        used.add(p);
        files.push({ path: p, status: 'M', added: rng.int(60), removed: rng.int(40) });
      }
      if (rng.next() < 0.3) {
        const n = 1 + rng.int(6);
        for (let k = 0; k < n && live.length > 10; k++) {
          const i = rng.int(live.length);
          const p = live[i];
          if (used.has(p)) continue;
          used.add(p);
          live.splice(i, 1);
          liveSet.delete(p);
          files.push({ path: p, status: 'D', added: 0, removed: 10 + rng.int(100) });
          remaining++;
        }
      }
      if (rng.next() < 0.25) {
        const i = rng.int(live.length);
        const p = live[i];
        if (!used.has(p)) {
          const np = newPath();
          used.add(p);
          used.add(np);
          live[i] = np;
          liveSet.delete(p);
          liveSet.add(np);
          files.push({ path: np, old_path: p, status: 'R', added: rng.int(5), removed: rng.int(5) });
        }
      }
    }
    const author = authors[Math.floor(Math.pow(rng.next(), 1.6) * authors.length)];
    commits.push({
      hash: (0x10000000 + c).toString(16).padStart(40, '0'),
      author,
      email: `${author}@example.invalid`,
      date: new Date(t0 + c * 3600_000 * 7).toISOString(),
      message: `synthetic commit ${c + 1}`,
      files,
    });
  }
  return commits;
}
