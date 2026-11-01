"""Bounded local Riot Client requests. Credentials stay in memory, never in the GUI.

The pregame protocol follows the original valclient.py project. This small adapter
adds explicit timeouts and response validation instead of issuing unbounded calls.
It does not read game memory, inject into the game, or bypass authentication.
"""

from __future__ import annotations

import base64
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

REGIONS = {
    "ap": ("Asia Pacific", "ap"),
    "na": ("America Utara", "na"),
    "eu": ("Eropa", "eu"),
    "kr": ("Korea", "kr"),
    "br": ("Brasil", "na"),
    "latam": ("America Latin", "na"),
}
PLATFORM = base64.b64encode(
    b'{"platformType":"PC","platformOS":"Windows","platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}'
).decode()


class GatewayError(RuntimeError):
    """An actionable error whose message contains no credentials or response body."""


class NotInPregame(Exception):
    """Normal lobby/menu state, not an application failure."""


class AgentUnavailable(GatewayError):
    """The requested agent cannot be locked in this match."""


@dataclass(frozen=True, slots=True)
class Pregame:
    match_id: str
    agent_id: str
    own_state: str
    locked_by_teammate: bool


class Gateway(Protocol):
    def connect(self, stop: threading.Event) -> None: ...
    def fetch_pregame(self, agent_id: str, stop: threading.Event) -> Pregame: ...
    def lock(self, agent_id: str, pregame: Pregame, stop: threading.Event) -> None: ...
    def close(self) -> None: ...


