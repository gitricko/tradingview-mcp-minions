#!/usr/bin/env python3
"""tv-watchdog.py — host-side watchdog for TradingView Desktop (CDP).

A plain stdlib loop that polls the CDP endpoint and starts (or restarts)
TradingView whenever it is down. It knows how to launch the app because the
command is configured once (--command) or captured from a first live sighting,
so it heals both the "hung instance" and the "fully down" cases without any
HTTP API, token, or shell.

Security boundary (hard):
  * no HTTP server, no inbound sockets, no token, no shell;
  * the ONLY outbound network call is the CDP health check
    (GET http://<cdp-host>:<cdp-port>/json/version);
  * the ONLY subprocess calls are process discovery (ps/tasklist), the
    terminate signal (os.kill / taskkill), and the relaunch of the
    configured --command; never shell=True / os.system / os.popen / eval.

OS assumption: POSIX (macOS/Linux) is the primary target. Windows has a
best-effort path (taskkill / tasklist, DETACHED_PROCESS), untested.

Usage:
  python3 scripts/tv-watchdog.py                 # loop forever (default)
  python3 scripts/tv-watchdog.py --once          # check + heal once, exit 0/1
  python3 scripts/tv-watchdog.py --once --force  # --once, bypass cooldown
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import signal
import shlex
import subprocess
import sys
import time

DEFAULT_COMMAND = (
    "/Applications/TradingView.app/Contents/MacOS/TradingView "
    "--remote-debugging-port=9222"
)
TV_NAME = "tradingview"
HEALTH_PATH = "/json/version"
DEFAULT_HEALTH_TIMEOUT = 4.0
DEFAULT_TERMINATE_GRACE = 8.0

_log = logging.getLogger("tv-watchdog")


# --------------------------------------------------------------------------
# CDP health check
# --------------------------------------------------------------------------

def _cdp_http_get(host: str, port: int, path: str, timeout: float):
    """Return (status, body_bytes) for GET http://host:port/path (stdlib only)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def health_check(host: str, port: int, timeout: float = DEFAULT_HEALTH_TIMEOUT,
                 transport=_cdp_http_get):
    """Probe the CDP endpoint. Returns (up: bool, detail: str).

    'up'   = a 2xx HTTP response whose JSON body contains a 'Browser' key.
    'down' = connection error, timeout, non-2xx, invalid JSON, or missing key.
    """
    try:
        status, body = transport(host, port, HEALTH_PATH, timeout)
    except Exception as exc:  # ConnectionRefused, timeout, ...
        return False, "%s: %s" % (type(exc).__name__, exc)
    if not (200 <= status < 300):
        return False, "non-2xx status %s" % status
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return False, "invalid JSON body"
    if not isinstance(data, dict) or "Browser" not in data:
        return False, "missing Browser key"
    return True, "up (%s)" % data.get("Browser")


# --------------------------------------------------------------------------
# Process discovery / terminate
# --------------------------------------------------------------------------

def find_tv_processes():
    """Return PIDs of running TradingView processes (argv[0] basename match)."""
    if os.name == "nt":
        return _find_tv_processes_windows()
    proc = subprocess.run(["ps", "-eo", "pid=args"],
                          capture_output=True, text=True, check=False)
    pids = []
    for line in proc.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        pid_s, args = parts
        argv = args.split()
        if argv and TV_NAME in os.path.basename(argv[0]).lower():
            pids.append(int(pid_s))
    return pids


def _find_tv_processes_windows():
    proc = subprocess.run(["tasklist", "/FO", "CSV", "/NH"],
                          capture_output=True, text=True, check=False)
    pids = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith('"'):
            fields = line[1:-1].split('","')
        else:
            fields = [f.strip() for f in line.split(",")]
        if len(fields) >= 2 and fields[1].isdigit():
            if TV_NAME in fields[0].lower():
                pids.append(int(fields[1]))
    return pids


