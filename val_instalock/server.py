"""Local-only HTTP server for the GUI. No Electron, Node, or build step required."""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from . import __version__
from .catalog import AgentCatalog, CatalogError, DEFAULT_CATALOG
from .gateway import REGIONS
from .service import LockService, ServiceError

STATIC = Path(__file__).resolve().parent.parent / "static"
MAX_BODY_BYTES = 4096


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, *, catalog, demo):
        super().__init__(address, handler)
        self.catalog = catalog
        self.service = LockService(catalog, demo=demo)
        self.demo = demo
        self.csrf = secrets.token_urlsafe(32)
        self.refresh_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server: LocalServer
    server_version = "ValInstalock/2.0"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        # Do not log request URLs, account identifiers, or local client credentials.
        pass

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' https://media.valorant-api.com; font-src 'self'; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
        )

    def _send(
        self, status: int, body: bytes, content_type: str, *, cache: bool = False
    ):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Cache-Control", "public, max-age=3600" if cache else "no-store"
        )
        self._security_headers()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, data: dict):
        self._send(
            status,
            json.dumps(data, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _host_allowed(self) -> bool:
        try:
            hostname = urlsplit("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        if hostname in ("127.0.0.1", "localhost", "::1"):
            return True
        # Only the explicitly non-live demo can be served through Arena's HTTPS proxy.
        return bool(self.server.demo and hostname and hostname.endswith(".e2b.app"))

    def _authorized(self) -> bool:
        origin = self.headers.get("Origin")
        if origin:
            try:
                parsed = urlsplit(origin)
            except ValueError:
                return False
            if parsed.netloc.lower() != self.headers.get(
                "Host", ""
            ).lower() or parsed.scheme not in ("http", "https"):
                return False
        supplied = self.headers.get("X-CSRF-Token", "")
        return hmac.compare_digest(supplied, self.server.csrf)

    def do_GET(self):
        if not self._host_allowed():
            self._json(403, {"error": "Host tidak diizinkan."})
            return
        path = unquote(urlsplit(self.path).path)
        if path == "/api/bootstrap":
            self._json(
                200,
                {
                    "version": __version__,
                    "demo": self.server.demo,
                    "csrf": self.server.csrf,
                    "catalog": self.server.catalog.snapshot(),
                    "status": self.server.service.snapshot(),
                    "regions": [
                        {"id": key, "name": value[0]} for key, value in REGIONS.items()
                    ],
                },
            )
            return
        if path == "/api/status":
            self._json(200, self.server.service.snapshot())
            return
        if path == "/api/catalog":
            self._json(200, self.server.catalog.snapshot())
            return
        if path == "/":
            path = "/index.html"
        candidate = (STATIC / path.lstrip("/")).resolve()
        if not candidate.is_relative_to(STATIC.resolve()) or not candidate.is_file():
            self._json(404, {"error": "Halaman tidak ditemukan."})
            return
        content_type = (
            mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        )
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/json",
        ):
            content_type += "; charset=utf-8"
        self._send(
            200, candidate.read_bytes(), content_type, cache=path.startswith("/assets/")
        )

    def do_POST(self):
        if not self._host_allowed() or not self._authorized():
            self._json(
                403,
                {
                    "error": "Permintaan tidak diizinkan. Muat ulang GUI dari server lokal."
                },
            )
            return
        path = urlsplit(self.path).path
        if path not in ("/api/start", "/api/stop", "/api/refresh"):
            self._json(404, {"error": "Endpoint tidak ditemukan."})
            return
        if (
            self.headers.get("Content-Type", "").split(";")[0].strip()
            != "application/json"
        ):
            self._json(415, {"error": "Gunakan application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= MAX_BODY_BYTES:
                self._json(413, {"error": "Permintaan terlalu besar."})
                return
            body = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(body, dict):
                raise ValueError("object required")
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "JSON tidak valid."})
            return
        try:
            if path == "/api/start":
                result = self.server.service.start(
                    body.get("agent_id"), body.get("region", "ap")
                )
            elif path == "/api/stop":
                result = self.server.service.stop()
            else:
                if self.server.service.snapshot()["active"]:
                    raise ServiceError("Hentikan proses sebelum memperbarui katalog.")
                if self.server.demo:
                    # A demo stays deterministic and never pretends to have fetched live data.
                    self.server.catalog.load()
                    result = {
                        **self.server.catalog.snapshot(),
                        "message": "Demo: katalog lokal dimuat ulang. Refresh online tersedia di mode live.",
                    }
                else:
                    if not self.server.refresh_lock.acquire(blocking=False):
                        raise ServiceError("Pembaruan katalog sedang berjalan.")
                    try:
                        result = self.server.catalog.refresh()
                    finally:
                        self.server.refresh_lock.release()
            self._json(200, result)
        except (CatalogError, ServiceError) as exc:
            self._json(409, {"error": str(exc)})
        except Exception:
            self._json(
                500,
                {"error": "Operasi gagal. Katalog atau proses sebelumnya tetap aman."},
            )


def create_server(
    host="127.0.0.1", port=8765, *, demo=False, catalog=None
) -> LocalServer:
    if not demo and host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(
            "Mode live hanya boleh dijalankan pada loopback. Gunakan --demo untuk preview jaringan."
        )
    return LocalServer(
        (host, port), Handler, catalog=catalog or AgentCatalog(), demo=demo
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="VAL Instalock — GUI lokal dengan pilihan 30 agent."
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Simulasi eksplisit, tanpa koneksi atau lock ke akun.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Alamat bind; mode live dibatasi ke loopback.",
    )
    parser.add_argument(
        "--port", type=int, default=8765, help="Port GUI (default: 8765)."
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="Jangan buka browser otomatis."
    )
    parser.add_argument(
        "--catalog", type=Path, default=DEFAULT_CATALOG, help=argparse.SUPPRESS
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port harus antara 1 dan 65535.")
    try:
        catalog = AgentCatalog(args.catalog)
        server = create_server(args.host, args.port, demo=args.demo, catalog=catalog)
    except (ValueError, OSError, CatalogError) as exc:
        parser.exit(1, f"Tidak bisa memulai GUI: {exc}\n")
    local_url = f"http://127.0.0.1:{server.server_port}"
    print(
        f"\nVAL INSTALOCK {__version__} · {'DEMO — tidak mengunci agent sungguhan' if args.demo else 'LIVE — memakai sesi Riot lokal'}"
    )
    print(f"GUI: {local_url}\nTekan Ctrl+C untuk berhenti.\n", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(local_url)).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nMenutup aplikasi…")
    finally:
        server.service.close()
        server.server_close()


if __name__ == "__main__":
    main()
