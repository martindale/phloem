// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { IngestError, ingestStream, textStream } from '../src/ingest/filestream';
import { GitLogParser, parseGitLog, splitRename, unquote } from '../src/ingest/gitlog';
import { parseCommitEvents } from '../src/model/parse';
import type { CommitEvent } from '../src/model/events';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const hdr = (h: string, date: string, name: string, email: string, subj: string) => `@@${h}\t${date}\t${name}\t${email}\t${subj}`;

describe('git log parser: --raw --numstat (recommended)', () => {
  const log = [
    hdr(H1, '2024-01-01T10:00:00+01:00', 'Ada Lovelace', 'ada@example.org', 'Initial commit'),
    '',
    ':000000 100644 0000000 abc1234 A\tREADME.md',
    ':000000 100644 0000000 abc1235 A\tsrc/main.ts',
    ':000000 100644 0000000 abc1236 A\tlogo.png',
    '10\t0\tREADME.md',
    '42\t0\tsrc/main.ts',
    '-\t-\tlogo.png',
    hdr(H2, '2024-01-02T10:00:00+01:00', 'Bob', 'bob@example.org', 'Rename, modify & delete'),
    '',
    ':100644 100644 abc1234 abc1237 M\tREADME.md',
    ':100644 100644 abc1235 abc1235 R100\tsrc/main.ts\tsrc/app/main.ts',
    ':100644 000000 abc1236 0000000 D\tlogo.png',
    '3\t1\tREADME.md',
    '0\t0\tsrc/{main.ts => app/main.ts}',
    '-\t-\tlogo.png',
    hdr(H3, '2024-01-03T10:00:00+01:00', 'Ada Lovelace', 'ada@example.org', 'Merge pull request #1 from x/y'),
    '',
    '',
  ].join('\n');

  it('reads statuses, counts, renames, binaries and empty (merge) commits', () => {
    const { commits, skipped } = parseGitLog(log);
    expect(skipped).toBe(0);
    expect(commits.map((c) => c.hash)).toEqual([H1, H2, H3]);
    expect(commits[0]).toMatchObject({ author: 'Ada Lovelace', email: 'ada@example.org', date: '2024-01-01T10:00:00+01:00', message: 'Initial commit' });
    expect(commits[0].files).toEqual([
      { path: 'README.md', status: 'A', added: 10, removed: 0 },
      { path: 'src/main.ts', status: 'A', added: 42, removed: 0 },
      { path: 'logo.png', status: 'A', added: 0, removed: 0 },
    ]);
    expect(commits[1].files).toEqual([
      { path: 'README.md', status: 'M', added: 3, removed: 1 },
      { path: 'src/app/main.ts', status: 'R', added: 0, removed: 0, old_path: 'src/main.ts' },
      { path: 'logo.png', status: 'D', added: 0, removed: 0 },
    ]);
    expect(commits[2].files).toEqual([]);
  });

  it('output validates with parseCommitEvents unchanged', () => {
    const { commits } = parseGitLog(log);
    expect(parseCommitEvents(JSON.parse(JSON.stringify(commits)))).toEqual(commits);
  });

  it('is independent of how the text is chunked (including CRLF and splits inside tabs)', () => {
    const whole = parseGitLog(log).commits;
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const p = new GitLogParser();
      const crlf = log.replace(/\n/g, '\r\n');
      for (let i = 0; i < crlf.length; i += size) p.push(crlf.slice(i, i + size));
      p.end();
      expect(p.take()).toEqual(whole);
    }
  });
});

