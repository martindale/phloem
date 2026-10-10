// SPDX-License-Identifier: AGPL-3.0-only
/** Turns the ingest layer's `LoadStatus` into what the page shows: a tone, a headline, details and the actions that make sense. Pure. */
import type { LoadStatus } from '../ingest/session';

export type StatusAction = 'cancel' | 'resume' | 'token' | 'open' | 'dismiss';

export interface StatusView {
  tone: 'busy' | 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
  notes: string[];
  /** 0..1, undefined = indeterminate (only meaningful while busy). */
  fraction?: number;
  /** Nothing is on screen yet, so this is the page's whole state (landing card / centred loader) rather than a pill. */
  blocking: boolean;
  actions: StatusAction[];
  /** Label for the 'resume' action. */
  resumeLabel: string;
}

export function describeStatus(s: LoadStatus, o: { hasToken: boolean; now?: number } = { hasToken: false }): StatusView {
  const now = o.now ?? Date.now();
  const empty = s.delivered === 0;
  const notes = s.notes ?? [];
  const base = { notes, fraction: s.fraction, blocking: empty, resumeLabel: 'Resume' };
  switch (s.state) {
    case 'running':
      return { ...base, tone: 'busy', title: s.message, detail: s.detail, actions: ['cancel'] };
    case 'done':
      return { ...base, tone: 'ok', title: s.message, detail: s.detail, actions: notes.length ? ['dismiss'] : [] };
    case 'rate-limited': {
      const retryNow = !!s.resetAt && s.resetAt <= now;
      const actions: StatusAction[] = [];
      if (s.canResume) actions.push('resume');
      if (!o.hasToken) actions.push('token');
      actions.push(empty ? 'open' : 'dismiss');
      return {
        ...base,
        tone: 'warn',
        title: empty ? 'GitHub rate limit reached before anything loaded' : 'GitHub rate limit reached. Showing what was loaded.',
        detail: s.message,
        resumeLabel: retryNow ? 'Try again now' : 'Resume',
        actions,
      };
    }
    case 'cancelled':
      return { ...base, tone: 'warn', title: s.message, detail: s.detail, actions: [...(s.canResume ? (['resume'] as const) : []), empty ? 'open' : 'dismiss'] };
    default: {
      const actions: StatusAction[] = [];
      if (s.canResume) actions.push('resume');
      if (!o.hasToken && /token|private|rate limit/i.test(s.message)) actions.push('token');
      actions.push(empty ? 'open' : 'dismiss');
      return { ...base, tone: 'error', title: empty ? 'Could not load this repository' : 'Loading stopped. Showing what was loaded.', detail: s.message, actions };
    }
  }
}
