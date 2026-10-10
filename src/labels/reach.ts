// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reached-gating for name labels. A name may only be shown once the mold has actually grown to its node
 * (the sim's per-anchor `reached` flag), never at commit time or because the node merely exists.
 */

/** True once the vein has reached the node (anchor `reached` flag). */
export function isReached(flag: number): boolean {
  return flag >= 0.5;
}

/** Detects the unreached -> reached edge per node id, frame to frame. Rewinding (seek back) forgets everything. */
export class ReachTracker {
  private prev = new Uint8Array(1024);
  private lastCommit = -Infinity;

  /** Call once per frame before `step`; a commit index going backwards (seek) means ids are about to be reassigned. */
  begin(commit: number): void {
    if (commit < this.lastCommit) this.prev.fill(0);
    this.lastCommit = commit;
  }

  /** Feed one anchor; returns true exactly when it became reached since it was last fed. */
  step(id: number, reached: boolean): boolean {
    if (id >= this.prev.length) {
      const g = new Uint8Array(Math.max(id + 1, this.prev.length * 2));
      g.set(this.prev);
      this.prev = g;
    }
    const was = this.prev[id] === 1;
    this.prev[id] = reached ? 1 : 0;
    return reached && !was;
  }

  reset(): void {
    this.prev.fill(0);
    this.lastCommit = -Infinity;
  }
}