class ValorantGateway:
    """Live adapter for the logged-in Windows Riot Client; no username/password input."""

    def __init__(self, region: str = "ap") -> None:
        if region not in REGIONS:
            raise GatewayError("Region tidak valid.")
        self.region = region
        self._session: Any = None
        self._local: Any = None
        self._puuid = ""
        self._base = ""
        self._headers: dict[str, str] = {}

    def connect(self, stop: threading.Event) -> None:
        try:
            import requests
            import urllib3
        except ImportError as exc:
            raise GatewayError(
                "Dependency belum terpasang. Jalankan: python -m pip install -r requirements.txt"
            ) from exc
        local_appdata = os.environ.get("LOCALAPPDATA")
        if not local_appdata:
            raise GatewayError(
                "Mode live membutuhkan Windows dan Riot Client yang sudah login. Coba --demo untuk melihat GUI."
            )
        lockfile = (
            Path(local_appdata) / "Riot Games" / "Riot Client" / "Config" / "lockfile"
        )
        try:
            parts = lockfile.read_text(encoding="utf-8").strip().split(":")
            if len(parts) != 5 or parts[4] != "https" or not parts[2].isdigit():
                raise ValueError("invalid lockfile")
            port, password = int(parts[2]), parts[3]
            if not 1 <= port <= 65535 or not password:
                raise ValueError("invalid lockfile")
        except (OSError, ValueError) as exc:
            raise GatewayError(
                "Riot Client belum terdeteksi. Buka VALORANT, login sampai lobby, lalu mulai lagi."
            ) from exc
        if stop.is_set():
            return
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        self._session = requests.Session()
        self._session.trust_env = False
        self._local = requests.Session()
        self._local.trust_env = False
        self._local.verify = (
            False  # Riot's local endpoint uses a self-signed certificate.
        )
        self._local.auth = ("riot", password)
        local_url = f"https://127.0.0.1:{port}"
        try:
            response = self._local.get(
                f"{local_url}/entitlements/v1/token", timeout=(3, 5)
            )
            response.raise_for_status()
            token = response.json()
            self._puuid = token["subject"]
            version_response = self._session.get(
                "https://valorant-api.com/v1/version", timeout=(3, 5)
            )
            version_response.raise_for_status()
            version = version_response.json()["data"]
            client_version = f"{version['branch']}-shipping-{version['buildVersion']}-{version['version'].split('.')[3]}"
            self._headers = {
                "Authorization": f"Bearer {token['accessToken']}",
                "X-Riot-Entitlements-JWT": token["token"],
                "X-Riot-ClientPlatform": PLATFORM,
                "X-Riot-ClientVersion": client_version,
                "Content-Type": "application/json",
            }
            _, shard = REGIONS[self.region]
            self._base = f"https://glz-{self.region}-1.{shard}.a.pvp.net"
        except Exception as exc:
            self.close()
            if isinstance(exc, GatewayError):
                raise
            raise GatewayError(
                "Koneksi ke Riot gagal. Pastikan VALORANT sudah login dan versi client terbaru, lalu coba lagi."
            ) from exc

    def _request(self, method: str, path: str) -> Any:
        if self._session is None or not self._puuid:
            raise GatewayError("Client belum terhubung.")
        try:
            response = self._session.request(
                method,
                self._base + path,
                headers=self._headers,
                timeout=(3, 5),
                allow_redirects=False,
            )
        except Exception as exc:
            raise GatewayError(
                "Koneksi ke client terputus atau timeout. Mulai ulang setelah VALORANT siap."
            ) from exc
        if response.status_code == 404:
            if method == "POST":
                raise AgentUnavailable(
                    "Pemilihan agent sudah berakhir. Lock tidak diulang."
                )
            raise NotInPregame()
        if response.status_code in (401, 403):
            raise GatewayError(
                "Sesi Riot berakhir. Pastikan client masih login, lalu mulai lagi."
            )
        if response.status_code == 429:
            raise GatewayError(
                "Riot membatasi permintaan. Tunggu sebentar sebelum mencoba lagi."
            )
        if response.status_code in (400, 409):
            raise AgentUnavailable(
                "Agent belum terbuka, sudah diambil, atau pemilihan sudah berakhir. Tidak ada percobaan ulang otomatis."
            )
        if not 200 <= response.status_code < 300:
            raise GatewayError(
                f"Riot menolak permintaan (HTTP {response.status_code}). Coba lagi nanti."
            )
        try:
            return response.json()
        except (ValueError, AttributeError) as exc:
            raise GatewayError(
                "Respons Riot tidak valid. Pastikan game dan API client kompatibel."
            ) from exc

    @staticmethod
    def _match_id(data: Any) -> str:
        value = (
            data.get("ID") or data.get("MatchID") if isinstance(data, dict) else None
        )
        if not isinstance(value, str) or not value or len(value) > 100:
            raise GatewayError("ID pemilihan agent dari Riot tidak valid.")
        return value

    def _snapshot(self, data: Any, match_id: str, agent_id: str) -> Pregame:
        if not isinstance(data, dict) or self._match_id(data) != match_id:
            raise GatewayError(
                "Data pemilihan agent berubah. Percobaan lock dihentikan."
            )
        team = data.get("AllyTeam")
        players = team.get("Players") if isinstance(team, dict) else None
        if not isinstance(players, list):
            raise GatewayError("Data tim dari Riot tidak lengkap.")
        own_state, taken, own_found = "", False, False
        for player in players:
            if not isinstance(player, dict):
                continue
            locked = str(player.get("CharacterSelectionState", "")).lower() == "locked"
            if player.get("Subject") == self._puuid:
                own_found = True
                own_state = (
                    "locked"
                    if locked
                    else str(player.get("CharacterSelectionState", ""))
                )
                if locked and player.get("CharacterID") == agent_id:
                    own_state = "locked_requested"
            elif locked and player.get("CharacterID") == agent_id:
                taken = True
        if not own_found:
            raise GatewayError(
                "Data pemain lokal tidak ada di pemilihan agent ini. Lock dibatalkan."
            )
        return Pregame(match_id, agent_id, own_state, taken)

    def fetch_pregame(self, agent_id: str, stop: threading.Event) -> Pregame:
        if stop.is_set():
            raise NotInPregame()
        player = self._request("GET", f"/pregame/v1/players/{self._puuid}")
        match_id = self._match_id(player)
        if stop.is_set():
            raise NotInPregame()
        data = self._request("GET", f"/pregame/v1/matches/{match_id}")
        # The caller supplies the immutable selected UUID for this run.
        return self._snapshot(data, match_id, agent_id)

    def lock(self, agent_id: str, pregame: Pregame, stop: threading.Event) -> None:
        if stop.is_set():
            return
        result = self._request(
            "POST", f"/pregame/v1/matches/{pregame.match_id}/lock/{agent_id}"
        )
        if stop.is_set():
            return
        # Never retry an ambiguous POST. One read-only check resolves its outcome.
        try:
            snapshot = self._snapshot(result, pregame.match_id, agent_id)
        except GatewayError:
            try:
                snapshot = self._snapshot(
                    self._request("GET", f"/pregame/v1/matches/{pregame.match_id}"),
                    pregame.match_id,
                    agent_id,
                )
            except NotInPregame as exc:
                raise AgentUnavailable(
                    "Pemilihan agent sudah berakhir sebelum lock terkonfirmasi. Cek hasil di game."
                ) from exc
        if snapshot.own_state != "locked_requested":
            try:
                snapshot = self._snapshot(
                    self._request("GET", f"/pregame/v1/matches/{pregame.match_id}"),
                    pregame.match_id,
                    agent_id,
                )
            except NotInPregame as exc:
                raise AgentUnavailable(
                    "Pemilihan agent sudah berakhir sebelum lock terkonfirmasi. Cek hasil di game."
                ) from exc
        if snapshot.own_state != "locked_requested":
            raise AgentUnavailable(
                "Lock belum terkonfirmasi. Cek pemilihan agent di game; permintaan tidak diulang otomatis."
            )

    def close(self) -> None:
        for session in (self._session, self._local):
            if session is not None:
                session.close()
        self._session = self._local = None
        self._headers = {}
        self._puuid = ""


class DemoGateway:
    """A cancellable, explicitly labelled simulation. It never contacts Riot."""

    def __init__(self, region: str = "ap") -> None:
        self.region = region

    def connect(self, stop: threading.Event) -> None:
        stop.wait(0.5)

    def fetch_pregame(self, agent_id: str, stop: threading.Event) -> Pregame:
        if stop.wait(2.0):
            raise NotInPregame()
        return Pregame("demo-match", agent_id, "", False)

    def lock(self, agent_id: str, pregame: Pregame, stop: threading.Event) -> None:
        stop.wait(0.65)

    def close(self) -> None:
        pass
