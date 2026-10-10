// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { CommitEvent, FileChange } from '../src/model/events';
import { FileTree, NodeKind, ROOT_ID, type TreeOp } from '../src/model/tree';

const commit = (files: FileChange[]): CommitEvent => ({ hash: 'h', author: 'a', email: '', date: '', message: '', files });
const A = (path: string): FileChange => ({ path, status: 'A', added: 1, removed: 0 });

function apply(tree: FileTree, files: FileChange[]): TreeOp[] {
  const ops: TreeOp[] = [];
  tree.applyCommit(commit(files), ops);
  return ops;
}

describe('FileTree', () => {
  it('creates folders as branching nodes and files as leaves', () => {
    const t = new FileTree();
    const ops = apply(t, [A('src/a.ts'), A('src/lib/b.ts'), A('README.md')]);
    const src = t.lookup('src');
    const lib = t.lookup('src/lib');
    expect(t.get(src).kind).toBe(NodeKind.Folder);
    expect(t.get(lib).parent).toBe(src);
    expect(t.get(t.lookup('src/lib/b.ts')).kind).toBe(NodeKind.File);
    expect(t.get(t.lookup('src/lib/b.ts')).depth).toBe(3);
    expect(t.get(ROOT_ID).liveFiles).toBe(3);
    expect(t.get(src).liveFiles).toBe(2);
    // parents are always added before children
    const added = ops.filter((o) => o.op === 'add').map((o) => o.id);
    for (const id of added) {
      const p = t.get(id).parent;
      expect(p === ROOT_ID || added.indexOf(p) < added.indexOf(id)).toBe(true);
    }
    expect(ops.filter((o) => o.op === 'touch')).toHaveLength(3);
  });

  it('deletes files and prunes empty folders upward', () => {
    const t = new FileTree();
    apply(t, [A('a/b/c.txt'), A('a/d.txt')]);
    const b = t.lookup('a/b');
    const ops = apply(t, [{ path: 'a/b/c.txt', status: 'D', added: 0, removed: 1 }]);
    expect(ops.map((o) => o.op)).toEqual(['remove', 'remove']);
    expect(t.get(b).alive).toBe(false);
    expect(t.lookup('a/b')).toBe(-1);
    expect(t.lookup('a')).toBeGreaterThan(0); // still holds d.txt
    expect(t.liveFileCount).toBe(1);
  });

  it('moves a renamed file, keeping its identity', () => {
    const t = new FileTree();
    apply(t, [A('old/x.ts')]);
    const id = t.lookup('old/x.ts');
    const ops = apply(t, [{ path: 'new/y.ts', old_path: 'old/x.ts', status: 'R', added: 0, removed: 0 }]);
    expect(t.lookup('new/y.ts')).toBe(id);
    expect(t.lookup('old/x.ts')).toBe(-1);
    expect(t.get(id).parent).toBe(t.lookup('new'));
    const move = ops.find((o) => o.op === 'move');
    expect(move).toMatchObject({ id, toParent: t.lookup('new') });
    // the emptied source folder withers
    expect(ops.some((o) => o.op === 'remove' && o.kind === NodeKind.Folder)).toBe(true);
    expect(t.liveFileCount).toBe(1);
  });

  it('tolerates history windows (modify/rename of unknown files)', () => {
    const t = new FileTree();
    const ops = apply(t, [
      { path: 'm.ts', status: 'M', added: 1, removed: 1 },
      { path: 'r.ts', old_path: 'gone.ts', status: 'R', added: 0, removed: 0 },
      { path: 'nothere.ts', status: 'D', added: 0, removed: 3 },
    ]);
    expect(t.liveFileCount).toBe(2);
    expect(ops.filter((o) => o.op === 'touch' && o.added)).toHaveLength(2);
  });

  it('re-adding a deleted path creates a fresh node', () => {
    const t = new FileTree();
    apply(t, [A('f')]);
    const first = t.lookup('f');
    apply(t, [{ path: 'f', status: 'D', added: 0, removed: 1 }]);
    apply(t, [A('f')]);
    expect(t.lookup('f')).not.toBe(first);
    expect(t.get(first).alive).toBe(false);
  });
});
