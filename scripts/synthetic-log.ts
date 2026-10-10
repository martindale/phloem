// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Write a synthetic history as `git log --first-parent --reverse -M --raw --numstat --format='@@%H%x09%aI%x09%an%x09%ae%x09%s'` text.
 *   npm run synth-log -- <out> [files=15000] [commits=20000] [seed=7]
 */
import { writeFileSync } from 'node:fs';
import { generateStressCommits } from '../src/ingest/stress';
import type { CommitEvent } from '../src/model/events';

export function toGitLog(commits: CommitEvent[]): string {
  const out: string[] = [];
  for (const c of commits) {
    out.push(`@@${c.hash}\t${c.date}\t${c.author}\t${c.email}\t${c.message}`, '');
    for (const f of c.files) {
      const mode = f.status === 'D' ? '100644 000000' : f.status === 'A' ? '000000 100644' : '100644 100644';
      const code = f.status === 'R' ? 'R100' : f.status;
      out.push(`:${mode} abc1234 abc1234 ${code}\t${f.status === 'R' ? `${f.old_path}\t${f.path}` : f.path}`);
    }
    for (const f of c.files) out.push(`${f.added}\t${f.removed}\t${f.path}`);
  }
  return out.join('\n') + '\n';
}

if (process.env.SYNTH_LOG_MAIN) {
  const [out, files = '15000', commits = '20000', seed = '7'] = process.argv.slice(2);
  if (out) {
    const c = generateStressCommits({ files: Number(files), commits: Number(commits), seed: Number(seed) });
    const text = toGitLog(c);
    writeFileSync(out, text);
    console.log(`${out}: ${commits} commits, ${files} files target, ${(text.length / 1e6).toFixed(1)} MB`);
  }
}
