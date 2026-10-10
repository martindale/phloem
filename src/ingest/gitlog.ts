// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent, FileChange, FileStatus } from '../model/events';
import { normalizePath } from '../model/parse';

/**
 * Incremental parser for `git log` text output -> CommitEvent[] (oldest first when the log was produced with --reverse).
 *
 * Recommended command (see docs/INGESTION.md and the load panel):
 *
 *   git log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s' > phloem.log
 *
 * Why `--raw` and not `--name-status`: git prints only one of `--name-status` / `--numstat` when both are given
 * (verified with git 2.43: the numstat block is silently dropped), but `--raw --numstat` prints both.
 *
 * The parser is deliberately tolerant. Per commit it understands any mix of:
 *   - a header line `@@<hash>\t<author date>\t<author>\t<email>\t<subject>` (tab separated; the subject may contain tabs),
 *     or git's default `commit <hash>` / `Author:` / `Date:` / indented message layout;
 *   - raw lines  `:100644 100644 abc def M\tpath` and `:... R100\told\tnew`;
 *   - name-status lines `M\tpath`, `R087\told\tnew`, `C100\told\tnew`, `D\tpath`;
 *   - numstat lines `12\t3\tpath`, binary `-\t-\tpath`, renames `old => new` and `dir/{old => new}/file`;
 *   - C-style quoted paths (`"caf\303\251.txt"`, as git prints them when core.quotepath is on).
 * Without a status source (numstat only) every file is a modify, except renames. Merges are diffed against their first
 * parent when git is asked for first-parent history (`--first-parent` implies that since git 2.31; older gits need `-m`).
 *
 * It is a push parser: feed text chunks with `push` (chunks may split lines anywhere), `end()` at EOF, and `take()` the
 * commits completed so far. The commit still being read is only released once its successor (or `end()`) arrives.
 */
export class GitLogParser {
  private rest = '';
  private discarding = false;
  private cur: Partial<CommitEvent> | null = null;
  private status: StatusEntry[] = [];
  private nums: NumEntry[] = [];
  private mediumHeader = false;
  private mediumMsg = false;
  private done: CommitEvent[] = [];
  /** Total commits completed. */
  count = 0;
  /** Non-empty lines that were not understood (before the first header, or unknown shapes). */
  skipped = 0;
  /** Lines seen. */
  lines = 0;
  /** First few unrecognised lines, for error messages. */
  samples: string[] = [];

