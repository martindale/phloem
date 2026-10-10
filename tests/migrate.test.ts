// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CURRENT, LEGACY, migrateDatabases, migrateKeyValues, migrateLegacyData, type DbBackend, type StoreRecords } from '../src/web/migrate';

function fakeStorage(init: Record<string, string> = {}, opts: { throwOnSet?: boolean; throwAll?: boolean } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem(k: string) {
      if (opts.throwAll) throw new Error('blocked');
      return m.has(k) ? (m.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      if (opts.throwAll || opts.throwOnSet) throw new Error('quota');
      m.set(k, v);
    },
    removeItem(k: string) {
      if (opts.throwAll) throw new Error('blocked');
      m.delete(k);
    },
  };
}

/** In-memory stand-in for the IndexedDB backend: databases are name -> store -> key -> value. */
function fakeDb(initial: Record<string, StoreRecords> = {}, opts: { failWrite?: boolean } = {}) {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const put = (name: string, recs: StoreRecords) => {
    const db = dbs.get(name) ?? new Map<string, Map<string, unknown>>();
    for (const [s, rows] of Object.entries(recs)) {
      const st = db.get(s) ?? new Map<string, unknown>();
      for (const [k, v] of rows) st.set(String(k), v);
      db.set(s, st);
    }
    dbs.set(name, db);
  };
  for (const [n, r] of Object.entries(initial)) put(n, r);
  const calls: string[] = [];
  const backend: DbBackend = {
    async read(name, stores) {
      calls.push(`read ${name}`);
      const db = dbs.get(name);
      if (!db) return null;
      const out: StoreRecords = {};
      for (const s of stores) if (db.has(s)) out[s] = [...(db.get(s) as Map<string, unknown>)].map(([k, v]) => [k, v]);
      return out;
    },
    async writeMissing(name, stores, records) {
      calls.push(`write ${name}`);
      if (opts.failWrite) throw new Error('quota');
      const db = dbs.get(name) ?? new Map<string, Map<string, unknown>>();
      for (const s of stores) {
        const st = db.get(s) ?? new Map<string, unknown>();
        for (const [k, v] of records[s] ?? []) if (!st.has(String(k))) st.set(String(k), v);
        db.set(s, st);
      }
      dbs.set(name, db);
    },
    async remove(name) {
      calls.push(`remove ${name}`);
      dbs.delete(name);
    },
  };
  return { backend, dbs, calls };
}

describe('migration from the former name: keys', () => {
  it('moves the saved token and removes the old keys', () => {
    const local = fakeStorage({ [LEGACY.tokenKey]: 'github_pat_X' });
    const session = fakeStorage({ [LEGACY.sessionTokenKey]: 'old' });
    expect(migrateKeyValues({ local: () => local, session: () => session })).toBe('migrated');
    expect(local.m.get(CURRENT.tokenKey)).toBe('github_pat_X');
    expect(local.m.has(LEGACY.tokenKey)).toBe(false);
    expect(session.m.has(LEGACY.sessionTokenKey)).toBe(false);
  });

  it('is a no-op without old data, and idempotent', () => {
    const local = fakeStorage({ other: '1' });
    expect(migrateKeyValues({ local: () => local, session: () => fakeStorage() })).toBe('none');
    expect([...local.m.keys()]).toEqual(['other']);
    const l2 = fakeStorage({ [LEGACY.tokenKey]: 't' });
    migrateKeyValues({ local: () => l2 });
    expect(migrateKeyValues({ local: () => l2 })).toBe('none');
    expect(l2.m.get(CURRENT.tokenKey)).toBe('t');
  });

  it('never overwrites a token that is already saved under the new key', () => {
    const local = fakeStorage({ [LEGACY.tokenKey]: 'old', [CURRENT.tokenKey]: 'new' });
    expect(migrateKeyValues({ local: () => local })).toBe('kept-new');
    expect(local.m.get(CURRENT.tokenKey)).toBe('new');
    expect(local.m.has(LEGACY.tokenKey)).toBe(false);
  });

  it('keeps the old value when the write fails (quota) and survives blocked storage', () => {
    const quota = fakeStorage({ [LEGACY.tokenKey]: 'old' }, { throwOnSet: true });
    expect(migrateKeyValues({ local: () => quota })).toBe('error');
    expect(quota.m.get(LEGACY.tokenKey)).toBe('old');
    const blocked = fakeStorage({}, { throwAll: true });
    expect(() => migrateKeyValues({ local: () => blocked, session: () => blocked })).not.toThrow();
    expect(() => migrateKeyValues({ local: () => { throw new Error('SecurityError'); }, session: () => { throw new Error('SecurityError'); } })).not.toThrow();
    expect(() => migrateKeyValues({})).not.toThrow();
  });
});

