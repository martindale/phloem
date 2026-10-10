// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Page entry. Paints the landing card from a tiny critical path (this file, the landing, theme.css and one font), then loads the
 * engine (src/main.ts: renderer, workers, viewer chrome) behind it, so the first screen never waits for WebGL or the demo history.
 * Deep links (?repo=, ?demo, ...) skip the landing and load the engine right away.
 */
import './ui/theme.css';
import { installDropzone } from './ui/dropzone';
import { Landing } from './ui/landing/landing';
import { bridge } from './web/bridge';
import { startMigration } from './web/migrate';
import { parseViewerParams, wantsLanding } from './web/urlstate';

// Move data saved under the former name ("gitmold") to the Phloem names before anything reads the token or opens a database.
void startMigration();

const params = parseViewerParams(location.search);
const showLanding = wantsLanding(location.search);

const landing = new Landing(document.body, {
  repo: params.badRepo ?? undefined,
  max: params.max,
  onVisualize: (req, max) => {
    void bridge.whenApp().then((app) => app.loadGithub(req, max));
  },
  onFile: (f) => void bridge.whenApp().then((app) => app.loadFile(f)),
});
bridge.landing = landing;
installDropzone();

let booted = false;
function bootEngine(): void {
  if (booted) return;
  booted = true;
  void import('./main');
}

if (showLanding) {
  landing.show({ badRepo: params.badRepo });
  // Start the engine once the page is idle, or at the first sign of interaction, whichever comes first.
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(bootEngine, { timeout: 1200 });
  else setTimeout(bootEngine, 400);
  for (const ev of ['pointerdown', 'keydown', 'focusin'] as const) window.addEventListener(ev, bootEngine, { once: true, passive: true });
} else bootEngine();