  push(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.discarding) {
      // inside an over-long line: drop text up to its end
      const nl = chunk.indexOf('\n');
      if (nl < 0) return;
      this.discarding = false;
      chunk = chunk.slice(nl + 1);
      if (chunk.length === 0) return;
    }
    const text = this.rest.length > 0 ? this.rest + chunk : chunk;
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      let end = nl;
      if (end > start && text.charCodeAt(end - 1) === 13) end--;
      this.line(text.slice(start, end));
      start = nl + 1;
    }
    this.rest = start === 0 ? text : text.slice(start);
    if (this.rest.length > MAX_LINE) {
      // No real git line is this long (paths stop at 4 KiB). A file with no line breaks (or a binary blob) would otherwise be
      // re-scanned on every push, which is quadratic; count it as one unrecognised line and skip to the next newline.
      this.unknown(this.rest);
      this.rest = '';
      this.discarding = true;
    }
  }

  end(): void {
    if (this.rest.length > 0) {
      let r = this.rest;
      if (r.endsWith('\r')) r = r.slice(0, -1);
      this.rest = '';
      this.line(r);
    }
    this.finish();
  }

  /** Commits completed since the last call. */
  take(): CommitEvent[] {
    const out = this.done;
    this.done = [];
    return out;
  }

  /** Number of completed commits waiting for `take()`. */
  get pending(): number {
    return this.done.length;
  }

  private line(l: string): void {
    this.lines++;
    if (l.length === 0) {
      if (this.mediumHeader) {
        this.mediumHeader = false;
        this.mediumMsg = true;
      }
      return;
    }
    const c0 = l.charCodeAt(0);
    // ---- commit headers
    if (c0 === 64 /* @ */ && l.charCodeAt(1) === 64) {
      const m = HEADER.exec(l);
      if (m) {
        this.startCommit(m[1], l.slice(m[0].length));
        return;
      }
    }
    if (c0 === 99 /* c */ && l.startsWith('commit ')) {
      const m = MEDIUM.exec(l);
      if (m) {
        this.startMedium(m[1]);
        return;
      }
    }
    if (!this.cur) {
      this.unknown(l);
      return;
    }
    if (this.mediumHeader) {
      if (l.startsWith('Author:')) {
        const a = l.slice(7).trim();
        const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(a);
        this.cur.author = m ? m[1] : a;
        this.cur.email = m ? m[2] : '';
      } else if (l.startsWith('Date:')) {
        this.cur.date = legacyDate(l.slice(5).trim());
      }
      return; // Merge:, AuthorDate:, Commit: ... lines
    }
    if (this.mediumMsg) {
      if (l.startsWith('    ')) {
        if (this.cur.message === '' || this.cur.message === undefined) this.cur.message = l.slice(4);
        return;
      }
      // first non-indented line after the message: file lines
      this.mediumMsg = false;
    }
    // ---- file lines
    if (c0 === 58 /* : */) {
      if (l.charCodeAt(1) === 58) return; // combined-diff raw line (-c / --cc); not meaningful for first-parent history
      const m = RAW.exec(l);
      if (m) {
        this.addStatus(m[1], m[2], m[3]);
        return;
      }
    } else if ((c0 >= 48 && c0 <= 57) || c0 === 45) {
      const m = NUMSTAT.exec(l);
      if (m) {
        const added = m[1] === '-' ? 0 : Number(m[1]);
        const removed = m[2] === '-' ? 0 : Number(m[2]);
        this.nums.push({ added, removed, spec: m[3] });
        return;
      }
    } else if (c0 >= 65 && c0 <= 90) {
      const m = NAME_STATUS.exec(l);
      if (m) {
        this.addStatus(m[1], m[2], m[3]);
        return;
      }
    }
    this.unknown(l);
  }

  private unknown(l: string): void {
    this.skipped++;
    if (this.samples.length < 3) this.samples.push(l.length > 100 ? `${l.slice(0, 100)}…` : l);
  }

  private addStatus(letter: string, _score: string, paths: string): void {
    // letter: A M D T R C U X B; paths: "p" or "old\tnew"
    let status: FileStatus;
    switch (letter) {
      case 'A':
      case 'C':
        status = 'A';
        break;
      case 'M':
      case 'T':
        status = 'M';
        break;
      case 'D':
        status = 'D';
        break;
      case 'R':
        status = 'R';
        break;
      default:
        return; // U (unmerged), X, B: not part of a history we can draw
    }
    const tab = paths.indexOf('\t');
    if (letter === 'R' || letter === 'C') {
      if (tab < 0) {
        this.status.push({ status: letter === 'R' ? 'A' : status, path: unquote(paths) });
      } else if (letter === 'R') {
        this.status.push({ status: 'R', path: unquote(paths.slice(tab + 1)), old: unquote(paths.slice(0, tab)) });
      } else {
        this.status.push({ status: 'A', path: unquote(paths.slice(tab + 1)) });
      }
      return;
    }
    this.status.push({ status, path: unquote(tab < 0 ? paths : paths.slice(0, tab)) });
  }

  private startCommit(hash: string, fields: string): void {
    this.finish();
    const f = fields.split('\t');
    // hash already consumed; fields = date, author, email, subject (subject may contain tabs)
    this.cur = {
      hash,
      date: f[0] ?? '',
      author: f[1] ?? '',
      email: f[2] ?? '',
      message: f.length > 4 ? f.slice(3).join('\t') : (f[3] ?? ''),
    };
    this.mediumHeader = false;
    this.mediumMsg = false;
  }

  private startMedium(hash: string): void {
    this.finish();
    this.cur = { hash, date: '', author: '', email: '', message: '' };
    this.mediumHeader = true;
    this.mediumMsg = false;
  }

  private finish(): void {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    this.mediumHeader = false;
    this.mediumMsg = false;
    const files = mergeFiles(this.status, this.nums);
    this.status = [];
    this.nums = [];
    this.done.push({
      hash: c.hash!,
      author: c.author || 'unknown',
      email: c.email ?? '',
      date: c.date || '1970-01-01T00:00:00Z',
      message: c.message ?? '',
      files,
    });
    this.count++;
  }
}

/** Longest line the parser will buffer (characters). */
const MAX_LINE = 1 << 20;

