#!/usr/bin/env python3
"""Managed VCClient v2 runtime supervisor.

Historically the operator launched VCClient (w-okada 2.x) by hand and Shape Meet
merely spoke to it over HTTP. This module turns VCClient into a **supervised
child process** owned by the persistent model endpoint server (the in-process AI
runtime): the app starts it, waits for it to become healthy, restarts it if it
dies, and tears it down cleanly on shutdown.

Activation is opt-in via ``VCCLIENT000_MANAGED=1``. When it is not set every
existing behaviour is preserved (the voice engine talks to whatever external
endpoint ``VCCLIENT000_HTTP_ENDPOINT`` points at).

Environment configuration
-------------------------
``VCCLIENT000_MANAGED``            ``1``/``true`` activates managed mode.
``VCCLIENT000_DIST_DIR``          directory containing the ``main``/``main.exe``
                                  binary (its ``model_dir``/``settings`` state
                                  lives beside it; the process is launched with
                                  this as its cwd — VCClient uses relative dirs).
``VCCLIENT000_BIN``               override the binary name (default ``main`` on
                                  POSIX, ``main.exe`` on Windows).
``VCCLIENT000_HOST``              bind host for VCClient (default ``127.0.0.1``).
``VCCLIENT000_PORT``              bind port (default ``18000``).
``VCCLIENT000_BOOT_TIMEOUT_SECS`` seconds to wait for ``/api/hello`` before the
                                  boot is considered stalled and relaunched
                                  (default ``90``; hot boot is 36-43 s, a cold
                                  boot downloads ~2 GB — pre-seed for that case).
``VCCLIENT000_LOG_FILE``          file the child's stdout/stderr is appended to
                                  (default under the temp dir).

Lifecycle
---------
On every (re)start the supervisor first **sanitises** ``index_ratio`` to ``0.0``
in every ``model_dir/<slot>/params.json`` of the dist: a non-zero index ratio
segfaults the ARM PyInstaller build on the first chunk, and the value persists
on disk, so a server that crashed for this reason would crash again on relaunch
until the JSON is fixed. Then it spawns the binary headless, polls
``GET /api/hello`` until healthy, and watches the process. A death is logged
(exit code / signal), params are re-sanitised, and the process is relaunched
with exponential backoff (1 s, 2 s, 4 s ... capped) up to 3 restarts per rolling
5-minute window; once the budget is exhausted the runtime enters ``crash_loop``
and the voice stage reports ``failed`` reason ``vcclient_crash_loop`` until the
window frees up.

Process groups
--------------
The child is launched in its own session/process group so the whole tree (the
PyInstaller parent plus the forked uvicorn worker that actually owns the port)
can be torn down together — ``os.killpg`` on POSIX, ``CREATE_NEW_PROCESS_GROUP``
+ ``taskkill /T`` on Windows — leaving no orphans.
"""

from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

from .runtime import env_flag, env_float, env_int, env_value, now_iso


# -- runtime states ------------------------------------------------------------

STATE_DISABLED = "disabled"       # managed mode off
STATE_IDLE = "idle"               # supervisor created, not started yet
STATE_STARTING = "starting"       # process spawned, waiting for health
STATE_HEALTHY = "healthy"         # /api/hello answered as VCClient
STATE_RESTARTING = "restarting"   # child died, backing off before relaunch
STATE_CRASH_LOOP = "crash_loop"   # restart budget exhausted in the window
STATE_STOPPED = "stopped"         # stop() requested / endpoint shutting down

# States in which the voice stage should surface degraded/`vcclient_starting`
# (transient — the server is coming up) rather than failing outright.
_STARTING_STATES = {STATE_IDLE, STATE_STARTING, STATE_RESTARTING}

_HELLO_PATH = "/api/hello"
_HELLO_MARKERS = ("vcclient", "w-okada", "cute voice")

_RESTART_WINDOW_SECS = 300.0
_MAX_RESTARTS_PER_WINDOW = 3
_BACKOFF_BASE_SECS = 1.0
_BACKOFF_CAP_SECS = 30.0
_HEALTH_POLL_INTERVAL_SECS = 0.5


def is_windows() -> bool:
    return platform.system() == "Windows"


