#!/usr/bin/env python3
"""TradingView Desktop restart switch.

A tiny, single-action, localhost-only, token-gated helper that restarts the
TradingView Desktop app and waits for its CDP endpoint to come back.
Stdlib only. NOT a general-purpose control: the only subprocess call in this
file is to the captured TradingView binary with its captured argv.

Security shape:
  - Binds only to a loopback address (refuses non-loopback hosts).
  - Exactly one action: restart TradingView (POST /restart, token-gated).
  - Token: secrets.token_hex(32), persisted 0o600 in a 0o700 directory.
  - Constant-time token compare (hmac.compare_digest).
  - No shell execution, no os.system, no os.popen, no eval/exec.

OS assumption: POSIX (Linux/macOS) for signal-based terminate (SIGTERM then
SIGKILL of the process group); Windows falls back to taskkill /F /T.

Usage:
  python3 scripts/tv-restart-switch.py                 # run the server
  python3 scripts/tv-restart-switch.py --once          # single restart, exit 0/1
"""

import argparse
import hmac
import http.server
import json
import logging
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

IS_WINDOWS = sys.platform.startswith("win")

# --- token ---------------------------------------------------------------


def _ensure_token_file(path: Path) -> str:
    """Create the token file (0o600 in a 0o700 dir) if absent; return token."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        token = path.read_text().strip()
        if token:
            return token
    token = secrets.token_hex(32)
    # Create with 0o600 from the start (avoids a world-readable window).
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(token + "\n")
    os.chmod(str(path), 0o600)
    return token


def _load_token(path: Path) -> str:
    if not path.exists():
        return _ensure_token_file(path)
    return path.read_text().strip()


def _token_ok(presented: str, expected: str) -> bool:
    if not presented or not expected:
        return False
    return hmac.compare_digest(presented.encode(), expected.encode())


def _extract_token(headers, query_params) -> str:
    auth = headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    try:
        for v in query_params.get("token", []):
            if v:
                return v
    except AttributeError:
        pass
    return ""


# --- process discovery / restart ------------------------------------------


def _detect_tradingview() -> list:
    """Scan the process table for TradingView. Returns argv (list of str) or [].

    POSIX: `ps -eo pid,args`. Matching: first argv token's basename
    (case-insensitive) contains "tradingview". Low pid = main process
    (lowest pid wins, which is what we keep).
    """
    if IS_WINDOWS:
        return []
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid,args"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    best = None  # (pid, argv)
    for line in out.splitlines()[1:]:
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid, args = int(parts[0]), parts[1]
        tokens = args.split()
        if not tokens:
            continue
        base = os.path.basename(tokens[0]).lower()
        if "tradingview" not in base:
            continue
        if best is None or pid < best[0]:
            best = (pid, tokens)
    if best is None:
        return []
    return best[1]


def _find_pids(binary: str) -> list:
    """PIDs of processes whose executable basename matches `binary`."""
    if IS_WINDOWS:
        try:
            out = subprocess.run(
                ["tasklist", "/NH"], capture_output=True, text=True,
                timeout=10, check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        name = os.path.basename(binary).lower()
        return [
            int(p[0]) for p in (
                l.split() for l in out.splitlines()
            ) if p and p[0].isdigit()
            and p[1].strip('"').lower() == name
        ]
    try:
        out = subprocess.run(
            ["pgrep", "-f", os.path.basename(binary)],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(x) for x in out.split() if x.strip().isdigit()]


def _terminate_pids(pids: list, grace_s: float = 8.0) -> bool:
    """SIGTERM process groups, wait up to grace_s, then SIGKILL survivors.

    Returns True when no matching pid is alive afterwards.
    """
    if not pids:
        return True
    import signal
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/T", "/PID", *map(str, pids)],
            capture_output=True, check=False, timeout=15,
        )
        time.sleep(min(grace_s, 2.0))
        if _still_alive(pids):
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", *map(str, pids)],
                capture_output=True, check=False, timeout=15,
            )
        return not _still_alive(pids)
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
    deadline = time.monotonic() + grace_s
    while _still_alive(pids) and time.monotonic() < deadline:
        time.sleep(0.2)
    if _still_alive(pids):
        for pid in pids:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        time.sleep(0.5)
    return not _still_alive(pids)


def _still_alive(pids: list) -> bool:
    import signal
    for pid in pids:
        try:
            os.kill(pid, 0)
            return True
        except (ProcessLookupError, OSError):
            continue
    return False


def _relaunch(argv: list) -> subprocess.Popen:
    if IS_WINDOWS:
        creationflags = 0x00000208  # CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
        return subprocess.Popen(argv, creationflags=creationflags)
    return subprocess.Popen(argv, start_newsession=True)


def _cdp_ready(host: str, port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://{host}:{port}/json/version"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, socket.timeout, OSError):
            pass
        time.sleep(1.0)
    return False


class RestartAction:
    """The single action: stop TradingView, relaunch it, wait for CDP.

    `terminate`, `relaunch`, `cdp_poll` are injectable for tests.
    """

    def __init__(self, launch_path: Path, cdp_host: str, cdp_port: int,
                 cdp_timeout: float = 45.0, grace_s: float = 8.0,
                 log: logging.Logger = None, log_path: Path = None):
        self.launch_path = launch_path
        self.cdp_host = cdp_host
        self.cdp_port = cdp_port
        self.cdp_timeout = cdp_timeout
        self.grace_s = grace_s
        self.log = log or logging.getLogger("tv-restart-switch")
        self.log_path = log_path
        self.terminate = None  # override: fn(pids)->bool
        self.relaunch = None   # override: fn(argv)->Popen
        self.cdp_poll = None   # override: fn()->bool

    def _record(self, line: str):
        # Every /restart attempt is recorded in the switch log file (if set)
        # and always on the stderr log stream.
        if self.log_path is not None:
            try:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                with self.log_path.open("a") as fh:
                    fh.write(line.rstrip("\n") + "\n")
            except OSError:
                pass
        self.log.info(line)

    def _load_launch(self) -> list:
        p = self.launch_path
        if p.exists():
            data = json.loads(p.read_text())
            if data.get("argv"):
                return list(data["argv"])
        return []

    def _save_launch(self, argv: list) -> None:
        self.launch_path.parent.mkdir(parents=True, exist_ok=True)
        self.launch_path.write_text(
            json.dumps({"argv": argv, "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                       indent=2) + "\n")

    def run(self) -> dict:
        t0 = time.monotonic()
        argv = self._load_launch()
        if not argv:
            argv = _detect_tradingview()
            if not argv:
                detail = ("no running TradingView found and no captured launch "
                          "command in launch.json; run TradingView once with "
                          "--remote-debugging-port or pin --detect")
                self._record(time.strftime("%Y-%m-%dT%H:%M:%SZ") + " result=failed detail=no-launch-command")
                return {"status": "failed", "detail": detail}
            self._save_launch(argv)
        binary = argv[0]

        # 1. stop
        pids = _find_pids(binary)
        term = self.terminate or (lambda p: _terminate_pids(p, self.grace_s))
        stopped = term(pids)
        self._record(time.strftime("%Y-%m-%dT%H:%M:%SZ") + f" step=terminate pids={pids} stopped={stopped}")

        # 2. relaunch (detached)
        launch = self.relaunch or _relaunch
        launch(argv)
        self._record(time.strftime("%Y-%m-%dT%H:%M:%SZ") + " step=relaunch argv0=" + binary)

        # 3. wait for CDP
        poll = self.cdp_poll or (lambda: _cdp_ready(self.cdp_host, self.cdp_port, self.cdp_timeout))
        up = poll()
        elapsed = round(time.monotonic() - t0, 2)
        if up:
            self._record(time.strftime("%Y-%m-%dT%H:%M:%SZ") + f" result=up elapsed_s={elapsed}")
            return {"status": "up", "cdp": f"{self.cdp_host}:{self.cdp_port}", "elapsed_s": elapsed}
        self._record(time.strftime("%Y-%m-%dT%H:%M:%SZ") + f" result=failed elapsed_s={elapsed}")
        return {"status": "failed",
                "detail": f"CDP endpoint {self.cdp_host}:{self.cdp_port} not ready after {self.cdp_timeout:.0f}s"}


# --- HTTP server ----------------------------------------------------------


def _make_handler(action: RestartAction, token: str):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "tv-restart-switch/1.0"

        def log_message(self, fmt, *args):  # quiet: we log /restart ourselves
            pass

        def _json(self, code: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._json(200, {"status": "ok"})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            from urllib.parse import parse_qs
            query = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            path = self.path.split("?", 1)[0]
            if path != "/restart":
                self._json(404, {"error": "not found"})
                return
            presented = _extract_token(self.headers, query)
            if not _token_ok(presented, token):
                self._json(401, {"error": "unauthorized"})
                return
            # Drain the request body if any (small).
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(min(length, 4096))
            result = action.run()
            code = 200 if result.get("status") == "up" else 500
            self._json(code, result)

    return Handler


def _validate_host(host: str) -> None:
    """Raise ValueError unless `host` resolves to loopback addresses only."""
    try:
        infos = socket.getaddrinfo(host, None, 0, socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError(f"cannot resolve host {host!r}: {exc}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise ValueError(f"cannot resolve host {host!r}")
    for addr in addresses:
        loopback = addr.startswith("127.") or addr in ("::1", "0:0:0:0:0:0:0:1")
        if not loopback:
            raise ValueError(
                f"refusing non-loopback host {host!r} (resolves to {addr}): this "
                "switch must bind to 127.0.0.1 (or ::1) only")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="TradingView restart switch (localhost-only, single action)")
    p.add_argument("--host", default="127.0.0.1", help="bind host (loopback only; default 127.0.0.1)")
    p.add_argument("--port", type=int, default=9223, help="switch HTTP port (default 9223)")
    p.add_argument("--token-file", default=".tv-restart-switch/token",
                   help="path to the persisted token (default .tv-restart-switch/token)")
    p.add_argument("--log-file", default=None,
                   help="restart log file (default: <token-file dir>/restart.log; "
                        ".tv-restart-switch/restart.log with defaults)")
    p.add_argument("--launch-file", default=".tv-restart-switch/launch.json",
                   help="path to the captured launch command (default .tv-restart-switch/launch.json)")
    p.add_argument("--cdp-host", default="127.0.0.1", help="CDP host to poll (default 127.0.0.1)")
    p.add_argument("--cdp-port", type=int, default=9222, help="CDP port to poll (default 9222)")
    p.add_argument("--cdp-timeout", type=float, default=45.0, help="seconds to wait for CDP (default 45)")
    p.add_argument("--grace", type=float, default=8.0, help="SIGTERM grace seconds before SIGKILL (default 8)")
    p.add_argument("--once", action="store_true",
                   help="run a single restart and exit (0=up, 1=failed)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    _validate_host(args.host)
    log = logging.getLogger("tv-restart-switch")
    log.setLevel(logging.INFO)
    if not log.handlers:
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(h)

    token_path = Path(args.token_file)
    token = _load_token(token_path)
    log_file = Path(args.log_file) if args.log_file else token_path.parent / "restart.log"
    action = RestartAction(
        launch_path=Path(args.launch_file),
        cdp_host=args.cdp_host, cdp_port=args.cdp_port,
        cdp_timeout=args.cdp_timeout, grace_s=args.grace, log=log,
        log_path=log_file,
    )

    if args.once:
        result = action.run()
        print(json.dumps(result))
        return 0 if result.get("status") == "up" else 1

    handler = _make_handler(action, token)
    server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    log.info("tv-restart-switch listening on http://%s:%d (token: %s)", args.host, args.port, token_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
