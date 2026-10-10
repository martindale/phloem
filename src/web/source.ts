// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the corresponding source code is offered (AGPL-3.0 section 13: users of a hosted, modified version must be able to get it).
 * Defaults to the public repository; a fork that hosts a modified version sets `VITE_SOURCE_URL` at build time to its own source URL.
 * See docs/WEB.md and docs/DEPLOY.md.
 */
export const DEFAULT_SOURCE_URL = 'https://github.com/thcp/phloem';
export const SOURCE_URL: string = (import.meta.env.VITE_SOURCE_URL as string | undefined)?.trim() || DEFAULT_SOURCE_URL;
export const SOURCE_LABEL = 'Source code (AGPL-3.0)';

/** An anchor to the source, safe against odd URLs (set through the DOM, not a template). */
export function sourceLink(className: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = className;
  a.textContent = SOURCE_LABEL;
  a.href = SOURCE_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
