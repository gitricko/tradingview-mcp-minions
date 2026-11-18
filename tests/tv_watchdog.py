#!/usr/bin/env python3
"""Stdlib unittest suite for scripts/tv-watchdog.py.

Run:  python3 -m unittest tests.tv_watchdog

All HTTP, process-discovery, and relaunch side effects are mocked; the suite
never starts or kills a real TradingView.
"""
import importlib.util
import itertools
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
if os.path.join("scripts") not in [p.replace(os.sep, "/") for p in sys.path]:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

# Load scripts/tv-watchdog.py (dashed file name) under module name tv_watchdog.
_SPEC = importlib.util.spec_from_file_location(
    "tv_watchdog", os.path.join(os.path.dirname(__file__), "..", "scripts", "tv-watchdog.py"))
w = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(w)
w._log.setLevel(logging.INFO)


class _LogCap(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())

    def text(self):
        return "\n".join(self.records)


def _inc(base=0.0, step=0.1):
    """Deterministic monotonically-increasing stand-in for time.monotonic."""
    it = itertools.count()
    def _now():
        return base + step * next(it)
    return _now


def _mkcfg(tmpdir, **over):
    cfg = {
        "argv": ["/bin/true"],
        "cdp_host": "127.0.0.1",
        "cdp_port": 1,
        "cooldown": 300.0,
        "startup_timeout": 2.0,
        "poll_interval": 0.05,
        "state_dir": tmpdir,
    }
    cfg.update(over)
    return cfg


def _fakepopen(pid=1):
    popen = subprocess.Popen.__new__(subprocess.Popen)
    popen.pid = pid
    return popen


class HealthCheckTests(unittest.TestCase):
    def setUp(self):
        self.cap = _LogCap()
        w._log.addHandler(self.cap)

    def tearDown(self):
        w._log.removeHandler(self.cap)

    def test_up_on_200_with_browser_key(self):
        t = lambda h, p, path, to: (200, b'{"Browser": "TradingView/1.0"}')
        up, detail = w.health_check("127.0.0.1", 9222, transport=t)
        self.assertTrue(up)
        self.assertIn("TradingView", detail)

    def test_down_on_connection_error(self):
        def t(h, p, path, to):
            raise ConnectionRefusedError("refused")
        up, _ = w.health_check("127.0.0.1", 9222, transport=t)
        self.assertFalse(up)

    def test_down_on_non_2xx(self):
        t = lambda h, p, path, to: (502, b"bad gateway")
        up, _ = w.health_check("127.0.0.1", 9222, transport=t)
        self.assertFalse(up)

    def test_down_on_missing_browser_key(self):
        t = lambda h, p, path, to: (200, b'{"nope": 1}')
        up, _ = w.health_check("127.0.0.1", 9222, transport=t)
        self.assertFalse(up)

    def test_down_on_invalid_json(self):
        t = lambda h, p, path, to: (200, b"<html>")
        up, _ = w.health_check("127.0.0.1", 9222, transport=t)
        self.assertFalse(up)


class HealTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cap = _LogCap()
        w._log.addHandler(self.cap)
        self.state = {"last_action_at": None, "force": False}

    def tearDown(self):
        w._log.removeHandler(self.cap)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_heal_from_down_relaunches_and_succeeds(self):
        cfg = _mkcfg(self.tmp)
        polls = iter([(False, "refused"), (False, "refused"), (True, "up")])
        calls = {"relaunch": 0}

        def fake_relaunch(argv):
            calls["relaunch"] += 1
            self.assertEqual(argv, cfg["argv"])
            return _fakepopen(4242)

        with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
             unittest.mock.patch.object(w, "_relaunch", side_effect=fake_relaunch), \
             unittest.mock.patch.object(w, "health_check",
                                        side_effect=lambda h, p: next(polls)), \
             unittest.mock.patch.object(w, "time") as tmock:
            tmock.monotonic.side_effect = _inc()
            tmock.time.return_value = 1000.0
            tmock.sleep = lambda _s: None
            outcome = w.heal(cfg, self.state)
        self.assertEqual(outcome, "healed")
        self.assertEqual(calls["relaunch"], 1)
        self.assertTrue(any("result=success" in m for m in self.cap.records))
        self.assertTrue(any("heal start" in m for m in self.cap.records))

    def test_heal_hung_instance_terminates_then_relaunches(self):
        cfg = _mkcfg(self.tmp)
        order = []
        polls = iter([(False, "refused"), (True, "up")])

        def fake_terminate(pid):
            order.append("terminate:%d" % pid)

        def fake_relaunch(argv):
            order.append("relaunch")
            return _fakepopen(55)

        def fake_health(host, port):
            order.append("poll")
            return next(polls)

        with unittest.mock.patch.object(w, "find_tv_processes", return_value=[777]), \
             unittest.mock.patch.object(w, "terminate_pid", side_effect=fake_terminate), \
             unittest.mock.patch.object(w, "_relaunch", side_effect=fake_relaunch), \
             unittest.mock.patch.object(w, "health_check", side_effect=fake_health), \
             unittest.mock.patch.object(w, "time") as tmock:
            tmock.monotonic.side_effect = _inc()
            tmock.time.return_value = 1000.0
            tmock.sleep = lambda _s: None
            outcome = w.heal(cfg, self.state)
        self.assertEqual(outcome, "healed")
        self.assertEqual(order, ["terminate:777", "relaunch", "poll", "poll"])

    def test_heal_from_down_relaunch_fails(self):
        cfg = _mkcfg(self.tmp)
        with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
             unittest.mock.patch.object(w, "_relaunch",
                                        side_effect=OSError("spawn failed")), \
             unittest.mock.patch.object(w, "time") as tmock:
            tmock.time.return_value = 1000.0
            outcome = w.heal(cfg, self.state)
        self.assertEqual(outcome, "failed")
        self.assertTrue(any("result=failed" in m for m in self.cap.records))
        self.assertEqual(self.state["last_action_at"], 1000.0)

    def test_cooldown_skips_then_allows(self):
        cfg = _mkcfg(self.tmp)
        with unittest.mock.patch.object(w, "time") as tmock:
            tmock.time.return_value = 1000.0
            tmock.monotonic.side_effect = _inc()
            tmock.sleep = lambda _s: None

            with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
                 unittest.mock.patch.object(w, "_relaunch") as r1, \
                 unittest.mock.patch.object(w, "health_check",
                                            return_value=(True, "up")):
                r1.return_value = _fakepopen(1)
                first = w.heal(cfg, self.state)
            self.assertEqual(first, "healed")
            self.assertEqual(r1.call_count, 1)

            tmock.time.return_value = 1050.0  # 50s later, inside cooldown
            with unittest.mock.patch.object(w, "_relaunch") as r2:
                second = w.heal(cfg, self.state)
            self.assertEqual(second, "skipped")
            self.assertEqual(r2.call_count, 0)
            self.assertTrue(any("cooldown" in m for m in self.cap.records))

            tmock.time.return_value = 1400.0  # 400s after first, outside cooldown
            with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
                 unittest.mock.patch.object(w, "_relaunch") as r3, \
                 unittest.mock.patch.object(w, "health_check",
                                            return_value=(True, "up")):
                r3.return_value = _fakepopen(1)
                third = w.heal(cfg, self.state)
            self.assertEqual(third, "healed")
            self.assertEqual(r3.call_count, 1)

    def test_force_bypasses_cooldown(self):
        cfg = _mkcfg(self.tmp)
        self.state["last_action_at"] = 999.0
        self.state["force"] = True
        with unittest.mock.patch.object(w, "time") as tmock:
            tmock.time.return_value = 1000.0
            tmock.monotonic.side_effect = _inc()
            tmock.sleep = lambda _s: None
            with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
                 unittest.mock.patch.object(w, "_relaunch",
                                            return_value=_fakepopen(1)) as r, \
                 unittest.mock.patch.object(w, "health_check",
                                            return_value=(True, "up")):
                outcome = w.heal(cfg, self.state)
        self.assertEqual(outcome, "healed")
        self.assertEqual(r.call_count, 1)


class OnceModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cap = _LogCap()
        w._log.addHandler(self.cap)

    def tearDown(self):
        w._log.removeHandler(self.cap)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _logpath(self):
        return os.path.join(self.tmp, "log", "watchdog.log")

    def test_once_up_exits_zero(self):
        with unittest.mock.patch.object(w, "health_check",
                                        return_value=(True, "up")):
            rc = w.main(["--once", "--log-file", self._logpath()])
        self.assertEqual(rc, 0)

    def test_once_down_healed_exits_zero(self):
        polls = iter([(False, "refused"), (True, "up")])
        with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
             unittest.mock.patch.object(w, "_relaunch",
                                        return_value=_fakepopen(1)), \
             unittest.mock.patch.object(w, "health_check",
                                        side_effect=lambda h, p: next(polls)):
            rc = w.main(["--once", "--log-file", self._logpath()])
        self.assertEqual(rc, 0)

    def test_once_down_heal_fails_exits_one(self):
        with unittest.mock.patch.object(w, "find_tv_processes", return_value=[]), \
             unittest.mock.patch.object(w, "_relaunch",
                                        side_effect=OSError("spawn failed")), \
             unittest.mock.patch.object(w, "health_check",
                                        return_value=(False, "refused")):
            rc = w.main(["--once", "--log-file", self._logpath()])
        self.assertEqual(rc, 1)


class RelaunchRegressionTests(unittest.TestCase):
    def test_real_relaunch_uses_start_new_session_keyword(self):
        """PR #11 regression: the relaunch crashed with
        `subprocess.Popen() got unexpected keyword argument 'start_newsession'`.
        Exercise the REAL _relaunch with a trivial argv.
        """
        if not os.path.exists("/bin/true"):
            self.skipTest("/bin/true not present on this platform")
        proc = w._relaunch(["/bin/true"])
        self.assertIsInstance(proc, subprocess.Popen)
        self.assertEqual(proc.wait(), 0)

    def test_relaunch_kwargs_reject_typo(self):
        # Guard the guard: the misspelled keyword must NOT be accepted by Popen.
        with self.assertRaises(TypeError):
            subprocess.Popen(["/bin/true"], start_newsession=True)


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        a = w.parse_args([])
        self.assertEqual(a.cdp_host, "127.0.0.1")
        self.assertEqual(a.cdp_port, 9222)
        self.assertEqual(a.interval, 30.0)
        self.assertEqual(a.cooldown, 300.0)
        self.assertEqual(a.startup_timeout, 60.0)
        self.assertFalse(a.once)
        self.assertFalse(a.force)
        self.assertIn(".tv-watchdog", a.log_file)

    def test_command_flag_split_verbatim(self):
        a = w.parse_args(["--command", "/opt/tv --remote-debugging-port=9223"])
        argv, explicit = w.resolve_argv(a, tempfile.mkdtemp())
        self.assertEqual(argv, ["/opt/tv", "--remote-debugging-port=9223"])
        self.assertTrue(explicit)

    def test_default_command_is_captains_mac(self):
        a = w.parse_args([])
        argv, explicit = w.resolve_argv(a, tempfile.mkdtemp())
        self.assertFalse(explicit)
        self.assertEqual(argv, [
            "/Applications/TradingView.app/Contents/MacOS/TradingView",
            "--remote-debugging-port=9222",
        ])

    def test_captured_launch_argv_used_when_no_command_flag(self):
        tmp = tempfile.mkdtemp()
        try:
            with open(os.path.join(tmp, "launch-args"), "w") as f:
                json.dump({"argv": ["/usr/bin/TradingView", "-x"]}, f)
            a = w.parse_args([])
            argv, explicit = w.resolve_argv(a, tmp)
            self.assertFalse(explicit)
            self.assertEqual(argv, ["/usr/bin/TradingView", "-x"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