def _pid_alive_posix(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_pid(pid: int, grace: float = DEFAULT_TERMINATE_GRACE) -> None:
    """Graceful terminate (SIGTERM, wait ~grace s, SIGKILL if needed).

    Windows: taskkill (no shell). Documented OS assumption: POSIX first.
    """
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid)],
                       capture_output=True, check=False)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid,
                                 "/FO", "CSV", "/NH"],
                                capture_output=True, text=True, check=False)
            if "No tasks" in (out.stdout or ""):
                return
            time.sleep(0.2)
        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                       capture_output=True, check=False)
        return
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and _pid_alive_posix(pid):
        time.sleep(0.2)
    if _pid_alive_posix(pid):
        os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and _pid_alive_posix(pid):
            time.sleep(0.1)


# --------------------------------------------------------------------------
# Relaunch (the only launch path; detached, no shell)
# --------------------------------------------------------------------------

def _relaunch(argv):
    """Relaunch argv detached. Returns the subprocess.Popen.

    POSIX: start_new_session=True (the exact PR #11 regression if misspelled).
    Windows: CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS.
    """
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                  stderr=subprocess.DEVNULL, close_fds=True)
    if os.name == "nt":
        kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP
                                   | subprocess.DETACHED_PROCESS)
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(argv, **kwargs)


# --------------------------------------------------------------------------
# State (last-action timestamp for cooldown, captured launch args)
# --------------------------------------------------------------------------

def _load_state(state_dir: str):
    last = None
    try:
        with open(os.path.join(state_dir, "last-action")) as f:
            text = f.read().strip()
            if text:
                last = float(text)
    except (OSError, ValueError):
        last = None
    return {"last_action_at": last}


def _record_action(state_dir: str, state: dict) -> None:
    ts = time.time()
    state["last_action_at"] = ts
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(os.path.join(state_dir, "last-action"), "w") as f:
            f.write(repr(ts))
    except OSError as exc:
        _log.warning("could not persist last-action timestamp: %s", exc)


def resolve_argv(args, state_dir: str):
    """Return (argv, explicit_command)."""
    if args.command:
        return shlex.split(args.command), True
    launch_file = os.path.join(state_dir, "launch-args")
    try:
        with open(launch_file) as f:
            data = json.load(f)
        argv = data.get("argv")
        if argv and isinstance(argv, list) and all(isinstance(x, str) for x in argv):
            return argv, False
    except (OSError, ValueError, AttributeError):
        pass
    return shlex.split(DEFAULT_COMMAND), False


def capture_launch_args(state_dir: str, explicit_command: bool) -> None:
    """Best-effort: record the argv of a running TradingView (first sighting)
    so a later from-down start can reuse the exact command. Skipped when the
    user gave an explicit --command (that one always wins)."""
    if explicit_command:
        return
    try:
        pids = find_tv_processes()
        if not pids:
            return
        proc = subprocess.run(["ps", "-o", "args=", "-p", str(pids[0])],
                             capture_output=True, text=True, check=False)
        argv = shlex.split((proc.stdout or "").strip().splitlines()[0])
        if not argv:
            return
        os.makedirs(state_dir, exist_ok=True)
        with open(os.path.join(state_dir, "launch-args"), "w") as f:
            json.dump({"argv": argv, "captured_at": time.time()}, f)
        _log.info("captured launch argv from pid %s", pids[0])
    except Exception as exc:  # best-effort only
        _log.debug("capture_launch_args failed: %s", exc)


# --------------------------------------------------------------------------
# Heal
# --------------------------------------------------------------------------

