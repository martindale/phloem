// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The optional GitHub token.
 *
 * - Typing a token keeps it in MEMORY only (gone when the tab closes).
 * - "Save on this device" is an explicit opt-in that also writes it to localStorage; "Remove saved token" erases it.
 * - It is only ever sent as an `Authorization` header to https://api.github.com (src/ingest/github.ts builds every request URL
 *   from a fixed base). It is never put in a URL, a cookie or a log line, and there is no other server involved.
 */
export const TOKEN_KEY = 'phloem.ghtoken.saved'; // data saved under the former name is moved here once by src/web/migrate.ts

let memory: string | undefined;
const listeners = new Set<() => void>();

function read(storage: () => Storage, key: string): string | undefined {
  try {
    return storage().getItem(key) || undefined;
  } catch {
    return undefined; // storage blocked
  }
}

/** The token to use for requests: what was typed this session, else the saved one. */
export function getToken(): string | undefined {
  return memory ?? read(() => localStorage, TOKEN_KEY);
}

export function setMemoryToken(token: string | undefined): void {
  memory = token?.trim() || undefined;
  emit();
}

export function savedToken(): string | undefined {
  return read(() => localStorage, TOKEN_KEY);
}

/** Persist on this device (the user pressed Save). Returns false when storage is blocked. */
export function saveToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  try {
    localStorage.setItem(TOKEN_KEY, t);
    memory = t;
    emit();
    return true;
  } catch {
    return false;
  }
}

/** Forget the token everywhere: memory and localStorage. */
export function clearToken(): void {
  memory = undefined;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

export function onTokenChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const l of listeners) l();
}
