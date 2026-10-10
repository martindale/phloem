// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { whenMigrated } from '../web/migrate';
import { MemoryCache, type DetailCache } from './github';

/**
 * IndexedDB-backed DetailCache: commit details of PUBLIC repositories, keyed by commit SHA (immutable), so a retry after a rate limit,
 * or a reload, does not spend quota again. Private repositories are never written (the ingest checks the repo's `private` flag).
 * Everything is best effort: if IndexedDB is unavailable (private mode, blocked) it silently degrades to an in-memory cache.
 */
const DB = 'phloem-cache';
const STORE = 'commits';

async function openDb(): Promise<IDBDatabase> {
  await whenMigrated(); // data saved under the former name is copied over first (src/web/migrate.ts)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openDetailCache(): Promise<DetailCache> {
  try {
    const db = await openDb();
    return {
      getMany(shas: string[]): Promise<Map<string, CommitEvent>> {
        return new Promise((resolve) => {
          const out = new Map<string, CommitEvent>();
          try {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            for (const sha of shas) {
              const r = store.get(sha);
              r.onsuccess = () => {
                if (r.result) out.set(sha, r.result as CommitEvent);
              };
            }
            tx.oncomplete = () => resolve(out);
            tx.onerror = tx.onabort = () => resolve(out);
          } catch {
            resolve(out);
          }
        });
      },
      put(sha: string, ev: CommitEvent): void {
        try {
          db.transaction(STORE, 'readwrite').objectStore(STORE).put(ev, sha);
        } catch {
          /* best effort */
        }
      },
    };
  } catch {
    return new MemoryCache();
  }
}

export async function clearDetailCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch {
    /* nothing to clear */
  }
}
