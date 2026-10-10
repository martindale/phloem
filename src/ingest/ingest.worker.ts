// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />
import type { CommitEvent } from '../model/events';
import { IngestError, ingestStream, type IngestProgress, type IngestResult } from './filestream';

/**
 * File ingestion worker: parses a git log / CommitEvent JSON upload off the main thread and streams validated batches back.
 * Cancel = `worker.terminate()` from the main thread (batches already delivered stay valid).
 */
declare const self: DedicatedWorkerGlobalScope;

export type ToIngest = { type: 'file'; file: Blob } | { type: 'text'; text: string };
export type FromIngest =
  | { type: 'batch'; commits: CommitEvent[]; progress: IngestProgress }
  | { type: 'done'; result: IngestResult }
  | { type: 'error'; message: string };

function post(m: FromIngest): void {
  self.postMessage(m);
}

self.onmessage = (ev: MessageEvent<ToIngest>) => {
  const msg = ev.data;
  const blob = msg.type === 'file' ? msg.file : new Blob([msg.text]);
  ingestStream(blob.stream() as ReadableStream<Uint8Array>, blob.size, {
    onBatch: (commits, progress) => post({ type: 'batch', commits, progress }),
  })
    .then((result) => post({ type: 'done', result }))
    .catch((e) => post({ type: 'error', message: e instanceof IngestError ? e.message : `Could not read the file: ${e instanceof Error ? e.message : String(e)}` }));
};
