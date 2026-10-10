// SPDX-License-Identifier: AGPL-3.0-only
/** A readable full-page message for the cases the app cannot run at all (no WebGL 2, a crashed worker). */
export function showFatal(message: string): void {
  console.error(message);
  document.getElementById('gm-fatal')?.remove();
  const el = document.createElement('div');
  el.id = 'gm-fatal';
  el.setAttribute('role', 'alert');
  el.className = 'gm-fatal';
  const h = document.createElement('h2');
  h.textContent = 'Phloem cannot draw here';
  const p = document.createElement('p');
  p.textContent = message;
  const hint = document.createElement('p');
  hint.textContent = 'It needs a browser with WebGL 2 (current Chrome, Edge, Firefox or Safari 15+) and hardware acceleration switched on.';
  el.append(h, p, hint);
  document.body.append(el);
}
