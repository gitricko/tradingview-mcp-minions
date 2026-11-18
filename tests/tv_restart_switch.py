"""Unit tests for scripts/tv-restart-switch.py (stdlib unittest only).

Run with:  python3 -m unittest tests.tv_restart_switch

No real TradingView process is ever killed or launched: the terminate,
relaunch and CDP-poll steps are injected mocks.
"""

import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "tv-restart-switch.py"


def load_module():
    spec = importlib.util.spec_from_file_location("tv_restart_switch", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


m = load_module()


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token_path = Path(self.tmp.name) / "state" / "token"

    def test_token_created_with_secure_perms(self):
        token = m._load_token(self.token_path)
        self.assertEqual(len(token), 64)
        self.assertTrue(self.token_path.exists())
        mode = stat.S_IMODE(self.token_path.stat().st_mode)
        self.assertEqual(mode, 0o600)
        dir_mode = stat.S_IMODE(self.token_path.parent.stat().st_mode)
        self.assertEqual(dir_mode, 0o700)

    def test_token_persisted_and_reused(self):
        first = m._load_token(self.token_path)
        second = m._load_token(self.token_path)
        self.assertEqual(first, second)

    def test_token_compare_constants(self):
        self.assertTrue(m._token_ok("abc", "abc"))
        self.assertFalse(m._token_ok("abc", "abd"))
        self.assertFalse(m._token_ok("", ""))
        self.assertFalse(m._token_ok("abc", ""))

    def test_extract_token_from_header_and_query(self):
        from urllib.parse import parse_qs
        self.assertEqual(m._extract_token({"Authorization": "Bearer tok"}, {}), "tok")
        self.assertEqual(m._extract_token({}, parse_qs("token=tok")), "tok")
        self.assertEqual(m._extract_token({}, {}), "")


class HostTests(unittest.TestCase):
    def test_loopback_accepted(self):
        m._validate_host("127.0.0.1")
        m._validate_host("localhost")

    def test_non_loopback_rejected(self):
        for host in ("0.0.0.0", "10.0.0.1", "192.168.1.5"):
            with self.assertRaises(ValueError):
                m._validate_host(host)


class SecuritySourceTests(unittest.TestCase):
    def setUp(self):
        self.src = MODULE_PATH.read_text()

    def test_no_shell_true(self):
        self.assertNotIn("shell=True", self.src)

    def test_no_system_popen_eval_exec(self):
        for pat in (r"os\.system\s*\(", r"os\.popen\s*\(", r"\beval\s*\(", r"\bexec\s*\("):
            self.assertIsNone(re.search(pat, self.src), f"forbidden pattern {pat}")

    def test_only_subprocess_use_is_captured_binary(self):
        # Every subprocess call site must be one of the known helpers; the
        # module must never build a command from request data.
        calls = re.findall(r"subprocess\.(?:run|Popen|call|check_output)\(([^)]*)\)", self.src)
        self.assertTrue(calls)
        for arg in calls:
            self.assertNotIn("self.path", arg)

    def test_binds_loopback_by_default(self):
        self.assertIn('default="127.0.0.1"', self.src)


class RestartSequenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.launch_path = Path(self.tmp.name) / "launch.json"
        self.launch_path.write_text(json.dumps({"argv": ["/fake/TradingView", "--remote-debugging-port=9222"]}))
        self.action = m.RestartAction(
            launch_path=self.launch_path,
            cdp_host="127.0.0.1", cdp_port=9222,
            cdp_timeout=1.0, grace_s=0.1,
            log_path=Path(self.tmp.name) / "restart.log",
        )
        self.calls = []

    def _install_mocks(self, cdp_up=True):
        self.action.terminate = lambda pids: self.calls.append(("terminate", list(pids))) or True
        self.action.relaunch = lambda argv: self.calls.append(("relaunch", list(argv)))
        self.action.cdp_poll = lambda: self.calls.append(("poll", None)) or cdp_up

    def test_success_ordering_and_shape(self):
        self._install_mocks(cdp_up=True)
        result = self.action.run()
        steps = [c[0] for c in self.calls]
        self.assertEqual(steps, ["terminate", "relaunch", "poll"])
        self.assertEqual(result["status"], "up")
        self.assertEqual(result["cdp"], "127.0.0.1:9222")
        self.assertIsInstance(result["elapsed_s"], float)
        self.assertIn("result=up", (self.launch_path.parent / "restart.log").read_text())

    def test_timeout_shape(self):
        self._install_mocks(cdp_up=False)
        result = self.action.run()
        self.assertEqual([c[0] for c in self.calls], ["terminate", "relaunch", "poll"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("not ready", result["detail"])
        self.assertIn("result=failed", (self.launch_path.parent / "restart.log").read_text())

    def test_no_launch_command_fails_cleanly(self):
        self.launch_path.unlink()
        self.action._detect = None
        original = m._detect_tradingview
        m._detect_tradingview = lambda: []
        self.addCleanup(setattr, m, "_detect_tradingview", original)
        result = self.action.run()
        self.assertEqual(result["status"], "failed")
        self.assertIn("no running TradingView", result["detail"])
        self.assertEqual(self.calls, [])

    def test_launch_command_captured_on_first_run(self):
        self.launch_path.unlink()
        original = m._detect_tradingview
        m._detect_tradingview = lambda: ["/fake/TradingView", "--remote-debugging-port=9222"]
        self.addCleanup(setattr, m, "_detect_tradingview", original)
        self._install_mocks(cdp_up=True)
        self.action.run()
        saved = json.loads(self.launch_path.read_text())
        self.assertEqual(saved["argv"][0], "/fake/TradingView")
        self.assertEqual(self.calls[1], ("relaunch", ["/fake/TradingView", "--remote-debugging-port=9222"]))


class HttpRoutingTests(unittest.TestCase):
    """Boot the real stdlib HTTP server on an ephemeral loopback port."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token = "a" * 64
        self.started = []
        self.launch_path = Path(self.tmp.name) / "launch.json"
        self.launch_path.write_text(
            json.dumps({"argv": ["/fake/TradingView", "--remote-debugging-port=9222"]}))
        action = m.RestartAction(
            launch_path=self.launch_path,
            cdp_host="127.0.0.1", cdp_port=9222,
            log_path=Path(self.tmp.name) / "restart.log",
        )
        action.terminate = lambda pids: self.started.append("terminate") or True
        action.relaunch = lambda argv: self.started.append("relaunch")
        action.cdp_poll = lambda: self.started.append("poll") or True
        self.action = action
        self.server = m.http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), m._make_handler(action, self.token))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _req(self, path, method="GET", token=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(url, method=method)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_health_needs_no_token(self):
        status, body = self._req("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok"})

    def test_restart_without_token_401(self):
        status, _ = self._req("/restart", method="POST")
        self.assertEqual(status, 401)
        self.assertEqual(self.started, [])

    def test_restart_wrong_token_401(self):
        status, _ = self._req("/restart", method="POST", token="b" * 64)
        self.assertEqual(status, 401)
        self.assertEqual(self.started, [])

    def test_restart_correct_token_runs_action(self):
        status, body = self._req("/restart", method="POST", token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "up")
        self.assertEqual(self.started, ["terminate", "relaunch", "poll"])

    def test_query_param_token_accepted(self):
        status, body = self._req(f"/restart?token={self.token}", method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "up")

    def test_unknown_paths_404(self):
        for path in ("/", "/stop", "/restart/now"):
            status, _ = self._req(path)
            self.assertEqual(status, 404, path)
        status, _ = self._req("/unknown", method="POST", token=self.token)
        self.assertEqual(status, 404)

    def test_health_rejects_post(self):
        # Only GET /health exists; POST falls into the 404 branch.
        status, _ = self._req("/health", method="POST", token=self.token)
        self.assertEqual(status, 404)


class OnceModeTests(unittest.TestCase):
    def test_once_exits_zero_when_up(self):
        # --once against a captured no-op target: patch discovery + the
        # action's CDP poll so nothing real is touched.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        launch = Path(tmp.name) / "launch.json"
        launch.write_text(json.dumps({"argv": ["/fake/TradingView"]}))
        argv = ["--once", "--launch-file", str(launch),
                "--token-file", str(Path(tmp.name) / "token"),
                "--log-file", str(Path(tmp.name) / "restart.log")]
        orig = (m._find_pids, m._relaunch, m._cdp_ready)
        m._find_pids = lambda binary: []
        m._relaunch = lambda a: None
        m._cdp_ready = lambda host, port, timeout: True
        self.addCleanup(lambda: setattr(m, "_cdp_ready", orig[2]))
        self.addCleanup(lambda: setattr(m, "_relaunch", orig[1]))
        self.addCleanup(lambda: setattr(m, "_find_pids", orig[0]))
        rc = m.main(argv)
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
