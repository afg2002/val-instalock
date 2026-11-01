"""Cancellable background worker; the GUI never waits for Riot requests."""

from __future__ import annotations

import threading
from collections import deque
from datetime import datetime, timezone
from typing import Callable

from .catalog import AgentCatalog, CatalogError
from .gateway import (
    AgentUnavailable,
    DemoGateway,
    Gateway,
    GatewayError,
    NotInPregame,
    REGIONS,
    ValorantGateway,
)


class ServiceError(RuntimeError):
    """Safe to display in the UI."""


class LockService:
    def __init__(
        self,
        catalog: AgentCatalog,
        *,
        demo: bool = False,
        gateway_factory: Callable[[str], Gateway] | None = None,
        poll_interval: float = 1.0,
    ) -> None:
        self.catalog = catalog
        self.demo = demo
        self._factory = gateway_factory or (DemoGateway if demo else ValorantGateway)
        self.poll_interval = max(0.01, poll_interval)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._message = (
            "Mode demo siap. Tidak ada akun yang terhubung."
            if demo
            else "Pilih agent, lalu mulai saat VALORANT sudah login."
        )
        self._agent_id: str | None = None
        self._region = "ap"
        self._logs: deque[dict[str, str]] = deque(maxlen=40)
        self._log_id = 0
        self._attempted: set[str] = set()
        self._active = False
        self._log("info", self._message)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "message": self._message,
                "active": self._active,
                "stopping": bool(
                    not self._active and self._thread and self._thread.is_alive()
                ),
                "agent_id": self._agent_id,
                "region": self._region,
                "demo": self.demo,
                "logs": list(self._logs),
            }

    def _log(self, level: str, message: str) -> None:
        with self._lock:
            self._log_id += 1
            self._logs.append(
                {
                    "id": str(self._log_id),
                    "level": level,
                    "message": message,
                    "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            )

    def _set(
        self,
        state: str,
        message: str,
        *,
        log: bool = True,
        stop: threading.Event | None = None,
    ) -> None:
        with self._lock:
            if stop is not None and stop.is_set():
                return
            self._state, self._message = state, message
            if log:
                self._log(
                    "success"
                    if state == "locked"
                    else "error"
                    if state == "error"
                    else "info",
                    message,
                )

    def start(self, agent_id: str, region: str = "ap") -> dict:
        if not isinstance(agent_id, str) or not isinstance(region, str):
            raise ServiceError("Agent dan region harus valid.")
        try:
            agent = self.catalog.get(agent_id)
        except CatalogError as exc:
            raise ServiceError(str(exc)) from exc
        if region not in REGIONS:
            raise ServiceError("Pilih region yang tersedia.")
        with self._lock:
            if self._active or (self._thread and self._thread.is_alive()):
                raise ServiceError(
                    "Proses masih berjalan. Hentikan dulu sebelum memulai lagi."
                )
            self._stop = threading.Event()
            self._attempted.clear()
            self._agent_id, self._region, self._active = agent.id, region, True
            self._set(
                "connecting",
                f"{'Simulasi: ' if self.demo else ''}menghubungkan ke client…",
            )
            self._log(
                "info",
                f"Pilihan: {agent.name} · {REGIONS[region][0]}{' · DEMO' if self.demo else ''}.",
            )
            self._thread = threading.Thread(
                target=self._run,
                args=(agent, region, self._stop),
                name="instalock-demo" if self.demo else "instalock-live",
                daemon=True,
            )
            self._thread.start()
        return self.snapshot()

    def stop(self) -> dict:
        with self._lock:
            self._stop.set()
            if self._active:
                self._active = False
                self._set("stopped", "Dihentikan. Tidak ada permintaan lock baru.")
            elif self._state == "idle":
                self._set("idle", "Belum ada proses yang berjalan.", log=False)
        return self.snapshot()

    def _run(self, agent, region: str, stop: threading.Event) -> None:
        gateway = None
        try:
            gateway = self._factory(region)
            gateway.connect(stop)
            if stop.is_set():
                return
            self._set(
                "waiting",
                "Simulasi: menunggu pemilihan agent…"
                if self.demo
                else "Terhubung. Menunggu pemilihan agent di VALORANT…",
                stop=stop,
            )
            while not stop.is_set():
                try:
                    pregame = gateway.fetch_pregame(agent.uuid, stop)
                    if stop.is_set():
                        return
                    if pregame.match_id in self._attempted:
                        stop.wait(self.poll_interval)
                        continue
                    if pregame.own_state == "locked_requested":
                        self._attempted.add(pregame.match_id)
                        self._finish_locked(agent.name, stop)
                        return
                    if pregame.own_state == "locked":
                        raise AgentUnavailable(
                            "Kamu sudah mengunci agent lain di pertandingan ini."
                        )
                    if pregame.locked_by_teammate:
                        raise AgentUnavailable(
                            f"{agent.name} sudah di-lock pemain lain. Pilih agent lain; pilihan teman tidak ditimpa."
                        )
                    self._set(
                        "locking",
                        f"{'Simulasi: ' if self.demo else ''}mencoba mengunci {agent.name}…",
                        stop=stop,
                    )
                    self._attempted.add(pregame.match_id)
                    if stop.is_set():
                        return
                    gateway.lock(agent.uuid, pregame, stop)
                    if stop.is_set():
                        return
                    self._finish_locked(agent.name, stop)
                    return
                except NotInPregame:
                    if not stop.is_set():
                        self._set(
                            "waiting", "Menunggu pemilihan agent…", log=False, stop=stop
                        )
                except (AgentUnavailable, GatewayError) as exc:
                    if not stop.is_set():
                        self._set("error", str(exc), stop=stop)
                    return
                except Exception:
                    if not stop.is_set():
                        self._set(
                            "error",
                            "Terjadi kesalahan pada adapter client. Coba lagi setelah VALORANT siap.",
                            stop=stop,
                        )
                    return
                stop.wait(self.poll_interval)
        except (GatewayError, AgentUnavailable) as exc:
            if not stop.is_set():
                self._set("error", str(exc), stop=stop)
        except Exception:
            if not stop.is_set():
                self._set(
                    "error",
                    "Client belum bisa terhubung. Periksa instalasi dan coba lagi.",
                    stop=stop,
                )
        finally:
            try:
                if gateway is not None:
                    gateway.close()
            except Exception:
                pass  # A cleanup failure must not leave the worker marked active.
            with self._lock:
                self._active = False
                if self._state in ("connecting", "waiting", "locking"):
                    self._set("stopped", "Dihentikan.", log=False)

    def _finish_locked(self, name: str, stop: threading.Event) -> None:
        with self._lock:
            if stop.is_set():
                return
            self._active = False
            self._set(
                "locked",
                f"Simulasi selesai: {name} berhasil di-lock. Tidak ada lock sungguhan."
                if self.demo
                else f"{name} berhasil di-lock. Sampai ketemu di pertandingan!",
            )

    def close(self) -> None:
        self.stop()
        if self._thread:
            self._thread.join(timeout=0.2)
