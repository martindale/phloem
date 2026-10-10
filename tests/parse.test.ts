// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommitParseError, normalizePath, parseCommitEvents } from '../src/model/parse';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8'));

describe('parseCommitEvents', () => {
  it('parses the canonical fixture', () => {
    const commits = parseCommitEvents(fixture);
    expect(commits).toHaveLength(10);
    expect(commits[0].files[0]).toEqual({ path: 'LICENSE', status: 'A', added: 201, removed: 0 });
    const authors = new Set(commits.map((c) => c.author));
    expect(authors.size).toBe(2);
    const renames = commits.flatMap((c) => c.files.filter((f) => f.status === 'R'));
    expect(renames.length).toBeGreaterThan(0);
    for (const r of renames) expect(typeof r.old_path).toBe('string');
  });

  it('normalizes paths and lenient statuses', () => {
    const [c] = parseCommitEvents([
      {
        hash: 'h',
        author: 'a',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: './src//a.ts', status: 'C', added: 1, removed: 0 },
          { path: '/b.ts', status: 'T' },
          { path: 'c.ts', status: 'R' }, // rename without old_path -> add
        ],
      },
    ]);
    expect(c.files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'A'],
      ['b.ts', 'M'],
      ['c.ts', 'A'],
    ]);
    expect(c.email).toBe('');
    expect(c.message).toBe('');
    expect(normalizePath('a\\b\\c/')).toBe('a/b/c');
  });

  it('reports where structural errors are', () => {
    expect(() => parseCommitEvents({})).toThrow(CommitParseError);
    expect(() => parseCommitEvents([{ hash: 'h', author: 'a', date: 'd', files: [{ path: 'x', status: 'Z' }] }])).toThrow(
      /\$\[0\]\.files\[0\]\.status/,
    );
    expect(() => parseCommitEvents([{ hash: 'h', author: 'a', date: 'd', files: [{ path: 'x', status: 'A', added: -1 }] }])).toThrow(
      /added/,
    );
  });
});
