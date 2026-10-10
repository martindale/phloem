// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { authorHue } from '../model/rng';
import { FileTree, NodeKind, type TreeNode, type TreeOp } from '../model/tree';

/**
 * Main-thread replica of the logical tree, used only to resolve node ids from
 * the frame's anchor section into names / paths / last-touching commit.
 *
 * `FileTree` is deterministic (ids are assigned in commit order and never
 * reused), so replaying the same commits up to `header[H.commit]` yields the
 * same ids as the sim worker without any extra protocol traffic. Seeking
 * backwards resets and replays; going forwards applies the missing commits.
 *
 * The commits array is read lazily, so a future `append` ingestion path only
 * needs to push to the same array (or call `setCommits` again) before the next
 * `sync`.
 */
export class LabelModel {
  tree = new FileTree();
  commits: CommitEvent[] = [];
  /** Index of the last commit applied to `tree` (-1 = none). */
  applied = -1;
  /** Last commit index that touched each node id (-1 = never). */
  lastCommit: number[] = [-1];
  /** Wall-clock second (caller's clock) a node was last touched live; -Infinity if never. */
  touchedAt: Float64Array = new Float64Array(1024).fill(-Infinity);
  /** Unique author names, and the float32 hue (as drawn by the pulse shader) -> author index. */
  authors: string[] = [];
  authorHues: number[] = [];
  hueIndex = new Map<number, number>();
  /** Live folder ids (compacted as folders die); folders are labelled from this list, not by scanning every anchor. */
  dirIds: number[] = [];
  /**
   * Recently touched files in touch order (parallel `recentAt` = touch time). Entries whose time no longer matches
   * `touchedAt[id]` were superseded by a later touch. Drained by `pruneRecent`.
   */
  recentIds: number[] = [];
  recentAt: number[] = [];
  recentHead = 0;
  private ops: TreeOp[] = [];
  private liveWindow = 4;

  private authorSeen = new Set<string>();

  setCommits(commits: CommitEvent[]): void {
    this.commits = commits;
    this.authors = [];
    this.authorHues = [];
    this.hueIndex.clear();
    this.authorSeen.clear();
    this.registerAuthors(commits);
    this.reset();
  }

  /**
   * Ingestion: commits arrived while the sim runs. Pushes them onto `commits` (the array shared with the shell, so callers must
   * not push themselves) and registers new authors. The tree replica is not reset: `sync` applies the new commits lazily.
   */
  appendCommits(more: CommitEvent[]): void {
    for (const c of more) this.commits.push(c);
    this.registerAuthors(more);
  }

  private registerAuthors(commits: CommitEvent[]): void {
    for (const c of commits) {
      if (this.authorSeen.has(c.author)) continue;
      this.authorSeen.add(c.author);
      const i = this.authors.length;
      this.authors.push(c.author);
      this.authorHues.push(authorHue(c.author));
      this.hueIndex.set(Math.fround(authorHue(c.author)), i);
    }
  }

  reset(): void {
    this.tree = new FileTree();
    this.applied = -1;
    this.lastCommit = [-1];
    this.touchedAt.fill(-Infinity);
    this.dirIds.length = 0;
    this.recentIds.length = 0;
    this.recentAt.length = 0;
    this.recentHead = 0;
  }

  private grow(id: number): void {
    while (this.lastCommit.length <= id) this.lastCommit.push(-1);
    if (this.touchedAt.length <= id) {
      const t = new Float64Array(Math.max(id + 1, this.touchedAt.length * 2)).fill(-Infinity);
      t.set(this.touchedAt);
      this.touchedAt = t;
    }
  }

  /**
   * Bring the replica to `commitIndex`. Files touched by the last few commits of a
   * small forward step are stamped `now` (they get the live highlight); big jumps
   * (seeks) only stamp the final commit.
   */
  sync(commitIndex: number, now: number): void {
    const target = Math.min(commitIndex, this.commits.length - 1);
    if (target < this.applied) this.reset();
    if (target === this.applied) return;
    const step = target - this.applied;
    const liveFrom = step <= this.liveWindow ? this.applied + 1 : target;
    for (let i = this.applied + 1; i <= target; i++) {
      this.ops.length = 0;
      this.tree.applyCommit(this.commits[i], this.ops);
      const live = i >= liveFrom;
      for (const op of this.ops) {
        if (op.op === 'add') {
          this.grow(op.id);
          if (op.kind === NodeKind.Folder) this.dirIds.push(op.id);
        }
        else if (op.op === 'touch') {
          this.grow(op.id);
          this.lastCommit[op.id] = i;
          if (live) {
            this.touchedAt[op.id] = now;
            this.recentIds.push(op.id);
            this.recentAt.push(now);
          }
        }
      }
    }
    this.applied = target;
    // drop dead folders
    const dirs = this.dirIds;
    let w = 0;
    for (let k = 0; k < dirs.length; k++) if (this.tree.nodes[dirs[k]].alive) dirs[w++] = dirs[k];
    dirs.length = w;
  }

  /** Forget recent-touch entries older than `maxAge` seconds (they can no longer be active). */
  pruneRecent(now: number, maxAge: number): void {
    const at = this.recentAt;
    while (this.recentHead < at.length && at[this.recentHead] < now - maxAge) this.recentHead++;
    if (this.recentHead > 2048) {
      this.recentIds.splice(0, this.recentHead);
      this.recentAt.splice(0, this.recentHead);
      this.recentHead = 0;
    }
  }

  node(id: number): TreeNode | undefined {
    return this.tree.nodes[id];
  }
}
