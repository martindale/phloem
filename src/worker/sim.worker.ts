// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />
import { SimController } from './controller';
import type { FromWorker, ToWorker } from './protocol';

/**
 * Sim worker. Stepping is driven by frame requests from the main thread (one buffer in flight = natural backpressure).
 * All logic lives in `SimController` (testable in Node); this file only binds it to the worker's message port and event loop.
 */
declare const self: DedicatedWorkerGlobalScope;

let seekScheduled = false;
function scheduleSeek(): void {
  if (seekScheduled) return;
  seekScheduled = true;
  setTimeout(seekChunk, 0);
}
function seekChunk(): void {
  seekScheduled = false;
  try {
    if (ctl.seekWork(30)) scheduleSeek();
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) } satisfies FromWorker);
  }
}

/**
 * Checkpoint memory: ~80 MB per GB of device memory (Chrome reports 0.25-8; absent in Firefox/Safari -> assume 4), clamped to 160-640 MB.
 * Beyond the budget the checkpoint spacing doubles (see sim/snapshot.ts).
 */
const deviceGb = (self.navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
const budgetBytes = Math.max(160, Math.min(640, Math.round(deviceGb * 80))) * 1024 * 1024;
const ctl = new SimController((msg, transfer = []) => self.postMessage(msg, transfer), scheduleSeek, undefined, { budgetBytes });
self.onmessage = (ev: MessageEvent<ToWorker>) => ctl.handle(ev.data);