const HEADER = /^@@([0-9a-fA-F]{7,64})\t/;
const MEDIUM = /^commit ([0-9a-fA-F]{7,64})(?:\s|$)/;
const RAW = /^:\d+ \d+ [0-9a-fA-F.]+ [0-9a-fA-F.]+ ([A-Z])(\d*)\t(.+)$/;
const NAME_STATUS = /^([A-Z])(\d{0,3})\t(.+)$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;

interface StatusEntry {
  status: FileStatus;
  path: string;
  old?: string;
}
interface NumEntry {
  added: number;
  removed: number;
  spec: string;
}

function mergeFiles(status: StatusEntry[], nums: NumEntry[]): FileChange[] {
  const out: FileChange[] = [];
  if (status.length === 0) {
    // numstat only: statuses are unknown. Everything is a modify (the tree treats M on an unknown path as an add),
    // except renames, which numstat spells out.
    for (const n of nums) {
      const r = splitRename(n.spec);
      const path = normalizePath(r.path);
      if (!path) continue;
      const fc: FileChange = { path, status: 'M', added: n.added, removed: n.removed };
      if (r.old !== undefined) {
        const old = normalizePath(r.old);
        if (old && old !== path) {
          fc.status = 'R';
          fc.old_path = old;
        }
      }
      out.push(fc);
    }
    return out;
  }
  // counts by (new) path; both lists are in the same order, but matching by path is robust to either missing
  let byPath: Map<string, NumEntry> | null = null;
  if (nums.length > 0) {
    byPath = new Map();
    for (const n of nums) byPath.set(normalizePath(splitRename(n.spec).path), n);
  }
  for (const s of status) {
    const path = normalizePath(s.path);
    if (!path) continue;
    const n = byPath?.get(path);
    const fc: FileChange = { path, status: s.status, added: n?.added ?? 0, removed: n?.removed ?? 0 };
    if (s.status === 'R') {
      const old = s.old !== undefined ? normalizePath(s.old) : '';
      if (old && old !== path) fc.old_path = old;
      else fc.status = 'A';
    }
    out.push(fc);
  }
  return out;
}

/** Resolve numstat's `old => new` / `dir/{old => new}/file` spelling. `old` is undefined when it is not a rename. */
export function splitRename(spec: string): { path: string; old?: string } {
  let s = spec;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = unquote(s);
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (brace) {
    const join = (mid: string) => (brace[1] + mid + brace[4]).replace(/\/{2,}/g, '/');
    return { path: join(brace[3]), old: join(brace[2]) };
  }
  const i = s.indexOf(' => ');
  if (i > 0) return { path: s.slice(i + 4), old: s.slice(0, i) };
  return { path: s };
}

const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
const utf8 = new TextDecoder('utf-8');
const utf8enc = new TextEncoder();

/** Undo git's C-style path quoting (`"a\303\251\t"`); unquoted input is returned as is. */
export function unquote(p: string): string {
  if (p.length < 2 || p.charCodeAt(0) !== 34 || p.charCodeAt(p.length - 1) !== 34) return p;
  const inner = p.slice(1, -1);
  if (inner.indexOf('\\') < 0) return inner;
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      const cp = inner.codePointAt(i)!;
      if (cp < 0x80) bytes.push(cp);
      else {
        for (const b of utf8enc.encode(String.fromCodePoint(cp))) bytes.push(b);
        if (cp > 0xffff) i++;
      }
      continue;
    }
    const n = inner[i + 1];
    if (n >= '0' && n <= '7') {
      let v = 0;
      let k = 0;
      while (k < 3 && inner[i + 1 + k] >= '0' && inner[i + 1 + k] <= '7') v = v * 8 + (inner.charCodeAt(i + 1 + k++) - 48);
      bytes.push(v & 255);
      i += k;
    } else if (n in ESC) {
      bytes.push(ESC[n]);
      i++;
    } else bytes.push(92);
  }
  return utf8.decode(Uint8Array.from(bytes));
}

/** `Mon Oct 5 10:05:33 2026 +0100` (git's default date) -> ISO UTC. Unparseable input is returned unchanged. */
function legacyDate(s: string): string {
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

/** Parse a whole log string (tests, small inputs). */
export function parseGitLog(text: string): { commits: CommitEvent[]; skipped: number } {
  const p = new GitLogParser();
  p.push(text);
  p.end();
  return { commits: p.take(), skipped: p.skipped };
}

/** The recommended command, shown in the UI and docs. */
export const GIT_LOG_COMMAND =
  "git log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s' > phloem.log";