describe('git log parser: tolerance', () => {
  it('accepts plain --name-status without numstat', () => {
    const log = `${hdr(H1, '2024-01-01T00:00:00Z', 'A', 'a@x', 'one')}\n\nA\tfoo/bar.txt\nM\tbaz.txt\nR087\told.txt\tnew dir/new.txt\nD\tgone.txt\nT\tmode.sh\nC100\tsrc.c\tcopy.c\n`;
    const [c] = parseGitLog(log).commits;
    expect(c.files).toEqual([
      { path: 'foo/bar.txt', status: 'A', added: 0, removed: 0 },
      { path: 'baz.txt', status: 'M', added: 0, removed: 0 },
      { path: 'new dir/new.txt', status: 'R', added: 0, removed: 0, old_path: 'old.txt' },
      { path: 'gone.txt', status: 'D', added: 0, removed: 0 },
      { path: 'mode.sh', status: 'M', added: 0, removed: 0 },
      { path: 'copy.c', status: 'A', added: 0, removed: 0 },
    ]);
  });

  it('accepts numstat only: modifies, with renames spelled out', () => {
    const log = `${hdr(H1, '2024-01-01T00:00:00Z', 'A', 'a@x', 'one')}\n\n5\t2\ta.txt\n0\t0\tdir/{old => new}/f.txt\n1\t1\t{ => sub}/g.txt\n-\t-\timg.bin\n`;
    const [c] = parseGitLog(log).commits;
    expect(c.files).toEqual([
      { path: 'a.txt', status: 'M', added: 5, removed: 2 },
      { path: 'dir/new/f.txt', status: 'R', added: 0, removed: 0, old_path: 'dir/old/f.txt' },
      { path: 'sub/g.txt', status: 'R', added: 1, removed: 1, old_path: 'g.txt' },
      { path: 'img.bin', status: 'M', added: 0, removed: 0 },
    ]);
  });

  it('keeps subjects containing tabs, and tolerates missing fields', () => {
    const [a] = parseGitLog(`${hdr(H1, '2024-01-01T00:00:00Z', 'A', 'a@x', 'tab\there\tand more')}\n\nM\tf\n`).commits;
    expect(a.message).toBe('tab\there\tand more');
    const [b] = parseGitLog(`@@${H1}\t2024-01-01T00:00:00Z\nM\tf\n`).commits;
    expect(b).toMatchObject({ author: 'unknown', email: '', message: '' });
  });

  it('reads git default layout (commit/Author/Date/indented message)', () => {
    const log = [
      `commit ${H1}`,
      'Author: Grace Hopper <grace@navy.mil>',
      'Date:   Mon Oct 5 10:05:33 2026 +0100',
      '',
      '    First subject',
      '    ',
      '    body line',
      '',
      'A\tx.txt',
      'M\ty.txt',
      '',
      `commit ${H2} (from ${H1})`,
      'Merge: aaaaaaa bbbbbbb',
      'Author: Grace <g@x>',
      'Date:   Tue Oct 6 10:05:33 2026 +0100',
      '',
      '    Merge branch',
      '',
    ].join('\n');
    const { commits } = parseGitLog(log);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ author: 'Grace Hopper', email: 'grace@navy.mil', message: 'First subject', date: '2026-10-05T09:05:33.000Z' });
    expect(commits[0].files.map((f) => f.path)).toEqual(['x.txt', 'y.txt']);
    expect(commits[1].files).toEqual([]);
  });

  it('counts garbage lines and ignores combined-diff and unmerged entries', () => {
    const log = `junk before\n${hdr(H1, '2024-01-01T00:00:00Z', 'A', 'a@x', 's')}\n\n::100644 100644 100644 a b c MM\tboth.txt\nU\tconflict.txt\nweird line\nM\tok.txt\n`;
    const p = new GitLogParser();
    p.push(log);
    p.end();
    const [c] = p.take();
    expect(c.files.map((f) => f.path)).toEqual(['ok.txt']);
    expect(p.skipped).toBe(2); // 'junk before' and 'weird line'
  });
});

