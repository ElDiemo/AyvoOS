"""The print agent against a FAKE AYVO OS agent API and a FAKE printer device (a file) — no Raspberry
Pi, no Zebra. Covers: printing exactly the job's bytes, a missing printer, a refused start, a
download that does not match the job, restarts (claimed → failed before send; writing → uncertain,
never written twice), redirects refused, and the token never logged."""

import hashlib
import json
import logging
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ayvo_print_agent.agent import Agent, Api, Config, Journal, find_printer

TOKEN = "ayvo_pa_" + "A" * 43
ZPL = b"^XA^FO20,20^FDSIMULATED^FS^XZ\n"


class FakeServer:
    """The agent API of AYVO OS with one queued job (or none)."""

    def __init__(self):
        self.jobs: list[dict] = []
        self.heartbeats: list[dict] = []
        self.results: list[tuple[str, str]] = []
        self.starts: list[str] = []
        self.start_status = 200
        self.data_bytes = ZPL
        self.redirect_claim = False
        self.tokens_seen: set[str] = set()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # quiet
                pass

            def _send(self, status, body=None, ctype="application/json"):
                raw = body if isinstance(body, bytes) else json.dumps(body or {}).encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                server.tokens_seen.add(self.headers.get("X-Ayvo-Print-Agent", ""))
                if self.path.endswith("/data"):
                    # The claim token only in its header — never in the URL.
                    if not self.headers.get("X-Ayvo-Claim") or "?" in self.path:
                        return self._send(404, {"code": "JOB_NOT_FOUND"})
                    return self._send(200, server.data_bytes, "application/zpl")
                self._send(404, {"code": "NOT_FOUND"})

            def do_POST(self):
                server.tokens_seen.add(self.headers.get("X-Ayvo-Print-Agent", ""))
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path.endswith("/heartbeat"):
                    server.heartbeats.append(body)
                    return self._send(200, {"agent": {"code": "RPI", "site": "S"}, "printers": [
                        {"id": str(uuid.uuid4()), "code": "ZD", "usbSerial": "SER1", "enabled": True}]})
                if self.path.endswith("/jobs/claim"):
                    if server.redirect_claim:
                        self.send_response(302)
                        self.send_header("Location", "http://evil.example/steal")
                        self.end_headers()
                        return
                    return self._send(200, {"job": server.jobs.pop(0) if server.jobs else None})
                if self.path.endswith("/start"):
                    server.starts.append(self.path)
                    if server.start_status != 200:
                        return self._send(server.start_status, {"code": "JOB_NOT_STARTABLE"})
                    return self._send(200, {"id": "x", "status": "SENDING"})
                if self.path.endswith("/result"):
                    job_id = self.path.split("/")[-2]
                    server.results.append((job_id, body["outcome"]))
                    return self._send(200, {"id": job_id, "status": body["outcome"]})
                self._send(404, {"code": "NOT_FOUND"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/api"

    def job(self, data: bytes = ZPL, serial: str = "SER1") -> dict:
        j = {
            "id": str(uuid.uuid4()),
            "code": "PRJ-000001",
            "printerId": str(uuid.uuid4()),
            "usbSerial": serial,
            "claimToken": "c" * 32,
            "leaseUntil": "2026-10-20T00:00:00.000Z",
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        self.jobs.append(j)
        return j


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.server = FakeServer()
        # A fake sysfs: /sys/class/usbmisc/lp0/device/serial = SER1, device = a plain file.
        lp = self.tmp / "sys" / "lp0" / "device"
        lp.mkdir(parents=True)
        (lp / "serial").write_text("SER1\n")
        self.dev = self.tmp / "dev"
        self.dev.mkdir()
        (self.dev / "lp0").write_bytes(b"")
        self.config = Config(
            api_base=self.server.base,
            token=TOKEN,
            journal_dir=self.tmp / "journal",
            sysfs_usbmisc=self.tmp / "sys",
            dev_dir=self.dev,
            poll_seconds=0,
            heartbeat_seconds=0,
            write_timeout_seconds=5,
        )

    def tearDown(self):
        self.server.httpd.shutdown()
        self.server.httpd.server_close()

    def agent(self) -> Agent:
        return Agent(self.config)

    def printed(self) -> bytes:
        return (self.dev / "lp0").read_bytes()

    def test_heartbeat_reports_the_detected_usb_printers(self):
        (self.tmp / "sys" / "lp0" / "device" / "product").write_text("ZTC ZD220-203dpi ZPL\n")
        bad = self.tmp / "sys" / "lp1" / "device"
        bad.mkdir(parents=True)
        (bad / "serial").write_text("not a serial!\n")  # never reported
        self.agent().heartbeat(force=True)
        self.assertEqual(
            self.server.heartbeats[-1]["devices"],
            [{"usbSerial": "SER1", "product": "ZTC ZD220-203dpi ZPL", "manufacturer": None}],
        )

    def test_prints_exactly_the_jobs_bytes_and_reports_sent(self):
        job = self.server.job()
        self.assertTrue(self.agent().once())
        self.assertEqual(self.printed(), ZPL)
        self.assertEqual(self.server.results, [(job["id"], "SENT")])
        self.assertEqual(self.server.tokens_seen, {TOKEN})
        self.assertFalse(self.agent().once())  # nothing more, nothing printed twice
        self.assertEqual(self.printed(), ZPL)

    def test_finds_the_printer_by_its_usb_serial_only(self):
        self.assertEqual(find_printer(self.tmp / "sys", self.dev, "SER1"), self.dev / "lp0")
        self.assertIsNone(find_printer(self.tmp / "sys", self.dev, "OTHER"))

    def test_missing_printer_fails_before_sending_without_starting(self):
        job = self.server.job(serial="OTHER")
        self.agent().once()
        self.assertEqual(self.server.starts, [])
        self.assertEqual(self.server.results, [(job["id"], "FAILED_BEFORE_SEND")])
        self.assertEqual(self.printed(), b"")

    def test_refused_start_never_prints(self):
        self.server.job()
        self.server.start_status = 409
        self.agent().once()
        self.assertEqual(self.printed(), b"")
        self.assertEqual(self.server.results, [])

    def test_an_unclear_start_error_writes_nothing_and_says_so(self):
        job = self.server.job()
        self.server.start_status = 502
        self.agent().once()
        self.assertEqual(self.printed(), b"")
        self.assertEqual(self.server.results, [(job["id"], "FAILED_BEFORE_SEND")])

    def test_bytes_that_do_not_match_the_job_are_not_printed(self):
        job = self.server.job()
        self.server.data_bytes = b"^XA^FDsomething else^FS^XZ\n"
        self.agent().once()
        self.assertEqual(self.printed(), b"")
        self.assertEqual(self.server.starts, [])
        self.assertEqual(self.server.results, [(job["id"], "FAILED_BEFORE_SEND")])

    def test_restart_after_claim_reports_failed_before_send(self):
        job_id = str(uuid.uuid4())
        Journal(self.config.journal_dir).write(job_id, {"id": job_id, "claim": "c" * 32, "state": "claimed"})
        self.agent().recover()
        self.assertEqual(self.server.results, [(job_id, "FAILED_BEFORE_SEND")])
        self.assertEqual(self.printed(), b"")

    def test_restart_during_writing_reports_uncertain_and_never_rewrites(self):
        job_id = str(uuid.uuid4())
        Journal(self.config.journal_dir).write(job_id, {"id": job_id, "claim": "c" * 32, "state": "writing"})
        agent = self.agent()
        agent.recover()
        agent.recover()  # reported once only
        self.assertEqual(self.server.results, [(job_id, "UNCERTAIN")])
        self.assertEqual(self.printed(), b"")

    def test_a_redirect_is_never_followed(self):
        self.server.redirect_claim = True
        with self.assertRaises(Exception):
            Api(self.config).claim()

    def test_the_token_never_appears_in_the_log(self):
        self.server.job(serial="OTHER")
        with self.assertLogs("ayvo-print-agent", level=logging.DEBUG) as logs:
            logging.getLogger("ayvo-print-agent").info("round")
            self.agent().once()
        self.assertNotIn(TOKEN, "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
