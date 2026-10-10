// SPDX-License-Identifier: AGPL-3.0-only
import fixtureJson from '../../fixtures/stemdeck-first10.json';
import type { CommitEvent } from '../model/events';
import { parseCommitEvents } from '../model/parse';
import { generateStressCommits } from './stress';

/**
 * Where commit events come from. This is the seam for the ingestion work:
 * anything that yields CommitEvent[] (oldest first) can feed the app.
 *
 * URL params (dev): default and ?fixture=stemdeck-full -> full stemdeck history (lazy chunk);
 * ?fixture=stemdeck-first10 -> first 10 commits (bundled).
 * ?stress=5000&commits=120&seed=3 -> synthetic history.
 */
export interface Source {
  label: string;
  commits: CommitEvent[];
}

export async function initialSource(params: URLSearchParams): Promise<Source> {
  const stress = params.get('stress');
  if (stress !== null) {
    const files = Math.max(10, Number(stress) || 5000);
    const commits = Math.max(2, Number(params.get('commits')) || 120);
    return {
      label: `synthetic, ${files} files`,
      commits: generateStressCommits({ files, commits, seed: Number(params.get('seed')) || 7 }),
    };
  }
  if (params.get('fixture') === 'stemdeck-first10') {
    return { label: 'stemdeck (first 10)', commits: parseCommitEvents(fixtureJson) };
  }
  // Default and ?fixture=stemdeck-full: lazy chunk, only fetched when needed.
  const full = await import('../../fixtures/stemdeck-full.json');
  return { label: 'stemdeck (full)', commits: parseCommitEvents(full.default) };
}
