// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Canonical commit-event interface (see fixtures/README.md).
 *
 * Everything upstream of the simulation (fixtures, synthetic stress data, and
 * later GitHub/git ingestion) must produce `CommitEvent[]`, oldest first.
 * Everything downstream (tree builder, sim worker) consumes only this shape.
 */

export type FileStatus = 'A' | 'M' | 'D' | 'R';

export interface FileChange {
  /** Path after the change, normalized (no leading "./" or "/", no "//"). */
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  /** Only for status 'R': path before the rename. */
  old_path?: string;
}

export interface CommitEvent {
  hash: string;
  author: string;
  email: string;
  /** ISO 8601 with offset. */
  date: string;
  message: string;
  files: FileChange[];
}
