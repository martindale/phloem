// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hand-off between the landing page (src/entry.ts chunk, paints first) and the engine (src/main.ts chunk, loads behind it).
 * Neither imports the other; both import this small module. Types only from the ingest layer, so it costs nothing at runtime.
 */
import type { GithubRequest, LoadStatus } from '../ingest/session';
import type { MaxSetting } from './urlstate';

export interface AppApi {
  /** Start loading a GitHub repository (replaces whatever is shown). Pushes the URL. */
  loadGithub(req: GithubRequest, max?: MaxSetting): void;
  loadFile(file: File): void;
  /** Landing is up: slow orbit, labels off, chrome hidden, demo looping. Off: back to the normal viewer. */
  setBackdrop(on: boolean): void;
  /** The last request, so "try again" and the share link can reuse it. */
  retry(): void;
  cancel(): void;
  resume(): void;
}

export interface LandingApi {
  /** Show the landing card. `overlay` = opened from the viewer (has a close button, Escape closes it). */
  show(o?: { overlay?: boolean; status?: LoadStatus | null; prefill?: string; badRepo?: string | null; focusToken?: boolean }): void;
  hide(): void;
  readonly visible: boolean;
}

class Bridge {
  app: AppApi | null = null;
  landing: LandingApi | null = null;
  private waiters: Array<(a: AppApi) => void> = [];

  provideApp(a: AppApi): void {
    this.app = a;
    for (const w of this.waiters.splice(0)) w(a);
  }

  /** Resolves when the engine chunk has finished booting (immediately if it already has). */
  whenApp(): Promise<AppApi> {
    return this.app ? Promise.resolve(this.app) : new Promise((r) => this.waiters.push(r));
  }
}

export const bridge = new Bridge();
