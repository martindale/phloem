// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from './events';

/**
 * Logical repository tree built incrementally from commit events.
 * Folders are branching nodes, files are leaves (food sources for the mold).
 *
 * The tree knows nothing about positions or physics; it only emits TreeOps
 * that the simulation turns into growth / nutrient / withering.
 * Node ids are stable and never reused (dead nodes stay in `nodes`).
 */

export enum NodeKind {
  Folder = 0,
  File = 1,
}

export interface TreeNode {
  id: number;
  kind: NodeKind;
  name: string;
  path: string;
  parent: number; // -1 for root
  depth: number;
  alive: boolean;
  children: number[]; // live children only
  /** Folders: number of live files underneath (recursive). */
  liveFiles: number;
}

export type TreeOp =
  | { op: 'add'; id: number; kind: NodeKind; parent: number }
  /** Nutrient injection at a file (A/M/R). weight = lines added+removed. */
  | { op: 'touch'; id: number; weight: number; added: boolean }
  | { op: 'remove'; id: number; kind: NodeKind }
  /** File moved (rename). fromParent === toParent for a same-folder rename. */
  | { op: 'move'; id: number; fromParent: number; toParent: number };

export const ROOT_ID = 0;

export class FileTree {
  readonly nodes: TreeNode[] = [];
  private byPath = new Map<string, number>();

  constructor() {
    this.nodes.push({
      id: ROOT_ID,
      kind: NodeKind.Folder,
      name: '',
      path: '',
      parent: -1,
      depth: 0,
      alive: true,
      children: [],
      liveFiles: 0,
    });
    this.byPath.set('', ROOT_ID);
  }

  get(id: number): TreeNode {
    return this.nodes[id];
  }

  /** Live node id at path, or -1. */
  lookup(path: string): number {
    const id = this.byPath.get(path);
    return id === undefined ? -1 : id;
  }

  get liveFileCount(): number {
    return this.nodes[ROOT_ID].liveFiles;
  }

  /** Apply one commit; appends resulting ops to `out` (in a deterministic order). */
  applyCommit(c: CommitEvent, out: TreeOp[]): void {
    for (const f of c.files) {
      const weight = f.added + f.removed;
      switch (f.status) {
        case 'A':
        case 'M': {
          let id = this.lookup(f.path);
          let added = false;
          if (id < 0 || this.nodes[id].kind !== NodeKind.File) {
            // 'M' on an unknown file happens when history is a window; treat as add.
            if (id >= 0) this.removeSubtree(id, out); // folder replaced by file (rare)
            id = this.addFile(f.path, out);
            added = true;
          }
          out.push({ op: 'touch', id, weight, added });
          break;
        }
        case 'D': {
          const id = this.lookup(f.path);
          if (id >= 0 && this.nodes[id].kind === NodeKind.File) this.removeFile(id, out);
          break;
        }
        case 'R': {
          const oldId = f.old_path !== undefined ? this.lookup(f.old_path) : -1;
          const existing = this.lookup(f.path);
          if (oldId < 0 || this.nodes[oldId].kind !== NodeKind.File) {
            // Source unknown: behave like an add.
            let id = existing;
            let added = false;
            if (id < 0 || this.nodes[id].kind !== NodeKind.File) {
              if (id >= 0) this.removeSubtree(id, out);
              id = this.addFile(f.path, out);
              added = true;
            }
            out.push({ op: 'touch', id, weight, added });
            break;
          }
          if (existing >= 0 && existing !== oldId) this.removeSubtree(existing, out); // overwrite
          this.moveFile(oldId, f.path, out);
          out.push({ op: 'touch', id: oldId, weight, added: false });
          break;
        }
      }
    }
  }

  private ensureFolder(path: string, out: TreeOp[]): number {
    const known = this.byPath.get(path);
    if (known !== undefined) {
      if (this.nodes[known].kind === NodeKind.Folder) return known;
      this.removeSubtree(known, out); // file replaced by folder
    }
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? ROOT_ID : this.ensureFolder(path.slice(0, slash), out);
    return this.createNode(NodeKind.Folder, path, parent, out);
  }

  private createNode(kind: NodeKind, path: string, parent: number, out: TreeOp[]): number {
    const id = this.nodes.length;
    const p = this.nodes[parent];
    this.nodes.push({
      id,
      kind,
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      parent,
      depth: p.depth + 1,
      alive: true,
      children: [],
      liveFiles: 0,
    });
    p.children.push(id);
    this.byPath.set(path, id);
    out.push({ op: 'add', id, kind, parent });
    return id;
  }

  private addFile(path: string, out: TreeOp[]): number {
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? ROOT_ID : this.ensureFolder(path.slice(0, slash), out);
    const id = this.createNode(NodeKind.File, path, parent, out);
    this.bumpLiveFiles(parent, 1);
    return id;
  }

  private bumpLiveFiles(folder: number, delta: number): void {
    for (let f = folder; f >= 0; f = this.nodes[f].parent) this.nodes[f].liveFiles += delta;
  }

  private detach(id: number): void {
    const n = this.nodes[id];
    const siblings = this.nodes[n.parent].children;
    const i = siblings.indexOf(id);
    if (i >= 0) siblings.splice(i, 1);
  }

  private removeFile(id: number, out: TreeOp[]): void {
    const n = this.nodes[id];
    n.alive = false;
    this.byPath.delete(n.path);
    this.detach(id);
    this.bumpLiveFiles(n.parent, -1);
    out.push({ op: 'remove', id, kind: NodeKind.File });
    this.pruneEmptyFolders(n.parent, out);
  }

  /** Remove empty folders walking upward (never the root). */
  private pruneEmptyFolders(folder: number, out: TreeOp[]): void {
    let f = folder;
    while (f !== ROOT_ID) {
      const n = this.nodes[f];
      if (n.liveFiles > 0 || n.children.length > 0) return;
      n.alive = false;
      this.byPath.delete(n.path);
      this.detach(f);
      out.push({ op: 'remove', id: f, kind: NodeKind.Folder });
      f = n.parent;
    }
  }

  private removeSubtree(id: number, out: TreeOp[]): void {
    const n = this.nodes[id];
    if (n.kind === NodeKind.File) {
      this.removeFile(id, out);
      return;
    }
    for (const c of n.children.slice()) this.removeSubtree(c, out);
    if (n.alive && id !== ROOT_ID) {
      n.alive = false;
      this.byPath.delete(n.path);
      this.detach(id);
      out.push({ op: 'remove', id, kind: NodeKind.Folder });
      this.pruneEmptyFolders(n.parent, out);
    }
  }

  private moveFile(id: number, newPath: string, out: TreeOp[]): void {
    const n = this.nodes[id];
    const fromParent = n.parent;
    const slash = newPath.lastIndexOf('/');
    const toParent = slash < 0 ? ROOT_ID : this.ensureFolder(newPath.slice(0, slash), out);
    this.byPath.delete(n.path);
    n.path = newPath;
    n.name = newPath.slice(slash + 1);
    this.byPath.set(newPath, id);
    if (toParent !== fromParent) {
      this.detach(id);
      this.bumpLiveFiles(fromParent, -1);
      n.parent = toParent;
      n.depth = this.nodes[toParent].depth + 1;
      this.nodes[toParent].children.push(id);
      this.bumpLiveFiles(toParent, 1);
    }
    out.push({ op: 'move', id, fromParent, toParent });
    if (toParent !== fromParent) this.pruneEmptyFolders(fromParent, out);
  }
}
