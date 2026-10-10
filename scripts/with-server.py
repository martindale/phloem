#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Start a server, wait until its port accepts connections, run a command, then stop the server.

  python scripts/with-server.py --server "npx vite --port 5173 --strictPort" --port 5173 -- python tests/e2e/visual_check.py http://localhost:5173/
"""
import argparse
import socket
import subprocess
import sys
import time


def ready(port: int, timeout: float) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help="command that starts the server")
    ap.add_argument("--port", required=True, type=int)
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
    if not cmd:
        print("no command given", file=sys.stderr)
        return 2
    server = subprocess.Popen(a.server, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if not ready(a.port, a.timeout):
            print(f"server did not open port {a.port} within {a.timeout:.0f}s", file=sys.stderr)
            return 1
        return subprocess.run(cmd).returncode
    finally:
        import os, signal
        try:
            os.killpg(server.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)


if __name__ == "__main__":
    sys.exit(main())
