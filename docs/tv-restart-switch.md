# TV restart switch

A tiny, single-action, localhost-only helper that restarts TradingView Desktop
and waits for its CDP endpoint to come back, so a worker can recover a dead
connection without OS access. Stdlib-only Python; not a general-purpose
control.

## Run

```bash
# server (default 127.0.0.1:9223)
python3 scripts/tv-restart-switch.py

# one-shot restart, exit 0 when CDP is back, 1 otherwise
python3 scripts/tv-restart-switch.py --once
```

Flags: `--port`, `--host` (loopback only), `--token-file`, `--log-file`,
`--launch-file`, `--cdp-host`, `--cdp-port`, `--cdp-timeout`, `--grace`, `--once`.

## Token and files

- Token: generated on first start (`secrets.token_hex(32)`) and persisted at
  `.tv-restart-switch/token` in the CWD, mode `0600` in a `0700` directory.
- Captured launch command: `.tv-restart-switch/launch.json` (auto-captured via
  `ps -eo pid,args` on first restart; restarts are then deterministic).
- Restart attempt log: `.tv-restart-switch/restart.log` (timestamp + outcome
  per `/restart`).

## Worker call

```bash
TOKEN=$(cat .tv-restart-switch/token)

# synchronous one-shot (preferred for a worker)
python3 scripts/tv-restart-switch.py --once

# or against a running server
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9223/restart
# {"status":"up","cdp":"127.0.0.1:9222","elapsed_s":12.3}
# {"status":"failed","detail":"..."} with HTTP 500 on CDP timeout

# liveness (no token, read-only)
curl -s http://127.0.0.1:9223/health   # {"status":"ok"}
```

## Security boundaries

- Binds loopback only; `--host` refuses any non-loopback value.
- Exactly one action: restart TradingView. No arbitrary command execution —
  the only subprocess call is the captured TradingView binary with its
  captured argv; no shell, `os.system`, `os.popen`, or `eval`/`exec`.
- Every `/restart` requires the token (Bearer header or `?token=`); anything
  else is `401`, compared in constant time (`hmac.compare_digest`).
- Every `/restart` attempt is logged with timestamp and outcome.

## OS assumption

POSIX (Linux/macOS): SIGTERM the TradingView process group, wait up to 8s,
then SIGKILL survivors, relaunch detached (`start_newsession=True`). Windows
falls back to `taskkill /T` then `taskkill /F /T`.

## Tests

```bash
python3 -m unittest tests.tv_restart_switch
```