describe('migration from the former name: IndexedDB', () => {
  const histories: StoreRecords = { meta: [['a/b@main', { key: 'a/b@main', count: 2 }]], data: [['a/b@main', [{ sha: '1' }, { sha: '2' }]]] };
  const cache: StoreRecords = { commits: [['sha1', { sha: 'sha1' }], ['sha2', { sha: 'sha2' }]] };

  it('copies histories and the commit cache, then deletes the old databases', async () => {
    const f = fakeDb({ [LEGACY.historiesDb]: histories, [LEGACY.cacheDb]: cache });
    const r = await migrateDatabases(f.backend);
    expect(r).toEqual({ [LEGACY.historiesDb]: 'migrated', [LEGACY.cacheDb]: 'migrated' });
    expect(f.dbs.has(LEGACY.historiesDb)).toBe(false);
    expect(f.dbs.has(LEGACY.cacheDb)).toBe(false);
    expect([...(f.dbs.get(CURRENT.historiesDb)?.get('meta') ?? [])]).toEqual([['a/b@main', { key: 'a/b@main', count: 2 }]]);
    expect(f.dbs.get(CURRENT.historiesDb)?.get('data')?.get('a/b@main')).toEqual([{ sha: '1' }, { sha: '2' }]);
    expect(f.dbs.get(CURRENT.cacheDb)?.get('commits')?.size).toBe(2);
  });

  it('does nothing (and creates nothing) when there is no old data', async () => {
    const f = fakeDb();
    expect(await migrateDatabases(f.backend)).toEqual({ [LEGACY.historiesDb]: 'none', [LEGACY.cacheDb]: 'none' });
    expect(f.dbs.size).toBe(0);
    expect(f.calls.some((c) => c.startsWith('write') || c.startsWith('remove'))).toBe(false);
  });

  it('keeps records already in the new database and is idempotent', async () => {
    const f = fakeDb({ [LEGACY.historiesDb]: histories, [CURRENT.historiesDb]: { meta: [['a/b@main', { key: 'a/b@main', count: 99 }]], data: [] } });
    await migrateDatabases(f.backend);
    expect(f.dbs.get(CURRENT.historiesDb)?.get('meta')?.get('a/b@main')).toEqual({ key: 'a/b@main', count: 99 });
    const again = await migrateDatabases(f.backend);
    expect(again[LEGACY.historiesDb]).toBe('none');
  });

  it('keeps the old database when the copy fails', async () => {
    const f = fakeDb({ [LEGACY.historiesDb]: histories }, { failWrite: true });
    const r = await migrateDatabases(f.backend);
    expect(r[LEGACY.historiesDb]).toBe('error');
    expect(f.dbs.has(LEGACY.historiesDb)).toBe(true);
  });

  it('is safe without IndexedDB', async () => {
    expect(await migrateDatabases(undefined)).toEqual({});
    const rep = await migrateLegacyData({ local: () => fakeStorage({ [LEGACY.tokenKey]: 't' }) });
    expect(rep.token).toBe('migrated');
    expect(rep.databases).toEqual({});
  });

  it('a backend that throws does not reject the migration', async () => {
    const broken: DbBackend = { read: () => Promise.reject(new Error('boom')), writeMissing: () => Promise.reject(new Error('x')), remove: () => Promise.reject(new Error('x')) };
    const r = await migrateDatabases(broken);
    expect(Object.values(r)).toEqual(['error', 'error']);
  });
});
