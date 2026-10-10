// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saved histories: a completed GitHub load is kept on this device (IndexedDB) so reopening the repository is instant and spends no
 * API quota. Separate from src/ingest/idbcache.ts, which caches per-commit details (SHA keyed) to resume interrupted loads; this one
 * caches the finished CommitEvent[] of a whole window. Public repositories only (the caller decides; see webapp.ts).
 *
 * Key = owner/repo@branch (lower-cased). A saved entry serves a request when it was fetched with a window at least as large (commit
 * mode: the newest N commits are sliced out) or exactly as large (snapshot mode, where the samples depend on the window).
 * Best effort everywhere: if IndexedDB is unavailable every call quietly does nothing.
 */
import type { CommitEvent } from '../model/events';
import { whenMigrated } from './migrate';

export interface SavedMeta {
  key: string;
  repo: string; // owner/name as typed
  branch: string; // resolved branch ('' when unknown)
  max: number; // window the history was fetched with
  mode: 'commits' | 'snapshots';
  fetchedAt: number; // epoch ms
  count: number;
}

export interface SavedHistory extends SavedMeta {
  commits: CommitEvent[];
}

export function historyKey(owner: string, repo: string, branch: string | undefined): string {
  return `${owner}/${repo}@${branch ?? ''}`.toLowerCase();
}

/** Can `saved` answer a request for the newest `max` commits? Returns the commits to show, or null. */
export function reuse(saved: SavedHistory, max: number): CommitEvent[] | null {
  if (saved.mode === 'commits') {
    if (saved.max < max && saved.count >= saved.max) return null; // window was cut at saved.max and the request wants more
    return saved.commits.slice(-max);
  }
  return saved.max === max ? saved.commits : null;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const DB = 'phloem-histories';
const META = 'meta';
const DATA = 'data';

async function open(): Promise<IDBDatabase> {
  await whenMigrated(); // data saved under the former name is copied over first
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META);
      req.result.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => resolve();
  });
}

function result<T>(r: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}

export async function getHistory(key: string): Promise<SavedHistory | null> {
  try {
    const db = await open();
    const tx = db.transaction([META, DATA], 'readonly');
    const [meta, commits] = await Promise.all([result(tx.objectStore(META).get(key)), result(tx.objectStore(DATA).get(key))]);
    db.close();
    return meta && commits ? { ...(meta as SavedMeta), commits: commits as CommitEvent[] } : null;
  } catch {
    return null;
  }
}

export async function putHistory(h: SavedHistory): Promise<boolean> {
  try {
    const db = await open();
    const tx = db.transaction([META, DATA], 'readwrite');
    const { commits, ...meta } = h;
    tx.objectStore(META).put(meta, h.key);
    tx.objectStore(DATA).put(commits, h.key);
    await done(tx);
    db.close();
    await evictOld();
    return true;
  } catch {
    return false; // quota or blocked: the app works the same without it
  }
}

/** Saved histories kept on the device; the least recently fetched beyond this are dropped, so browsing many repositories cannot fill the disk. */
export const MAX_SAVED = 12;

/** Keys to delete so that at most `keep` of the newest remain. Pure. */
export function evictions(metas: Array<Pick<SavedMeta, 'key' | 'fetchedAt'>>, keep = MAX_SAVED): string[] {
  return [...metas]
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(keep)
    .map((m) => m.key);
}

async function evictOld(): Promise<void> {
  try {
    const drop = evictions(await listHistories());
    if (drop.length === 0) return;
    const db = await open();
    const tx = db.transaction([META, DATA], 'readwrite');
    for (const k of drop) {
      tx.objectStore(META).delete(k);
      tx.objectStore(DATA).delete(k);
    }
    await done(tx);
    db.close();
  } catch {
    /* best effort */
  }
}

export async function listHistories(): Promise<SavedMeta[]> {
  try {
    const db = await open();
    const all = await result(db.transaction(META, 'readonly').objectStore(META).getAll());
    db.close();
    return ((all ?? []) as SavedMeta[]).sort((a, b) => b.fetchedAt - a.fetchedAt);
  } catch {
    return [];
  }
}

export async function clearHistories(): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(DATA).clear();
    await done(tx);
    db.close();
  } catch {
    /* nothing to clear */
  }
}
