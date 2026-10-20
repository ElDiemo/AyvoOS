"""The print agent (doc 030 §5, ADR 0028).

One loop: heartbeat (printers' state) → claim the next job of its printers → download the stored
ZPL (size and SHA-256 checked) → ask the server to START (refused for a job that became invalid,
e.g. its shipment is being cancelled) → write the bytes to the USB printer identified by its serial
number → report SENT / FAILED_BEFORE_SEND / UNCERTAIN.

A local journal (one JSON file per job, written with fsync) survives restarts: a job journaled as
claimed but never written is reported FAILED_BEFORE_SEND; one whose write had started is UNCERTAIN —
never written again by itself. Every URL is built from the configured API base and fixed paths;
redirects are refused; the token is never logged.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import VERSION

log = logging.getLogger("ayvo-print-agent")

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TOKEN = re.compile(r"^ayvo_pa_[A-Za-z0-9_-]{43}$")
MAX_BYTES = 5 * 1024 * 1024


@dataclass
class Config:
    api_base: str  # e.g. https://dev.ayvo.co/api
    token: str
    journal_dir: Path
    sysfs_usbmisc: Path = Path("/sys/class/usbmisc")
    dev_dir: Path = Path("/dev/usb")
    basic_auth: tuple[str, str] | None = None
    poll_seconds: float = 3.0
    heartbeat_seconds: float = 30.0
    write_timeout_seconds: float = 30.0
    http_timeout_seconds: float = 20.0

    @staticmethod
    def load(path: Path) -> "Config":
        """Reads the JSON configuration; secrets (token, Basic Auth password) from files of mode 600."""
        raw = json.loads(path.read_text("utf-8"))

        def secret(file: str) -> str:
            p = Path(file)
            mode = p.stat().st_mode & 0o777
            if mode & 0o077:
                raise SystemExit(f"{p} must not be readable by others (chmod 600)")
            return p.read_text("utf-8").strip()

        token = secret(raw["token_file"])
        if not TOKEN.match(token):
            raise SystemExit("token_file does not hold a print agent token")
        basic = None
        if raw.get("basic_auth_user") and raw.get("basic_auth_password_file"):
            basic = (raw["basic_auth_user"], secret(raw["basic_auth_password_file"]))
        base = raw["api_base"].rstrip("/")
        if not base.startswith("https://") and not raw.get("allow_http_for_tests"):
            raise SystemExit("api_base must be https://")
        return Config(
            api_base=base,
            token=token,
            journal_dir=Path(raw.get("journal_dir", "/var/lib/ayvo-print-agent")),
            basic_auth=basic,
            poll_seconds=float(raw.get("poll_seconds", 3)),
            heartbeat_seconds=float(raw.get("heartbeat_seconds", 30)),
        )


class ApiError(Exception):
    def __init__(self, status: int, code: str | None):
        super().__init__(f"HTTP {status} {code or ''}".strip())
        self.status = status
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        return None  # never follow a redirect anywhere


class Api:
    """The agent API of AYVO OS — fixed paths under the configured base only."""

    def __init__(self, config: Config, opener: Callable[..., Any] | None = None):
        self.config = config
        self.opener = opener or urllib.request.build_opener(_NoRedirect()).open

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, bytes]:
        url = f"{self.config.api_base}/agent/v1/{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Ayvo-Print-Agent", self.config.token)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.config.basic_auth:
            user, password = self.config.basic_auth
            req.add_header(
                "Authorization",
                "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode(),
            )
        try:
            with self.opener(req, timeout=self.config.http_timeout_seconds) as res:
                return res.status, res.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            raw = e.read(4096)
            e.close()
            code = None
            try:
                code = json.loads(raw).get("code")
            except Exception:  # noqa: BLE001 — a body without a code
                pass
            raise ApiError(e.code, code) from None

    def _json(self, method: str, path: str, body: dict | None = None) -> Any:
        status, raw = self._request(method, path, body)
        if status >= 300:
            raise ApiError(status, None)
        return json.loads(raw)

    def heartbeat(self, printers: list[dict]) -> dict:
        return self._json("POST", "heartbeat", {"version": VERSION, "printers": printers})

    def claim(self) -> dict | None:
        return self._json("POST", "jobs/claim", {}).get("job")

    def data(self, job_id: str, claim: str) -> bytes:
        _check_id(job_id)
        status, raw = self._request("GET", f"jobs/{job_id}/data?claim={urllib.request.quote(claim)}")
        if status != 200:
            raise ApiError(status, None)
        return raw

    def start(self, job_id: str, claim: str) -> None:
        _check_id(job_id)
        self._json("POST", f"jobs/{job_id}/start", {"claimToken": claim})

    def result(self, job_id: str, claim: str, outcome: str, detail: str | None) -> None:
        _check_id(job_id)
        self._json(
            "POST",
            f"jobs/{job_id}/result",
            {"claimToken": claim, "outcome": outcome, "detail": (detail or None) and detail[:500]},
        )


def _check_id(job_id: str) -> None:
    if not UUID.match(job_id):
        raise ValueError("unexpected job id")


def find_printer(sysfs: Path, dev_dir: Path, serial: str) -> Path | None:
    """The /dev/usb/lpN of the USB printer with this serial number (from sysfs), or None."""
    if not sysfs.is_dir():
        return None
    for lp in sorted(sysfs.glob("lp*")):
        # /sys/class/usbmisc/lpN/device → the USB interface; its parent holds "serial".
        for candidate in (lp / "device" / ".." / "serial", lp / "device" / "serial"):
            try:
                if candidate.read_text("ascii").strip() == serial:
                    return dev_dir / lp.name
            except OSError:
                continue
    return None


class Journal:
    """One file per job: claimed → writing → written → reported (fsync'd at every step)."""

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, job_id: str) -> Path:
        _check_id(job_id)
        return self.dir / f"{job_id}.json"

    def write(self, job_id: str, entry: dict) -> None:
        path = self._path(job_id)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entry, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def read(self, job_id: str) -> dict | None:
        try:
            return json.loads(self._path(job_id).read_text("utf-8"))
        except FileNotFoundError:
            return None

    def unreported(self) -> list[dict]:
        out = []
        for p in sorted(self.dir.glob("*.json")):
            try:
                entry = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if entry.get("state") != "reported":
                out.append(entry)
        return out

    def done(self, job_id: str) -> None:
        entry = self.read(job_id) or {"id": job_id}
        entry["state"] = "reported"
        self.write(job_id, entry)


