#!/usr/bin/env python3
"""Headless launch test for the Linux build.

Everything else in CI proves Remuda *compiles* and *packages* on Linux. This
proves it runs, and it does so without a display, a GPU or a real Ollama.

The assertion is deliberately not "the process stayed alive". A Tauri app can
sit there with a blank window for many reasons — WebKitGTK failing to
initialise, the bundled JS never executing — and still not exit. Instead this
stands a stub Ollama on 127.0.0.1:11434 and waits for the app to *ask it for
/api/version*, which the frontend's health poll does on a timer.

Receiving that request proves the whole chain end to end:

  * the GTK window was created
  * WebKitGTK initialised and loaded the bundled frontend
  * the JavaScript bundle executed
  * React mounted and the poll in api/client.ts ran

Nothing short of a working app produces that request.

Usage:  scripts/smoke-linux.py /usr/bin/remuda
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 11434
# Generous: a cold start on a loaded runner has to bring up GTK and WebKitGTK
# before any JavaScript runs at all.
LAUNCH_TIMEOUT_S = 60

seen_paths: list[str] = []
seen_lock = threading.Lock()


class StubOllama(BaseHTTPRequestHandler):
    """The smallest server that lets the app reach its connected state."""

    routes = {
        "/api/version": {"version": "0.0.0-smoke"},
        "/api/tags": {"models": []},
        "/api/ps": {"models": []},
    }

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        with seen_lock:
            seen_paths.append(self.path)
        body = self.routes.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        """Silence per-request logging; this script prints its own summary."""


def wait_for_version_probe(process: subprocess.Popen, deadline: float) -> bool:
    """True once the app asks for /api/version, False if it dies or times out."""
    while time.monotonic() < deadline:
        with seen_lock:
            if any(p.startswith("/api/version") for p in seen_paths):
                return True
        if process.poll() is not None:
            return False
        time.sleep(0.25)
    return False


def attempt(binary: str, extra_env: dict[str, str], label: str) -> bool:
    print(f"\n=== attempt: {label} ===", flush=True)
    env = {**os.environ, **extra_env}
    # xvfb-run supplies the display. start_new_session so the whole group can
    # be killed — xvfb-run spawns the app as a child, and killing only the
    # wrapper would leave the app running.
    process = subprocess.Popen(
        [
            "xvfb-run",
            "-a",
            "--server-args=-screen 0 1280x800x24",
            binary,
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        ok = wait_for_version_probe(process, time.monotonic() + LAUNCH_TIMEOUT_S)
    finally:
        if process.poll() is None:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)

    output = (process.stdout.read() if process.stdout else "") or "(no output)"
    if ok:
        print(f"reached /api/version under: {label}", flush=True)
    else:
        print(f"no /api/version request within {LAUNCH_TIMEOUT_S}s", flush=True)
        print(f"exit code: {process.returncode}", flush=True)
        print("--- app output ---", flush=True)
        print(output.strip()[:4000], flush=True)
    return ok


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} PATH_TO_BINARY", file=sys.stderr)
        return 2
    binary = sys.argv[1]
    if not os.path.exists(binary):
        print(f"no such binary: {binary}", file=sys.stderr)
        return 2

    server = HTTPServer(("127.0.0.1", PORT), StubOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"stub Ollama listening on 127.0.0.1:{PORT}", flush=True)

    try:
        # First pass with nothing special set. If the app needs a WebKitGTK
        # workaround to render, that is worth knowing rather than papering
        # over: a user in a VM or on an unusual GPU would hit the same thing.
        if attempt(binary, {}, "no workarounds"):
            print("\nSMOKE PASS — launched with no WebKitGTK workarounds")
            return 0

        # Retry with the DMABUF renderer disabled, the standard workaround for
        # WebKitGTK on virtualised or GPU-less machines.
        if attempt(binary, {"WEBKIT_DISABLE_DMABUF_RENDERER": "1"}, "WEBKIT_DISABLE_DMABUF_RENDERER=1"):
            print(
                "\nSMOKE PASS — but only with WEBKIT_DISABLE_DMABUF_RENDERER=1.\n"
                "The app does not render on a plain virtual display without it, "
                "which means users in VMs and on some GPU setups will see the "
                "same failure. Worth fixing in the app rather than only here."
            )
            return 0
    finally:
        server.shutdown()
        with seen_lock:
            print(f"\nrequests the stub saw: {seen_paths or '(none)'}", flush=True)

    print("\nSMOKE FAIL — the app never reached its Ollama health poll")
    return 1


if __name__ == "__main__":
    sys.exit(main())
