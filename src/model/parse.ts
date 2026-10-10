// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent, FileChange, FileStatus } from './events';

export class CommitParseError extends Error {
  constructor(public readonly where: string, detail: string) {
    super(`${where}: ${detail}`);
    this.name = 'CommitParseError';
  }
}

/** Strip "./" and leading "/", collapse duplicate slashes, drop trailing "/". */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  return s;
}

const STATUS_MAP: Record<string, FileStatus> = {
  A: 'A',
  M: 'M',
  D: 'D',
  R: 'R',
  // Lenient extras some git front-ends emit: copy behaves like an add,
  // type-change like a modify.
  C: 'A',
  T: 'M',
};

function str(v: unknown, where: string, allowEmpty = true): string {
  if (typeof v !== 'string') throw new CommitParseError(where, `expected string, got ${typeof v}`);
  if (!allowEmpty && v.length === 0) throw new CommitParseError(where, 'must not be empty');
  return v;
}

function count(v: unknown, where: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new CommitParseError(where, 'expected non-negative number');
  }
  return Math.floor(v);
}

/**
 * Validate and normalize unknown JSON into CommitEvent[].
 * Throws CommitParseError with a JSON-path-like location on structural errors.
 * Order is preserved (input must be oldest first).
 */
export function parseCommitEvents(input: unknown): CommitEvent[] {
  if (!Array.isArray(input)) throw new CommitParseError('$', 'expected an array of commits');
  const out: CommitEvent[] = new Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as Record<string, unknown>;
    const w = `$[${i}]`;
    if (typeof c !== 'object' || c === null) throw new CommitParseError(w, 'expected object');
    const filesIn = c.files;
    if (!Array.isArray(filesIn)) throw new CommitParseError(`${w}.files`, 'expected array');
    const files: FileChange[] = [];
    for (let j = 0; j < filesIn.length; j++) {
      const f = filesIn[j] as Record<string, unknown>;
      const fw = `${w}.files[${j}]`;
      if (typeof f !== 'object' || f === null) throw new CommitParseError(fw, 'expected object');
      const rawStatus = str(f.status, `${fw}.status`, false).charAt(0).toUpperCase();
      const status = STATUS_MAP[rawStatus];
      if (!status) throw new CommitParseError(`${fw}.status`, `unknown status "${String(f.status)}"`);
      const path = normalizePath(str(f.path, `${fw}.path`, false));
      if (!path) throw new CommitParseError(`${fw}.path`, 'empty after normalization');
      const fc: FileChange = {
        path,
        status,
        added: count(f.added, `${fw}.added`),
        removed: count(f.removed, `${fw}.removed`),
      };
      if (status === 'R') {
        if (typeof f.old_path === 'string' && f.old_path.length > 0) {
          fc.old_path = normalizePath(f.old_path);
        } else {
          // A rename without its source is just an add.
          fc.status = 'A';
        }
      }
      files.push(fc);
    }
    out[i] = {
      hash: str(c.hash, `${w}.hash`, false),
      author: str(c.author, `${w}.author`) || 'unknown',
      email: c.email === undefined ? '' : str(c.email, `${w}.email`),
      date: str(c.date, `${w}.date`),
      message: c.message === undefined ? '' : str(c.message, `${w}.message`),
      files,
    };
  }
  return out;
}