describe('paths: quoting, spaces, unicode', () => {
  it('unquotes C-style escapes into UTF-8', () => {
    expect(unquote('"caf\\303\\251.txt"')).toBe('café.txt');
    expect(unquote('"tab\\there"')).toBe('tab\there');
    expect(unquote('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(unquote('"\\346\\227\\245\\346\\234\\254/\\343\\201\\202.md"')).toBe('日本/あ.md');
    expect(unquote('plain')).toBe('plain');
    expect(unquote('"already unicode é"')).toBe('already unicode é');
  });

  it('handles spaces, unicode and quoted paths in file lines', () => {
    const log = [
      hdr(H1, '2024-01-01T00:00:00Z', 'Zoë', 'z@x', 'Ünïcode'),
      '',
      ':000000 100644 0000000 abc A\t"caf\\303\\251/my file.txt"',
      ':000000 100644 0000000 abc A\tdocs/日本語.md',
      ':000000 100644 0000000 abc A\tspace dir/a b.txt',
      '1\t0\t"caf\\303\\251/my file.txt"',
      '2\t0\tdocs/日本語.md',
      '3\t0\tspace dir/a b.txt',
    ].join('\n');
    const [c] = parseGitLog(log).commits;
    expect(c.author).toBe('Zoë');
    expect(c.files).toEqual([
      { path: 'café/my file.txt', status: 'A', added: 1, removed: 0 },
      { path: 'docs/日本語.md', status: 'A', added: 2, removed: 0 },
      { path: 'space dir/a b.txt', status: 'A', added: 3, removed: 0 },
    ]);
  });

  it('splits rename spellings', () => {
    expect(splitRename('a/{b => c}/d')).toEqual({ path: 'a/c/d', old: 'a/b/d' });
    expect(splitRename('a/{b => }/d')).toEqual({ path: 'a/d', old: 'a/b/d' });
    expect(splitRename('a/{ => c}/d')).toEqual({ path: 'a/c/d', old: 'a/d' });
    expect(splitRename('old.txt => new.txt')).toEqual({ path: 'new.txt', old: 'old.txt' });
    expect(splitRename('plain.txt')).toEqual({ path: 'plain.txt' });
  });

  it('normalizes ./ and leading slashes through the shared normalizer, and drops empty paths', () => {
    const log = `${hdr(H1, '2024-01-01T00:00:00Z', 'A', 'a@x', 's')}\n\nA\t./x/y.txt\nA\t/z.txt\nA\t/\n`;
    const [c] = parseGitLog(log).commits;
    expect(c.files.map((f) => f.path)).toEqual(['x/y.txt', 'z.txt']);
  });
});

describe('stream ingestion', () => {
  const sample = (n: number): string => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(hdr(i.toString(16).padStart(40, '0'), new Date(Date.UTC(2020, 0, 1) + i * 3600_000).toISOString(), `dev${i % 7}`, `d${i % 7}@x`, `commit ${i}`));
      out.push('');
      out.push(`:000000 100644 0000000 abc A\tdir${i % 50}/file${i}.ts`);
      out.push(`:100644 100644 abc abd M\tdir${i % 50}/file${Math.max(0, i - 1)}.ts`);
      out.push(`5\t0\tdir${i % 50}/file${i}.ts`);
      out.push(`1\t2\tdir${i % 50}/file${Math.max(0, i - 1)}.ts`);
    }
    return out.join('\n') + '\n';
  };

  it('parses a huge log in batches, in order, quickly', async () => {
    const n = 120_000;
    const text = sample(n);
    expect(text.length).toBeGreaterThan(15_000_000);
    const batches: number[] = [];
    let total = 0;
    let first = '';
    let last = '';
    const t0 = performance.now();
    const res = await ingestStream(textStream(text), text.length, {
      onBatch: (b) => {
        batches.push(b.length);
        total += b.length;
        if (!first) first = b[0].hash;
        last = b[b.length - 1].hash;
      },
    });
    const ms = performance.now() - t0;
    expect(res).toMatchObject({ format: 'gitlog', commits: n, skippedLines: 0 });
    expect(total).toBe(n);
    expect(first).toBe((0).toString(16).padStart(40, '0'));
    expect(last).toBe((n - 1).toString(16).padStart(40, '0'));
    expect(batches.length).toBeGreaterThan(5);
    console.log(`parsed ${n} commits / ${(text.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms in ${batches.length} batches`);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it('does not choke on a file with no line breaks (bounded line buffer, linear time)', async () => {
    const p = new GitLogParser();
    const chunk = 'x'.repeat(256 * 1024);
    const t0 = performance.now();
    for (let i = 0; i < 160; i++) p.push(chunk); // 40 MB, one line
    p.push('\n@@' + 'a'.repeat(40) + '\t2024-01-01T00:00:00Z\tA\ta@b\tsubject\n');
    p.end();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(p.skipped).toBe(1);
    expect(p.count).toBe(1); // parsing resumes at the next line
  });

  it('stops at the commit limit and says so', async () => {
    const log = Array.from({ length: 8000 }, (_, i) => `@@${String(i).padStart(40, 'a')}\t2024-01-01T00:00:00Z\tA\ta@b\tc${i}\n:000000 100644 0000000 1111111 A\tf${i}.ts\n`).join('');
    const seen: number[] = [];
    const r = await ingestStream(textStream(log), log.length, { maxCommits: 1000, batchSize: 500, firstBatchMs: 0, onBatch: (c) => seen.push(c.length) });
    expect(r.truncated).toBe(1000);
    expect(r.commits).toBeGreaterThanOrEqual(1000); // checked per 256 KB slice, so it can overshoot a little
    expect(r.commits).toBeLessThan(8000);
    const full = await ingestStream(textStream(log), log.length, { onBatch: () => undefined });
    expect(full.truncated).toBeUndefined();
    expect(full.commits).toBe(8000);
  });

  it('accepts CommitEvent JSON (array and {commits}) and validates it', async () => {
    const commits: CommitEvent[] = parseGitLog(sample(30)).commits;
    for (const payload of [JSON.stringify(commits), JSON.stringify({ commits })]) {
      const got: CommitEvent[] = [];
      const r = await ingestStream(textStream(payload), payload.length, { onBatch: (b) => got.push(...b) });
      expect(r.format).toBe('json');
      expect(got).toEqual(commits);
    }
    const bad = JSON.stringify([{ hash: 'x', files: [{ path: 'a', status: 'Q' }] }]);
    await expect(ingestStream(textStream(bad), bad.length, { onBatch: () => {} })).rejects.toThrow(/status/);
  });

  it('decodes UTF-16 files (PowerShell redirects) and strips a UTF-8 BOM', async () => {
    const text = sample(5);
    const u16 = new Uint8Array(2 + text.length * 2);
    u16[0] = 0xff;
    u16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      u16[2 + i * 2] = text.charCodeAt(i) & 255;
      u16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    const got: CommitEvent[] = [];
    await ingestStream(new Blob([u16]).stream() as ReadableStream<Uint8Array>, u16.length, { onBatch: (b) => got.push(...b) });
    expect(got).toHaveLength(5);
    const withBom = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), text]);
    const got2: CommitEvent[] = [];
    await ingestStream(withBom.stream() as ReadableStream<Uint8Array>, withBom.size, { onBatch: (b) => got2.push(...b) });
    expect(got2).toHaveLength(5);
  });

  it('gives helpful errors for empty and unrecognised input, and honours cancel', async () => {
    await expect(ingestStream(textStream(''), 0, { onBatch: () => {} })).rejects.toBeInstanceOf(IngestError);
    await expect(ingestStream(textStream('hello\nworld\n'), 12, { onBatch: () => {} })).rejects.toThrow(/No commits found.*hello/);
    const ac = new AbortController();
    ac.abort();
    await expect(ingestStream(textStream(sample(10)), 100, { onBatch: () => {}, signal: ac.signal })).rejects.toThrow(/cancelled/);
  });
});

describe('round trip', () => {
  it('git log text produced from a synthetic history (adds, mods, deletes, renames) parses back to the same events', async () => {
    const { generateStressCommits } = await import('../src/ingest/stress');
    const { toGitLog } = await import('../scripts/synthetic-log');
    const original = generateStressCommits({ files: 800, commits: 150, seed: 5 });
    expect(original.some((c) => c.files.some((f) => f.status === 'R'))).toBe(true);
    expect(original.some((c) => c.files.some((f) => f.status === 'D'))).toBe(true);
    const { commits, skipped } = parseGitLog(toGitLog(original));
    expect(skipped).toBe(0);
    expect(commits).toEqual(original.map((c) => ({ ...c, files: c.files.map((f) => ({ ...f })) })));
  });
});
