#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Run a Playwright check (default tests/e2e/visual_check.py; SCRIPT=... to pick another) against a fresh DEV server on PORT (default 5173,
# set PORT=... when your own dev server is running). The dev server exposes the window.__phloem test hook, as `npm run build:e2e` does.
# Needs the Python venv described in tests/e2e/README.md.
# WSL note: Chromium needs NSS libs; if not installed system-wide we use a local copy.
set -euo pipefail
cd "$(dirname "$0")/.."
LOCAL_LIBS="$PWD/.venv/syslibs/usr/lib/x86_64-linux-gnu"
[ -d "$LOCAL_LIBS" ] && export LD_LIBRARY_PATH="$LOCAL_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
PORT=${PORT:-5173}
exec .venv/bin/python scripts/with-server.py \
  --server "npx vite --port $PORT --strictPort" --port "$PORT" -- \
  .venv/bin/python "${SCRIPT:-tests/e2e/visual_check.py}" "http://localhost:$PORT/" screenshots "$@"
