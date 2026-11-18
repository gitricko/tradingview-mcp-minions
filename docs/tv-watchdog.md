# TradingView Watchdog

A host-side supervisor for TradingView Desktop (CDP). One stdlib-only Python
file: `scripts/tv-watchdog.py`. It polls the CDP endpoint and starts or
restarts TradingView whenever it's down — on its own, with no HTTP call, no
token, and no shell.

This **supersedes the PR #11 HTTP "restart switch"**. That API version had two
design-level bugs: it could not start TradingView from a fully-down state
(it had no launch command to work from), and it crashed on relaunch
(a misspelled `start_newsession` Popen keyword). The watchdog fixes both at
the root: the launch command is configured once (`--command`, or captured
from a first live sighting), and the relaunch path is covered by a regression
test.

## What it does

Every poll (default 30 s):

1. **Health check** — `GET http://127.0.0.1:9222/json/version` (~4 s timeout).
   "up" = a 2xx response whose JSON body contains a `Browser` key. "down" =
   refused, timeout, non-2xx, bad JSON, or missing key.
2. **If down — heal** (subject to cooldown):
   - A TradingView process is running (hung): terminate it gracefully
     (SIGTERM, ~8 s grace, SIGKILL if needed), then relaunch.
   - Nothing running: relaunch directly (the from-down start path PR #11 lacked).
   - Relaunch runs the configured command **detached** (`start_new_session=True`
     on POSIX, `DETACHED_PROCESS` on Windows).
   - Then poll CDP up to `--startup-timeout` (default 60 s) until it reports
     up; log the outcome and elapsed time.
3. **If up** — do nothing.

## How to run

```sh
# Loop forever (run it under launchd/systemd/keepalive)
python3 scripts/tv-watchdog.py

# One check-and-heal, then exit — the manual trigger / test mode.
# Exits 0 if CDP is up (or was brought up), 1 if it's still down.
python3 scripts/tv-watchdog.py --once

# Bypass the cooldown window for that single run
python3 scripts/tv-watchdog.py --once --force
```

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--command` | `/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222` | Launch command. If given, used verbatim (whitespace-split). If omitted and TradingView is seen running once, its exact argv is captured to the state dir and reused for from-down starts. |
| `--cdp-host` / `--cdp-port` | `127.0.0.1` / `9222` | CDP endpoint to health-check. |
| `--interval` | `30` | Poll period in seconds (loop mode). |
| `--cooldown` | `300` | Minimum seconds between two start/restart actions — a misbehaving config cannot turn the host into a restart loop; a heal inside the window is logged as "skipped (cooldown)" and does not relaunch. |
| `--startup-timeout` | `60` | Seconds to wait for CDP to come up after a relaunch. |
| `--log-file` | `.tv-watchdog/watchdog.log` | Append-only timestamped log of every poll outcome and every action (start/restart, success, failure, cooldown-skip). |
| `--once` | off | One check-and-heal, then exit 0/1. |
| `--force` | off | `--once` only: bypass the cooldown for this run. |

## Security boundary

- **No HTTP server, no inbound sockets, no token, no API.**
- The **only outbound network call** is the CDP health check to
  `--cdp-host:--cdp-port`.
- The **only subprocess calls** are process discovery (`ps`/`tasklist`), the
  terminate signal, and the relaunch of the configured `--command`.
  Never `shell=True`, `os.system`, `os.popen`, or `eval`/`exec`.

## OS assumption

POSIX (macOS/Linux) is the primary, tested target. Windows has a best-effort
path (`taskkill`/`tasklist`, `DETACHED_PROCESS`) that is untested.

## Tests

```sh
python3 -m unittest tests.tv_watchdog
```

Covers the health-check states, heal-from-down, heal-hung (terminate-then-
relaunch ordering), cooldown skip/allow, `--once` exit codes, and the PR #11
regression (the real `_relaunch` with `start_new_session`, which fails with
`TypeError` if the `start_newsession` typo returns). No test touches a real
TradingView process.
