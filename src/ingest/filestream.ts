// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { CommitParseError, parseCommitEvents } from '../model/parse';
import { GitLogParser } from './gitlog';

/**
 * Turn an uploaded file (as a byte stream) into CommitEvent batches without holding the whole text in memory
 * and without blocking: used inside `ingest.worker.ts`, and directly by tests.
 *
 * Accepts the output of `git log` (see gitlog.ts), or JSON: an array of CommitEvent, or `{ "commits": [...] }`.
 * Encoding is sniffed from the BOM (UTF-8 / UTF-16, because PowerShell's `>` writes UTF-16).
 */
export interface IngestProgress {
  bytes: number;
  totalBytes: number;
  /** Commits delivered so far. */
  commits: number;
  /** Known total (JSON uploads); otherwise estimate from bytes. */
  expectedCommits?: number;
}

export interface IngestResult {
  format: 'gitlog' | 'json';
  commits: number;
  skippedLines: number;
  /** Set when the reader stopped at the commit limit before the end of the file: the limit. */
  truncated?: number;
}

/** Commits kept per upload (a parsed commit costs ~6 KB, held twice): a runaway or hostile file must not take the tab down. */
export const MAX_COMMITS = 250_000;

export class IngestError extends Error {}

export interface IngestOptions {
  signal?: AbortSignal;
  /** Called with validated commits, oldest first, in order. */
  onBatch(commits: CommitEvent[], progress: IngestProgress): void;
  /** First batch is released after this many ms even if small (so playback starts early). */
  firstBatchMs?: number;
  batchSize?: number;
  now?: () => number;
  /** Stop reading after this many commits (default MAX_COMMITS); the result says `truncated`. */
  maxCommits?: number;
}

const SLICE = 256 * 1024;

function sniffEncoding(b: Uint8Array): { label: string; skip: number } {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { label: 'utf-8', skip: 0 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { label: 'utf-16le', skip: 0 };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { label: 'utf-16be', skip: 0 };
  // BOM-less UTF-16LE of ASCII text: every second byte is 0
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return { label: 'utf-16le', skip: 0 };
  return { label: 'utf-8', skip: 0 };
}

function validate(batch: CommitEvent[], offset: number): CommitEvent[] {
  try {
    return parseCommitEvents(batch);
  } catch (e) {
    if (e instanceof CommitParseError) throw new IngestError(`Invalid commit near #${offset + 1}: ${e.message}`);
    throw e;
  }
}

export async function ingestStream(
  stream: ReadableStream<Uint8Array>,
  totalBytes: number,
  opts: IngestOptions,
): Promise<IngestResult> {
  const now = opts.now ?? (() => performance.now());
  const reader = stream.getReader();
  let decoder: TextDecoder | null = null;
  let bytes = 0;
  let sent = 0;
  let mode: 'unknown' | 'gitlog' | 'json' = 'unknown';
  const parser = new GitLogParser();
  const jsonParts: string[] = [];
  const t0 = now();
  let lastPost = t0;
  const batchSize = opts.batchSize ?? 1000;
  const firstMs = opts.firstBatchMs ?? 60;
  const maxCommits = opts.maxCommits ?? MAX_COMMITS;
  let truncated = false;

  const post = (force: boolean): void => {
    const n = parser.pending;
    if (n === 0) return;
    const t = now();
    const due = sent === 0 ? n >= 200 || t - t0 >= firstMs : n >= batchSize || t - lastPost >= 150;
    if (!due && !force) return;
    const batch = validate(parser.take(), sent);
    sent += batch.length;
    lastPost = t;
    opts.onBatch(batch, { bytes, totalBytes, commits: sent });
  };

  try {
    read: for (;;) {
      if (opts.signal?.aborted) throw new IngestError('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (!decoder) {
        const enc = sniffEncoding(value);
        decoder = new TextDecoder(enc.label);
      }
      const text = decoder.decode(value, { stream: true });
      if (mode === 'unknown') {
        const m = /\S/.exec(text);
        if (!m) continue;
        mode = text[m.index] === '[' || text[m.index] === '{' ? 'json' : 'gitlog';
      }
      if (mode === 'json') jsonParts.push(text);
      else {
        // large chunks are fed in slices so batches are released as soon as they are due
        for (let i = 0; i < text.length; i += SLICE) {
          parser.push(i === 0 && text.length <= SLICE ? text : text.slice(i, i + SLICE));
          post(false);
          if (sent + parser.pending >= maxCommits) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break read;
          }
        }
      }
    }
    if (decoder && !truncated) {
      const tail = decoder.decode();
      if (mode === 'json') jsonParts.push(tail);
      else if (mode === 'gitlog') parser.push(tail);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (mode === 'unknown') throw new IngestError('The file is empty.');
  if (mode === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(jsonParts.join(''));
    } catch (e) {
      throw new IngestError(`The file looks like JSON but does not parse: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray((data as { commits?: unknown }).commits)) {
      data = (data as { commits: unknown[] }).commits;
    }
    const commits = validateAll(data);
    for (let i = 0; i < commits.length; i += 2000) {
      if (opts.signal?.aborted) throw new IngestError('cancelled');
      opts.onBatch(commits.slice(i, i + 2000), {
        bytes,
        totalBytes,
        commits: Math.min(commits.length, i + 2000),
        expectedCommits: commits.length,
      });
    }
    if (commits.length === 0) throw new IngestError('The JSON file contains no commits.');
    return { format: 'json', commits: commits.length, skippedLines: 0 };
  }
  parser.end();
  post(true);
  if (parser.count === 0) {
    const hint = parser.samples.length ? ` First unrecognised line: "${parser.samples[0]}".` : '';
    throw new IngestError(
      `No commits found. Expected the output of the git log command under “Upload a git log instead” (or CommitEvent JSON).${hint}`,
    );
  }
  return { format: 'gitlog', commits: parser.count, skippedLines: parser.skipped, ...(truncated ? { truncated: maxCommits } : {}) };
}

function validateAll(data: unknown): CommitEvent[] {
  try {
    return parseCommitEvents(data);
  } catch (e) {
    if (e instanceof CommitParseError) throw new IngestError(`Invalid commit JSON: ${e.message}`);
    throw e;
  }
}

/** Stream over in-memory text (paste, tests). */
export function textStream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream() as ReadableStream<Uint8Array>;
}
