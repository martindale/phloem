// SPDX-License-Identifier: AGPL-3.0-only
// Post-build guard (npm run build): the production bundle must not ship the e2e test hook or the retired placeholder.
// Usage: node scripts/check-dist.mjs [dir]   (default dist; dist-e2e is expected to contain the hook, so it is not checked)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const FORBIDDEN = ['__phloem', 'REPLACE-WITH-PUBLIC-SOURCE-URL'];
const bad = [];

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css|json|webmanifest|txt)$/.test(name) && !name.endsWith('.map')) {
      const text = readFileSync(p, 'utf8');
      for (const f of FORBIDDEN) if (text.includes(f)) bad.push(`${p}: contains "${f}"`);
    }
  }
}

walk(dir);
if (bad.length) {
  console.error(`check-dist: ${dir} must not contain test hooks or placeholders:\n  ${bad.join('\n  ')}`);
  console.error('The window.__phloem hook is only built with `vite build --mode e2e` (npm run build:e2e) or VITE_EXPOSE_TEST_HOOKS=1.');
  process.exit(1);
}
console.log(`check-dist: ${dir} has no test hook and no placeholder URL.`);
