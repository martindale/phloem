// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-time migration of data saved under the app's former name ("gitmold") to the Phloem names. Run once per page load from
 * src/entry.ts; every step is a no-op when there is nothing to migrate, and best effort: blocked storage, a missing IndexedDB or a
 * failure leaves the old data where it is (it is retried on the next load) and never breaks the page.
 *
 *   localStorage    gitmold.ghtoken.saved   -> phloem.ghtoken.saved   (the saved GitHub token; an existing new value wins)
 *   sessionStorage  gitmold.ghtoken         -> removed (the retired dialog's key; it was never read)
 *   IndexedDB       gitmold-histories       -> phloem-histories       (saved histories: stores meta, data)
 *                   gitmold-cache           -> phloem-cache           (per-commit details: store commits)
 *
 * For IndexedDB the records are copied (records already present in the new database win), and the old database is deleted only
 * after the copy succeeded. This module can be deleted once nobody is expected to hold pre-rename data.
 */

export const LEGACY = {
  tokenKey: 'gitmold.ghtoken.saved',
  sessionTokenKey: 'gitmold.ghtoken',
  historiesDb: 'gitmold-histories',
  cacheDb: 'gitmold-cache',
} as const;

export const CURRENT = {
  tokenKey: 'phloem.ghtoken.saved',
  historiesDb: 'phloem-histories',
  cacheDb: 'phloem-cache',
} as const;

/** The IndexedDB databases to carry over: old name, new name and the object stores (all out-of-line keys, version 1). */
export const DB_MIGRATIONS = [
  { from: LEGACY.historiesDb, to: CURRENT.historiesDb, stores: ['meta', 'data'] },
  { from: LEGACY.cacheDb, to: CURRENT.cacheDb, stores: ['commits'] },
] as const;

export type StoreRecords = Record<string, Array<[IDBValidKey, unknown]>>;

/** What the migration needs from IndexedDB; the real implementation is `idbBackend`, tests pass an in-memory one. */
export interface DbBackend {
  /** All records of the given stores of database `name`, or null when that database does not exist (it must not be created). */
  read(name: string, stores: readonly string[]): Promise<StoreRecords | null>;
  /** Write the records into `name` (created with `stores` if needed) without overwriting keys that already exist. */
  writeMissing(name: string, stores: readonly string[], records: StoreRecords): Promise<void>;
  remove(name: string): Promise<void>;
}

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface MigrationEnv {
  local?: () => KeyStorage;
  session?: () => KeyStorage;
  /** Undefined when IndexedDB is unavailable. */
  db?: DbBackend;
}

export interface MigrationReport {
  token: 'migrated' | 'kept-new' | 'none' | 'error';
  databases: Record<string, 'migrated' | 'none' | 'error'>;
}

export function migrateKeyValues(env: MigrationEnv): MigrationReport['token'] {
  let token: MigrationReport['token'] = 'none';
  try {
    const local = env.local?.();
    if (local) {
      const old = local.getItem(LEGACY.tokenKey);
      if (old !== null) {
        if (!local.getItem(CURRENT.tokenKey) && old) {
          local.setItem(CURRENT.tokenKey, old);
          token = 'migrated';
        } else token = 'kept-new';
        local.removeItem(LEGACY.tokenKey); // only reached when the write above did not throw
      }
    }
  } catch {
    token = 'error'; // storage blocked or full: the old value stays
  }
  try {
    env.session?.().removeItem(LEGACY.sessionTokenKey);
  } catch {
    /* ignore */
  }
  return token;
}

export async function migrateDatabases(db: DbBackend | undefined): Promise<MigrationReport['databases']> {
  const out: MigrationReport['databases'] = {};
  if (!db) return out;
  for (const m of DB_MIGRATIONS) {
    try {
      const records = await db.read(m.from, m.stores);
      if (!records) {
        out[m.from] = 'none';
        continue;
      }
      await db.writeMissing(m.to, m.stores, records);
      await db.remove(m.from);
      out[m.from] = 'migrated';
    } catch {
      out[m.from] = 'error'; // keep the old database; try again next time
    }
  }
  return out;
}

export async function migrateLegacyData(env: MigrationEnv): Promise<MigrationReport> {
  const token = migrateKeyValues(env);
  return { token, databases: await migrateDatabases(env.db) };
}

// ---------------------------------------------------------------- the real IndexedDB backend

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function idbBackend(factory: IDBFactory): DbBackend {
  return {
    async read(name, stores) {
      // opening a database that does not exist would create it: detect that in the upgrade step, abort and report "absent"
      let created = false;
      const opening = factory.open(name);
      opening.onupgradeneeded = (ev) => {
        if (ev.oldVersion === 0) {
          created = true;
          opening.transaction?.abort();
        }
      };
      let db: IDBDatabase;
      try {
        db = await request(opening);
      } catch (e) {
        if (created) return null;
        throw e;
      }
      try {
        const names = Array.from(db.objectStoreNames).filter((n) => stores.includes(n));
        if (names.length === 0) return null;
        const tx = db.transaction(names, 'readonly');
        const out: StoreRecords = {};
        await Promise.all(
          names.map(async (n) => {
            const store = tx.objectStore(n);
            const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
            out[n] = keys.map((k, i) => [k, values[i]] as [IDBValidKey, unknown]);
          }),
        );
        return out;
      } finally {
        db.close();
      }
    },

    async writeMissing(name, stores, records) {
      const opening = factory.open(name, 1);
      opening.onupgradeneeded = () => {
        for (const s of stores) if (!opening.result.objectStoreNames.contains(s)) opening.result.createObjectStore(s);
      };
      const db = await request(opening);
      try {
        for (const s of stores) {
          const rows = records[s] ?? [];
          if (rows.length === 0) continue;
          const tx = db.transaction(s, 'readwrite');
          const store = tx.objectStore(s);
          for (const [k, v] of rows) {
            // add() fails for a key that already exists: the new database wins; that failure must not abort the transaction
            store.add(v, k).onerror = (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
            };
          }
          await txDone(tx);
        }
      } finally {
        db.close();
      }
    },

    remove(name) {
      return new Promise((resolve, reject) => {
        const r = factory.deleteDatabase(name);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
        r.onblocked = () => resolve(); // another tab still has it open; deletion completes when that tab closes it
      });
    },
  };
}

let pending: Promise<MigrationReport> | null = null;

/** Start the migration once (idempotent). Safe with blocked storage and without IndexedDB. */
export function startMigration(): Promise<MigrationReport> {
  if (!pending) {
    pending = migrateLegacyData({
      local: () => localStorage,
      session: () => sessionStorage,
      db: typeof indexedDB === 'undefined' ? undefined : idbBackend(indexedDB),
    }).catch(() => ({ token: 'error', databases: {} }) as MigrationReport);
  }
  return pending;
}

/** Resolves when the migration has finished (immediately if it has not been started). Await it before opening the Phloem databases. */
export function whenMigrated(): Promise<unknown> {
  return pending ?? Promise.resolve();
}