def managed_enabled() -> bool:
    return env_flag("VCCLIENT000_MANAGED")


def default_binary_name() -> str:
    explicit = env_value("VCCLIENT000_BIN")
    if explicit:
        return explicit
    return "main.exe" if is_windows() else "main"


class VCClientSupervisor:
    """Owns the lifecycle of a single managed VCClient v2 process."""

    def __init__(self) -> None:
        self.managed = managed_enabled()
        self.dist_dir = env_value("VCCLIENT000_DIST_DIR")
        self.host = env_value("VCCLIENT000_HOST", "127.0.0.1") or "127.0.0.1"
        self.port = env_int("VCCLIENT000_PORT", 18000)
        self.boot_timeout = max(5.0, env_float("VCCLIENT000_BOOT_TIMEOUT_SECS", 90.0))
        self.binary_name = default_binary_name()
        self.log_file = self._resolve_log_file()

        self._process: subprocess.Popen | None = None
        self._pid: int | None = None
        self._started_monotonic: float | None = None
        self._started_at_iso: str | None = None
        self._healthy_at_iso: str | None = None
        self._restarts = 0
        self._restart_times: deque[float] = deque()
        self._last_crash: dict[str, Any] | None = None
        self._last_error: str | None = None

        self._state = STATE_DISABLED if not self.managed else STATE_IDLE
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._log_handle = None

    # -- public API ------------------------------------------------------------

    def endpoint(self) -> str:
        return f"http://{self.host}:{self.port}"

    def health_url(self) -> str:
        return f"{self.endpoint()}{_HELLO_PATH}"

    def is_healthy(self) -> bool:
        return self._state == STATE_HEALTHY

    @property
    def state(self) -> str:
        return self._state

    def configuration_error(self) -> str | None:
        """Return a human message if managed mode is on but misconfigured."""

        if not self.managed:
            return None
        if not self.dist_dir:
            return "VCCLIENT000_MANAGED=1 pero VCCLIENT000_DIST_DIR no está configurado."
        binary = self._binary_path()
        if binary is None or not binary.exists():
            return f"binario VCClient no encontrado: {binary}"
        return None

    def start(self) -> None:
        """Start the watchdog thread (idempotent, non-blocking)."""

        if not self.managed:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            error = self.configuration_error()
            if error:
                self._state = STATE_CRASH_LOOP
                self._last_error = error
                print(f"[vcclient-supervisor] no se puede arrancar: {error}")
                return
            self._stop.clear()
            self._state = STATE_STARTING
            self._thread = threading.Thread(
                target=self._watchdog_loop, name="vcclient-supervisor", daemon=True
            )
            self._thread.start()
            print(
                f"[vcclient-supervisor] gestionando VCClient en {self.endpoint()} "
                f"(dist={self.dist_dir}, boot_timeout={self.boot_timeout:.0f}s)"
            )

    def stop(self, timeout: float = 6.0) -> None:
        """Signal the watchdog to stop and tear down the child tree."""

        if not self.managed:
            return
        self._stop.set()
        with self._lock:
            self._state = STATE_STOPPED
            process = self._process
        self._terminate_process(process, timeout)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=timeout)
        self._close_log()

    def status(self) -> dict[str, Any]:
        with self._lock:
            uptime = None
            if self._started_monotonic is not None and self._state == STATE_HEALTHY:
                uptime = round(time.monotonic() - self._started_monotonic, 1)
            running = self._process is not None and self._process.poll() is None
            return {
                "managed": self.managed,
                "state": self._state,
                "running": bool(running),
                "healthy": self._state == STATE_HEALTHY,
                "pid": self._pid if running else None,
                "endpoint": self.endpoint() if self.managed else None,
                "distDir": self.dist_dir,
                "startedAt": self._started_at_iso,
                "healthyAt": self._healthy_at_iso,
                "uptimeSec": uptime,
                "restarts": self._restarts,
                "restartsInWindow": self._restarts_in_window(),
                "bootTimeoutSec": self.boot_timeout,
                "logFile": self.log_file,
                "lastCrash": self._last_crash,
                "reason": self._reason(),
                "error": self._last_error,
            }

    def stage_signal(self) -> dict[str, Any] | None:
        """How the voice stage should reflect the supervisor, or ``None``.

        Returns ``{"kind": "degraded"|"failed", "reason": ..., "detail": ...}``
        while the server is not healthy so the voice engine can short-circuit a
        conversion (avoiding a connection-refused that would otherwise march the
        stage toward ``failed``). ``None`` when managed mode is off or healthy.
        """

        if not self.managed:
            return None
        with self._lock:
            state = self._state
            detail = self._reason()
        if state == STATE_HEALTHY:
            return None
        if state == STATE_CRASH_LOOP:
            return {"kind": "failed", "reason": "vcclient_crash_loop", "detail": detail}
        if state in _STARTING_STATES:
            return {"kind": "degraded", "reason": "vcclient_starting", "detail": detail}
        # STATE_STOPPED (endpoint shutting down): degraded, not a hard failure.
        return {"kind": "degraded", "reason": "vcclient_stopped", "detail": detail}

    # -- watchdog --------------------------------------------------------------

    def _watchdog_loop(self) -> None:
        while not self._stop.is_set():
            self._sanitize_params()
            process = self._spawn()
            if process is None:
                self._register_crash(exit_code=None, signal_num=None, note="spawn_failed")
                if not self._backoff_or_crash_loop():
                    return
                continue

            healthy = self._await_health(process)
            if self._stop.is_set():
                return
            if not healthy:
                # Boot stalled (report §8: downloads can hang forever). Kill and
                # count it as a crash so the backoff/crash-loop budget applies.
                self._terminate_process(process, timeout=4.0)
                self._register_crash(
                    exit_code=process.poll(), signal_num=None, note="boot_timeout"
                )
                if not self._backoff_or_crash_loop():
                    return
                continue

            # Healthy: block until the child exits or a stop is requested.
            self._watch_until_exit(process)
            if self._stop.is_set():
                return

            exit_code = process.poll()
            signal_num = -exit_code if isinstance(exit_code, int) and exit_code < 0 else None
            self._register_crash(exit_code=exit_code, signal_num=signal_num, note="exited")
            if not self._backoff_or_crash_loop():
                return

    def _watch_until_exit(self, process: subprocess.Popen) -> None:
        while not self._stop.is_set():
            if process.poll() is not None:
                return
            self._stop.wait(_HEALTH_POLL_INTERVAL_SECS)

    def _await_health(self, process: subprocess.Popen) -> bool:
        deadline = time.monotonic() + self.boot_timeout
        while not self._stop.is_set() and time.monotonic() < deadline:
            if process.poll() is not None:
                return False  # died during boot
            if self._probe_health():
                with self._lock:
                    self._state = STATE_HEALTHY
                    self._healthy_at_iso = now_iso()
                    self._last_error = None
                uptime = time.monotonic() - (self._started_monotonic or time.monotonic())
                print(
                    f"[vcclient-supervisor] VCClient healthy en {self.endpoint()} "
                    f"tras {uptime:.1f}s (pid={self._pid})"
                )
                return True
            self._stop.wait(_HEALTH_POLL_INTERVAL_SECS)
        return False

    def _probe_health(self) -> bool:
        request = urllib.request.Request(self.health_url(), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=3.0) as response:
                if response.status != 200:
                    return False
                body = response.read(4096).decode("utf-8", errors="replace").lower()
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return any(marker in body for marker in _HELLO_MARKERS)

    # -- process management ----------------------------------------------------

    def _binary_path(self) -> Path | None:
        if not self.dist_dir:
            return None
        return Path(self.dist_dir) / self.binary_name

    def _spawn(self) -> subprocess.Popen | None:
        binary = self._binary_path()
        if binary is None or not binary.exists():
            self._last_error = f"binario VCClient no encontrado: {binary}"
            print(f"[vcclient-supervisor] {self._last_error}")
            return None

        command = [
            str(binary),
            "cui",
            "--host",
            self.host,
            "--port",
            str(self.port),
            "--https",
            "false",
            "--launch_client",
            "false",
            "--no_cui",
            "True",
        ]

        try:
            log_handle = self._open_log()
        except OSError as error:
            print(f"[vcclient-supervisor] no se pudo abrir el log {self.log_file}: {error}")
            log_handle = subprocess.DEVNULL

        try:
            process = subprocess.Popen(
                command,
                cwd=str(self.dist_dir),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                env=self._child_env(),
                **self._popen_platform_options(),
            )
        except OSError as error:
            self._last_error = f"no se pudo lanzar VCClient: {error}"
            print(f"[vcclient-supervisor] {self._last_error}")
            return None

        with self._lock:
            self._process = process
            self._pid = process.pid
            self._started_monotonic = time.monotonic()
            self._started_at_iso = now_iso()
            self._healthy_at_iso = None
            if self._state != STATE_STOPPED:
                self._state = STATE_STARTING
        print(
            f"[vcclient-supervisor] VCClient lanzado pid={process.pid} "
            f"puerto={self.port} (logs -> {self.log_file})"
        )
        return process

    def _child_env(self) -> dict[str, str]:
        env = os.environ.copy()
        # The child is VCClient itself, not another Shape managed processor.
        env.pop("SHAPE_MODEL_ENDPOINT_ENGINE", None)
        return env

    def _popen_platform_options(self) -> dict[str, Any]:
        if is_windows():
            # New process group so CTRL_BREAK / taskkill /T can reach the tree;
            # DETACHED avoids inheriting the parent console.
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            return {"creationflags": flags}
        # POSIX: own session => the parent PID is the process-group leader, so
        # killpg tears down the PyInstaller parent and the forked worker at once.
        return {"start_new_session": True}

    def _terminate_process(self, process: subprocess.Popen | None, timeout: float) -> None:
        if process is None or process.poll() is not None:
            return
        pid = process.pid
        if is_windows():
            # taskkill /T /F reaches the whole child tree; process.terminate()
            # only hits the top-level PyInstaller stub. (Untested on this Mac.)
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    timeout=timeout,
                    check=False,
                )
            except Exception:
                try:
                    process.terminate()
                except Exception:
                    pass
            try:
                process.wait(timeout=timeout)
            except Exception:
                pass
            return

        # POSIX: SIGTERM the group, wait, then SIGKILL the group.
        self._signal_group(pid, signal.SIGTERM)
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass
        self._signal_group(pid, signal.SIGKILL)
        try:
            process.wait(timeout=max(1.0, timeout / 2))
        except subprocess.TimeoutExpired:
            print(f"[vcclient-supervisor] VCClient pid={pid} no respondió a SIGKILL")

    @staticmethod
    def _signal_group(pid: int, sig: int) -> None:
        try:
            os.killpg(os.getpgid(pid), sig)
        except ProcessLookupError:
            return
        except OSError:
            # Group may already be gone or getpgid failed; fall back to the pid.
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    # -- crash accounting ------------------------------------------------------

    def _register_crash(self, exit_code, signal_num, note: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._restarts += 1
            self._restart_times.append(now)
            self._prune_restart_times(now)
            self._last_crash = {
                "at": now_iso(),
                "exitCode": exit_code,
                "signal": signal_num,
                "note": note,
                "restarts": self._restarts,
            }
            self._process = None
        detail = f"exit={exit_code}"
        if signal_num:
            detail += f" signal={signal_num}"
        print(f"[vcclient-supervisor] VCClient murió ({note}, {detail}); saneando y relanzando")

    def _prune_restart_times(self, now: float) -> None:
        while self._restart_times and now - self._restart_times[0] > _RESTART_WINDOW_SECS:
            self._restart_times.popleft()

    def _restarts_in_window(self) -> int:
        self._prune_restart_times(time.monotonic())
        return len(self._restart_times)

    def _backoff_or_crash_loop(self) -> bool:
        """Wait a backoff (or enter crash loop). Return ``True`` to keep going."""

        if self._stop.is_set():
            return False
        with self._lock:
            in_window = self._restarts_in_window()
        if in_window > _MAX_RESTARTS_PER_WINDOW:
            with self._lock:
                self._state = STATE_CRASH_LOOP
                self._last_error = (
                    f"VCClient superó {_MAX_RESTARTS_PER_WINDOW} reintentos en "
                    f"{int(_RESTART_WINDOW_SECS)}s; en crash loop."
                )
            print(f"[vcclient-supervisor] {self._last_error}")
            return self._wait_for_window_reset()

        delay = min(_BACKOFF_CAP_SECS, _BACKOFF_BASE_SECS * (2 ** max(0, in_window - 1)))
        with self._lock:
            if self._state != STATE_STOPPED:
                self._state = STATE_RESTARTING
        print(f"[vcclient-supervisor] backoff {delay:.0f}s antes de relanzar VCClient")
        self._stop.wait(delay)
        return not self._stop.is_set()

    def _wait_for_window_reset(self) -> bool:
        """Block until the crash window frees up, then allow a fresh attempt."""

        while not self._stop.is_set():
            with self._lock:
                in_window = self._restarts_in_window()
            if in_window <= _MAX_RESTARTS_PER_WINDOW:
                with self._lock:
                    if self._state == STATE_CRASH_LOOP:
                        self._state = STATE_RESTARTING
                return True
            self._stop.wait(min(30.0, _RESTART_WINDOW_SECS / 4))
        return False

    # -- params.json sanitation ------------------------------------------------

    def _model_dir(self) -> Path | None:
        if not self.dist_dir:
            return None
        return Path(self.dist_dir) / "model_dir"

    def _sanitize_params(self) -> int:
        """Force ``index_ratio`` to ``0.0`` in every slot's params.json.

        A non-zero ``index_ratio`` segfaults the ARM PyInstaller build on the
        first chunk and the value persists on disk, so this MUST run before every
        (re)launch. Returns the number of files rewritten.
        """

        model_dir = self._model_dir()
        if model_dir is None or not model_dir.is_dir():
            return 0
        rewritten = 0
        for params_path in sorted(model_dir.glob("*/params.json")):
            try:
                data = json.loads(params_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            try:
                current = float(data.get("index_ratio", 0.0) or 0.0)
            except (TypeError, ValueError):
                current = 1.0  # force a rewrite on an unparseable value
            if current != 0.0 or "index_ratio" not in data:
                data["index_ratio"] = 0.0
                try:
                    params_path.write_text(json.dumps(data), encoding="utf-8")
                    rewritten += 1
                except OSError:
                    continue
        if rewritten:
            print(f"[vcclient-supervisor] saneado index_ratio=0.0 en {rewritten} slot(s)")
        return rewritten

    # -- logging ---------------------------------------------------------------

    def _resolve_log_file(self) -> str:
        explicit = env_value("VCCLIENT000_LOG_FILE")
        if explicit:
            return explicit
        log_dir = env_value("SHAPE_AI_LOG_DIR")
        if log_dir:
            return str(Path(log_dir) / f"vcclient-managed-{self.port}.log")
        import tempfile

        return str(Path(tempfile.gettempdir()) / f"shape-vcclient-managed-{self.port}.log")

    def _open_log(self):
        self._close_log()
        Path(self.log_file).parent.mkdir(parents=True, exist_ok=True)
        self._log_handle = open(self.log_file, "ab", buffering=0)
        return self._log_handle

    def _close_log(self) -> None:
        handle = self._log_handle
        self._log_handle = None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    # -- reason ----------------------------------------------------------------

    def _reason(self) -> str | None:
        state = self._state
        if state == STATE_HEALTHY:
            return None
        if state == STATE_CRASH_LOOP:
            return self._last_error or "VCClient en crash loop."
        if state in _STARTING_STATES:
            return "VCClient arrancando (managed)."
        if state == STATE_STOPPED:
            return "VCClient detenido (endpoint apagándose)."
        if state == STATE_DISABLED:
            return None
        return self._last_error


# -- module singleton ----------------------------------------------------------

_SUPERVISOR: VCClientSupervisor | None = None
_SUPERVISOR_LOCK = threading.Lock()


def get_supervisor() -> VCClientSupervisor:
    global _SUPERVISOR
    if _SUPERVISOR is None:
        with _SUPERVISOR_LOCK:
            if _SUPERVISOR is None:
                _SUPERVISOR = VCClientSupervisor()
    return _SUPERVISOR
