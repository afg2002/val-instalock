import json
import threading
import time
import unittest
import urllib.error
import urllib.request

from val_instalock.catalog import AgentCatalog
from val_instalock.server import create_server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(port=0, demo=True, catalog=AgentCatalog())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.service.close()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=1)

    def request(self, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.url + path, data=data, headers=headers or {}
        )
        if body is not None:
            request.add_header("Content-Type", "application/json")
            if not any(key.lower() == "x-csrf-token" for key in request.headers):
                request.add_header("X-CSRF-Token", self.server.csrf)
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(
                response.read()
            ) if "json" in response.headers.get("Content-Type", "") else response.read()

    def test_bootstrap_and_static_assets(self):
        status, data = self.request("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertTrue(data["demo"])
        self.assertEqual(data["catalog"]["count"], 30)
        self.assertTrue(data["csrf"])
        for path in (
            "/",
            "/styles.css",
            "/app.js",
            "/assets/agents/hush.webp",
            "/assets/favicon.svg",
        ):
            with urllib.request.urlopen(self.url + path) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())

    def test_mutations_require_csrf(self):
        status, data = self.request(
            "/api/start", {"agent_id": "hush"}, headers={"X-CSRF-Token": "wrong"}
        )
        self.assertEqual(status, 403)
        self.assertFalse(self.server.service.snapshot()["active"])

    def test_cross_origin_mutations_are_rejected(self):
        status, _ = self.request(
            "/api/start",
            {"agent_id": "hush"},
            headers={
                "X-CSRF-Token": self.server.csrf,
                "Origin": "https://evil.example",
            },
        )
        self.assertEqual(status, 403)

    def test_dns_rebinding_host_is_rejected(self):
        request = urllib.request.Request(
            self.url + "/api/bootstrap", headers={"Host": "evil.example"}
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 403)

    def test_invalid_agent_and_region_are_rejected(self):
        for body in (
            {"agent_id": "missing"},
            {"agent_id": "hush", "region": "unknown"},
            {"agent_id": None},
        ):
            status, _ = self.request("/api/start", body)
            self.assertEqual(status, 409)

    def test_invalid_json_is_rejected(self):
        request = urllib.request.Request(
            self.url + "/api/start",
            data=b"not-json",
            headers={
                "Content-Type": "application/json",
                "X-CSRF-Token": self.server.csrf,
            },
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 400)

    def test_demo_refresh_is_local_and_explicit(self):
        status, data = self.request("/api/refresh", {})
        self.assertEqual(status, 200)
        self.assertIn("Demo", data["message"])
        self.assertEqual(data["count"], 30)

    def test_start_and_stop_endpoints(self):
        deadline = time.monotonic() + 2
        while (
            self.server.service.snapshot()["stopping"] and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        try:
            status, data = self.request(
                "/api/start", {"agent_id": "hush", "region": "ap"}
            )
            self.assertEqual(status, 200)
            self.assertTrue(data["demo"])
            self.assertTrue(data["active"])
        finally:
            status, data = self.request("/api/stop", {})
        self.assertEqual(status, 200)
        self.assertFalse(data["active"])

    def test_live_server_cannot_bind_public_interface(self):
        with self.assertRaises(ValueError):
            create_server(host="0.0.0.0", port=0, demo=False)

    def test_directory_traversal_is_not_served(self):
        for path in (
            "/../agents.json",
            "/%2e%2e/agents.json",
            "/assets/../../../etc/passwd",
        ):
            request = urllib.request.Request(self.url + path)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