def heal(cfg: dict, state: dict) -> str:
    """Check-and-heal. Returns 'healed' | 'failed' | 'skipped'."""
    now = time.time()
    last = state.get("last_action_at")
    if not state.get("force") and last is not None and now - last < cfg["cooldown"]:
        _log.info("heal skipped (cooldown: %.0fs ago, limit %.0fs)",
                  now - last, cfg["cooldown"])
        return "skipped"

    pids = find_tv_processes()
    action = "start"
    if pids:
        action = "restart"
        _log.info("heal restart: terminating hung instance(s) pid=%s", pids)
        for pid in pids:
            try:
                terminate_pid(pid)
            except Exception as exc:
                _log.warning("heal: terminate %s failed: %s", pid, exc)
    else:
        _log.info("heal start: no TradingView process; launching from down")

    _log.info("heal %s: relaunching %r", action, cfg["argv"])
    try:
        proc = _relaunch(cfg["argv"])
    except Exception as exc:
        _log.error("heal %s result=failed relaunch error: %s", action, exc)
        _record_action(cfg["state_dir"], state)
        return "failed"

    t0 = time.monotonic()
    deadline = t0 + cfg["startup_timeout"]
    last_err = "startup timeout"
    while True:
        up, detail = health_check(cfg["cdp_host"], cfg["cdp_port"])
        if up:
            _log.info("heal %s result=success pid=%s cdp up after %.1fs",
                      action, proc.pid, time.monotonic() - t0)
            _record_action(cfg["state_dir"], state)
            return "healed"
        last_err = detail
        if time.monotonic() >= deadline:
            break
        time.sleep(cfg["poll_interval"])

    _log.error("heal %s result=failed cdp not up within %.0fs (last: %s)",
               action, cfg["startup_timeout"], last_err)
    _record_action(cfg["state_dir"], state)
    return "failed"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Host-side watchdog: poll CDP, start/restart TradingView when down.")
    p.add_argument("--command", default=None,
                   help="launch command (default: %s)" % DEFAULT_COMMAND)
    p.add_argument("--cdp-host", default="127.0.0.1")
    p.add_argument("--cdp-port", type=int, default=9222)
    p.add_argument("--interval", type=float, default=30.0,
                   help="poll interval in seconds (loop mode)")
    p.add_argument("--cooldown", type=float, default=300.0,
                   help="minimum seconds between two start/restart actions")
    p.add_argument("--startup-timeout", type=float, default=60.0,
                   help="seconds to wait for CDP after a relaunch")
    p.add_argument("--heal-poll", type=float, default=1.0,
                   help="advanced: seconds between CDP checks during startup wait")
    p.add_argument("--log-file", default=os.path.join(".tv-watchdog", "watchdog.log"))
    p.add_argument("--once", action="store_true",
                   help="one check-and-heal, then exit 0 (up) / 1 (still down)")
    p.add_argument("--force", action="store_true",
                   help="--once only: bypass the cooldown window")
    return p.parse_args(argv)


def setup_logging(log_file: str) -> None:
    logger = logging.getLogger("tv-watchdog")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for h in list(logger.handlers):
        logger.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass
    fmt = logging.Formatter("%(asctime)s %(message)s")
    parent = os.path.dirname(os.path.abspath(log_file))
    if parent:
        os.makedirs(parent, exist_ok=True)
    fh = logging.FileHandler(log_file, mode="a")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    logger.addHandler(sh)


def main(argv=None) -> int:
    args = parse_args(argv)
    state_dir = os.path.dirname(os.path.abspath(args.log_file))
    setup_logging(args.log_file)
    argv, explicit = resolve_argv(args, state_dir)
    state = _load_state(state_dir)
    state["force"] = bool(args.force)
    cfg = {
        "argv": argv,
        "cdp_host": args.cdp_host,
        "cdp_port": args.cdp_port,
        "cooldown": args.cooldown,
        "startup_timeout": args.startup_timeout,
        "poll_interval": args.heal_poll,
        "state_dir": state_dir,
    }
    _log.info("watchdog config: argv=%r cdp=%s:%s interval=%ss cooldown=%ss",
              argv, args.cdp_host, args.cdp_port, args.interval, args.cooldown)

    if args.once:
        up, detail = health_check(args.cdp_host, args.cdp_port)
        _log.info("poll %s (%s)", "up" if up else "down", detail)
        if up:
            return 0
        outcome = heal(cfg, state)
        if outcome == "healed":
            _log.info("--once result: up (healed)")
            return 0
        _log.info("--once result: down (heal %s)", outcome)
        return 1

    _log.info("watchdog started (interval=%ss, press Ctrl-C to stop)", args.interval)
    try:
        while True:
            up, detail = health_check(args.cdp_host, args.cdp_port)
            _log.info("poll %s (%s)", "up" if up else "down", detail)
            if up:
                capture_launch_args(state_dir, explicit)
            else:
                heal(cfg, state)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        _log.info("watchdog stopped (KeyboardInterrupt)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