class WriteTimeout(Exception):
    pass


def write_device(device: Path, data: bytes, timeout: float) -> None:
    """Writes all bytes to the device. Raises FileNotFoundError/PermissionError when it cannot be
    opened (nothing written), WriteTimeout or OSError once writing may have started."""
    fd = os.open(device, os.O_WRONLY | getattr(os, "O_NOCTTY", 0))
    error: list[BaseException] = []

    def work() -> None:
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
        except BaseException as e:  # noqa: BLE001 — reported to the caller
            error.append(e)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise WriteTimeout(f"write did not finish within {timeout:.0f} s")
    os.close(fd)
    if error:
        raise error[0]


class Agent:
    def __init__(self, config: Config, api: Api | None = None, journal: Journal | None = None):
        self.config = config
        self.api = api or Api(config)
        self.journal = journal or Journal(config.journal_dir)
        self.printers: list[dict] = []
        self._last_heartbeat = 0.0

    # --- recovery after a restart -------------------------------------------------------------

    def recover(self) -> None:
        """Reports what the journal knows about jobs from before a restart — never re-prints."""
        for entry in self.journal.unreported():
            job_id, claim, state = entry.get("id"), entry.get("claim"), entry.get("state")
            if not job_id or not claim:
                continue
            outcome, detail = {
                "claimed": ("FAILED_BEFORE_SEND", "Agent se restartoval před zápisem – nic neodesláno"),
                "refused": (None, None),
                "writing": ("UNCERTAIN", "Agent se restartoval během zápisu – štítek se mohl vytisknout"),
                "written": ("SENT", entry.get("detail")),
                "failed": ("FAILED_BEFORE_SEND", entry.get("detail")),
                "uncertain": ("UNCERTAIN", entry.get("detail")),
            }.get(state, (None, None))
            if outcome is None:
                self.journal.done(job_id)
                continue
            self._report(job_id, claim, outcome, detail)

    def _report(self, job_id: str, claim: str, outcome: str, detail: str | None) -> bool:
        try:
            self.api.result(job_id, claim, outcome, detail)
        except ApiError as e:
            if e.status in (404, 409):
                # The server no longer knows this claim (expired, cancelled): nothing more to say.
                log.warning("job %s: result %s not accepted (%s)", job_id, outcome, e)
                self.journal.done(job_id)
                return False
            log.warning("job %s: result %s not delivered yet (%s)", job_id, outcome, e)
            return False
        except OSError as e:
            log.warning("job %s: result %s not delivered yet (%s)", job_id, outcome, e)
            return False
        self.journal.done(job_id)
        return True

    # --- one round ---------------------------------------------------------------------------

    def heartbeat(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_heartbeat < self.config.heartbeat_seconds:
            return
        states = []
        for p in self.printers:
            dev = find_printer(self.config.sysfs_usbmisc, self.config.dev_dir, p["usbSerial"])
            states.append(
                {
                    "printerId": p["id"],
                    "state": "READY" if dev and os.access(dev, os.W_OK) else "NOT_FOUND",
                    "detail": None if dev else f"USB {p['usbSerial']} nenalezena",
                }
            )
        answer = self.api.heartbeat(states)
        self.printers = answer.get("printers", [])
        self._last_heartbeat = now

    def once(self) -> bool:
        """Takes and handles at most one job. Returns whether there was one."""
        self.recover()
        self.heartbeat()
        job = self.api.claim()
        if not job:
            return False
        job_id, claim = job["id"], job["claimToken"]
        self.journal.write(job_id, {"id": job_id, "claim": claim, "code": job["code"], "state": "claimed"})
        log.info("job %s (%s): claimed", job["code"], job_id)

        def fail(detail: str) -> bool:
            self.journal.write(job_id, {"id": job_id, "claim": claim, "state": "failed", "detail": detail})
            self._report(job_id, claim, "FAILED_BEFORE_SEND", detail)
            return True

        device = find_printer(self.config.sysfs_usbmisc, self.config.dev_dir, job["usbSerial"])
        if device is None:
            return fail(f"Tiskárna s USB {job['usbSerial']} nenalezena – nic neodesláno")
        try:
            data = self.api.data(job_id, claim)
        except (ApiError, OSError) as e:
            return fail(f"Štítek se nepodařilo stáhnout ({e}) – nic neodesláno")
        if len(data) != job["sizeBytes"] or hashlib.sha256(data).hexdigest() != job["sha256"]:
            return fail("Stažený štítek neodpovídá úloze (velikost/otisk) – nic neodesláno")
        if not data.lstrip().startswith(b"^XA"):
            return fail("Soubor není ZPL – nic neodesláno")
        try:
            self.api.start(job_id, claim)
        except ApiError as e:
            # Refused (e.g. the shipment is being cancelled): never printed.
            log.warning("job %s: start refused (%s) — not printed", job_id, e)
            self.journal.write(job_id, {"id": job_id, "claim": claim, "state": "refused"})
            self.journal.done(job_id)
            return True
        except OSError as e:
            # The start may or may not have reached the server: do not write.
            return fail(f"Spuštění úlohy nepotvrzeno ({e}) – nic neodesláno")
        self.journal.write(job_id, {"id": job_id, "claim": claim, "state": "writing"})
        try:
            write_device(device, data, self.config.write_timeout_seconds)
        except (FileNotFoundError, PermissionError, IsADirectoryError) as e:
            # The device could not be opened: nothing was written.
            return fail(f"Tiskárnu nelze otevřít ({e.__class__.__name__}) – nic neodesláno")
        except (WriteTimeout, OSError) as e:
            detail = f"Zápis do tiskárny nedokončen ({e}) – štítek se mohl vytisknout"
            self.journal.write(job_id, {"id": job_id, "claim": claim, "state": "uncertain", "detail": detail})
            self._report(job_id, claim, "UNCERTAIN", detail)
            if isinstance(e, WriteTimeout):
                raise  # the blocked writer cannot be stopped: the service restarts
            return True
        detail = f"Odesláno do tiskárny {device.name} ({len(data)} B)"
        self.journal.write(job_id, {"id": job_id, "claim": claim, "state": "written", "detail": detail})
        self._report(job_id, claim, "SENT", detail)
        log.info("job %s: sent to %s", job["code"], device)
        return True

    def run_forever(self) -> None:
        self.recover()
        while True:
            try:
                busy = self.once()
            except WriteTimeout:
                log.error("a write to the printer hangs — exiting for a restart")
                os._exit(3)
            except (ApiError, OSError, ValueError) as e:
                log.warning("round failed: %s", e)
                busy = False
            if not busy:
                time.sleep(self.config.poll_seconds)
