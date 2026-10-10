// SPDX-License-Identifier: AGPL-3.0-only
import { bridge } from '../web/bridge';

/**
 * Drag-and-drop anywhere on the page: a dropped git log (or CommitEvent JSON) file goes to the engine like a chosen one.
 * Installed by the page entry (src/entry.ts), so it works on the landing card and in the viewer, before the engine has loaded.
 * Only drags that carry files are touched (dragging text or links around the page keeps the browser's behaviour).
 */
export function installDropzone(): void {
  let depth = 0;
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const clear = (): void => {
    depth = 0;
    document.documentElement.classList.remove('gm-dropping');
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    document.documentElement.classList.add('gm-dropping');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) clear();
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    clear();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    bridge.landing?.hide();
    void bridge.whenApp().then((app) => app.loadFile(f));
  });
}
