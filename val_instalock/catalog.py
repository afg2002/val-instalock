"""Validated, offline-first agent catalog with an optional atomic online refresh."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable

API_URL = "https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US"
ROLES = ("Duelist", "Controller", "Initiator", "Sentinel")
LEGACY_ROLES = {
    "Duelist": (
        "Jett",
        "Reyna",
        "Phoenix",
        "Pheonix",
        "Raze",
        "Yoru",
        "Neon",
        "Iso",
        "Waylay",
        "Hush",
    ),
    "Controller": ("Omen", "Clove", "Astra", "Brimstone", "Harbor", "Viper", "Miks"),
    "Initiator": ("Breach", "Fade", "Gekko", "KAY/O", "KAYO", "Skye", "Sova", "Tejo"),
    "Sentinel": ("Sage", "Veto", "Chamber", "Cypher", "Deadlock", "Killjoy", "Vyse"),
}
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG = ROOT / "agents.json"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_COLOR = re.compile(r"[0-9a-fA-F]{6}\Z")


class CatalogError(ValueError):
    """A catalog could not be loaded or refreshed; the previous one is safe."""


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.casefold())


@dataclass(frozen=True, slots=True)
class Agent:
    id: str
    name: str
    uuid: str
    role: str
    release_date: str = ""
    color: str = "a8b8c8"
    portrait: str = ""

    def public_dict(self) -> dict[str, str]:
        data = asdict(self)
        local_image = f"/assets/agents/{self.id}.webp"
        has_local_image = (ROOT / "static" / local_image.lstrip("/")).is_file()
        data["image"] = local_image if has_local_image else self.portrait
        data.pop("portrait")
        return data


def _validated_agent(raw: Any, *, remote: bool = False) -> Agent:
    if not isinstance(raw, dict):
        raise CatalogError("Entri agent harus berupa object.")
    name = raw.get("displayName" if remote else "name")
    agent_uuid = raw.get("uuid")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
        raise CatalogError("Nama agent tidak valid.")
    if not isinstance(agent_uuid, str) or not _UUID.fullmatch(agent_uuid.lower()):
        raise CatalogError(f"UUID agent tidak valid: {name[:40]}.")
    agent_uuid = str(uuid.UUID(agent_uuid))
    if remote:
        role_raw = raw.get("role")
        role = role_raw.get("displayName") if isinstance(role_raw, dict) else None
        agent_id = normalize_name(name)
        portrait = raw.get("fullPortrait") or ""
        colors = raw.get("backgroundGradientColors")
        color = (
            colors[0][:6]
            if isinstance(colors, list) and colors and isinstance(colors[0], str)
            else "a8b8c8"
        )
        release_date = ""
    else:
        role = raw.get("role")
        agent_id = raw.get("id")
        portrait = raw.get("portrait", "")
        color = raw.get("color", "a8b8c8")
        release_date = raw.get("release_date", "")
    if role not in ROLES:
        raise CatalogError(f"Role agent tidak dikenal: {name}.")
    if not isinstance(agent_id, str) or not _SLUG.fullmatch(agent_id):
        raise CatalogError(f"ID lokal agent tidak valid: {name}.")
    if not isinstance(color, str) or not _COLOR.fullmatch(color):
        color = "a8b8c8"
    if not isinstance(portrait, str):
        portrait = ""
    if portrait and not portrait.startswith("https://media.valorant-api.com/"):
        raise CatalogError(f"URL potret tidak diizinkan: {name}.")
    if not isinstance(release_date, str):
        release_date = ""
    if release_date:
        try:
            date.fromisoformat(release_date)
        except ValueError as exc:
            raise CatalogError(f"Tanggal rilis tidak valid: {name}.") from exc
    return Agent(
        agent_id, name.strip(), agent_uuid, role, release_date, color.lower(), portrait
    )


class AgentCatalog:
    """Keep the last good catalog in memory and on disk, never a partial JSON file."""

    def __init__(self, path: Path = DEFAULT_CATALOG) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._refresh_lock = threading.Lock()
        self.updated_at = ""
        self.agents: tuple[Agent, ...] = ()
        self.load()

    def load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("schema_version") == 1:
                raw_agents = data.get("agents")
                updated_at = data.get("updated_at", "")
            elif isinstance(data, dict):
                # The original name -> UUID format has no role metadata. Use known
                # names only; never assign a guessed role to a custom legacy entry.
                roles = {
                    normalize_name(name): role
                    for role, names in LEGACY_ROLES.items()
                    for name in names
                }
                raw_agents = []
                for name, value in data.items():
                    role = roles.get(normalize_name(name))
                    if role is None:
                        raise CatalogError(
                            f"Role untuk agent lama '{str(name)[:40]}' tidak diketahui; gunakan format katalog baru."
                        )
                    raw_agents.append(
                        {
                            "id": normalize_name(name),
                            "name": name,
                            "uuid": value,
                            "role": role,
                        }
                    )
                updated_at = ""
            else:
                raise CatalogError("Format katalog tidak dikenal.")
            self._set_agents(raw_agents, updated_at)
        except (OSError, json.JSONDecodeError) as exc:
            raise CatalogError(f"Katalog tidak bisa dibaca: {self.path.name}.") from exc

    def _set_agents(self, raw_agents: Any, updated_at: Any) -> None:
        if not isinstance(raw_agents, list) or not 1 <= len(raw_agents) <= 200:
            raise CatalogError("Jumlah agent tidak valid.")
        agents = tuple(_validated_agent(raw) for raw in raw_agents)
        for field in ("id", "name", "uuid"):
            values = [normalize_name(getattr(a, field)) for a in agents]
            if len(values) != len(set(values)):
                raise CatalogError(f"Katalog berisi {field} duplikat.")
        if not isinstance(updated_at, str) or len(updated_at) > 40:
            updated_at = ""
        with self._lock:
            self.agents = agents
            self.updated_at = updated_at

    def _payload(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "updated_at": self.updated_at,
            "source": API_URL,
            "agents": [asdict(agent) for agent in self.agents],
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "agents": [agent.public_dict() for agent in self.agents],
                "updated_at": self.updated_at,
                "count": len(self.agents),
                "source": API_URL,
            }

    def get(self, agent_id: str) -> Agent:
        with self._lock:
            for agent in self.agents:
                if agent.id == agent_id:
                    return agent
        raise CatalogError("Agent tidak ada di katalog. Muat ulang daftar agent.")

    def find(self, name: str) -> Agent:
        key = normalize_name(name)
        aliases = {"phoenix": "phoenix", "pheonix": "phoenix", "kayo": "kayo"}
        key = aliases.get(key, key)
        with self._lock:
            for agent in self.agents:
                if normalize_name(agent.name) == key or agent.id == key:
                    return agent
        raise CatalogError(f"Agent '{name[:40]}' tidak ditemukan.")

    def merge_remote(self, payload: Any) -> tuple[Agent, ...]:
        if not isinstance(payload, dict) or payload.get("status") != 200:
            raise CatalogError("API agent mengembalikan respons yang tidak valid.")
        raw_agents = payload.get("data")
        if not isinstance(raw_agents, list) or not 1 <= len(raw_agents) <= 200:
            raise CatalogError("Data agent dari API kosong atau tidak valid.")
        incoming = [
            _validated_agent(raw, remote=True)
            for raw in raw_agents
            if isinstance(raw, dict) and raw.get("isPlayableCharacter") is True
        ]
        if not incoming:
            raise CatalogError("API tidak mengembalikan agent yang bisa dimainkan.")
        merged: dict[str, Agent] = {}
        with self._lock:
            by_uuid = {agent.uuid: agent for agent in self.agents}
            # A temporarily incomplete API response must not remove our verified agents.
            for agent in (*self.agents, *incoming):
                previous = by_uuid.get(agent.uuid)
                if previous and not agent.release_date:
                    agent = Agent(
                        **{**asdict(agent), "release_date": previous.release_date}
                    )
                merged[agent.uuid] = agent
            result = tuple(merged.values())
        if len(result) > 200:
            raise CatalogError("Katalog hasil penggabungan terlalu besar.")
        for field in ("id", "name"):
            values = [normalize_name(getattr(agent, field)) for agent in result]
            if len(values) != len(set(values)):
                raise CatalogError(
                    f"API mengembalikan {field} agent duplikat; katalog lama tetap dipakai."
                )
        return result

    def refresh(self, fetch: Callable[[], Any] | None = None) -> dict[str, Any]:
        if not self._refresh_lock.acquire(blocking=False):
            raise CatalogError("Pembaruan katalog sedang berjalan.")
        temporary: Path | None = None
        try:
            payload = fetch() if fetch else fetch_remote_payload()
            agents = self.merge_remote(payload)
            with self._lock:
                previous_agents, previous_date = self.agents, self.updated_at
                self.agents = agents
                self.updated_at = date.today().isoformat()
                payload_to_save = self._payload()
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    dir=self.path.parent,
                    prefix=".agents-",
                    suffix=".tmp",
                    delete=False,
                ) as handle:
                    temporary = Path(handle.name)
                    json.dump(payload_to_save, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            except OSError:
                with self._lock:
                    self.agents, self.updated_at = previous_agents, previous_date
                raise CatalogError(
                    "Katalog tidak bisa disimpan. Periksa izin folder aplikasi."
                )
            return {
                **self.snapshot(),
                "message": f"{len(agents)} agent tersedia. Katalog terbaru sudah disimpan.",
            }
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            self._refresh_lock.release()


def fetch_remote_payload() -> Any:
    request = urllib.request.Request(
        API_URL,
        headers={"Accept": "application/json", "User-Agent": "val-instalock/2.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise CatalogError(
                    "API agent sedang tidak tersedia. Katalog lokal tetap dipakai."
                )
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CatalogError(
            "Tidak bisa menghubungi API agent. Katalog lokal tetap dipakai."
        ) from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise CatalogError("Respons API terlalu besar; pembaruan dibatalkan.")
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CatalogError(
            "Respons API bukan JSON yang valid; katalog lama tetap aman."
        ) from exc
