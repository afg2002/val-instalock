import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from val_instalock.catalog import (
    AgentCatalog,
    CatalogError,
    DEFAULT_CATALOG,
    normalize_name,
)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "agents.json"
        self.path.write_bytes(DEFAULT_CATALOG.read_bytes())
        self.catalog = AgentCatalog(self.path)
        self.raw = json.loads(self.path.read_text())

    def tearDown(self):
        self.directory.cleanup()

    def remote(
        self, *, name="Future Agent", uuid="12345678-1234-4123-8123-123456789abc"
    ):
        return {
            "status": 200,
            "data": [
                {
                    "displayName": name,
                    "uuid": uuid,
                    "isPlayableCharacter": True,
                    "role": {"displayName": "Duelist"},
                    "fullPortrait": "https://media.valorant-api.com/agents/example/fullportrait.png",
                    "backgroundGradientColors": ["aabbccff"],
                }
            ],
        }

    def test_bundled_roster_has_30_unique_playable_agents(self):
        self.assertEqual(len(self.catalog.agents), 30)
        self.assertEqual(len({a.uuid for a in self.catalog.agents}), 30)
        self.assertEqual(
            {
                role: sum(a.role == role for a in self.catalog.agents)
                for role in ("Duelist", "Controller", "Initiator", "Sentinel")
            },
            {"Duelist": 9, "Controller": 7, "Initiator": 7, "Sentinel": 7},
        )

    def test_new_agent_ids(self):
        for name, expected in {
            "Hush": "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04",
            "Miks": "7c8a4701-4de6-9355-b254-e09bc2a34b72",
            "Veto": "92eeef5d-43b5-1d4a-8d03-b3927a09034b",
            "Waylay": "df1cb487-4902-002e-5c17-d28e83e78588",
            "Tejo": "b444168c-4e35-8076-db47-ef9bf368f384",
            "Vyse": "efba5359-4016-a1e5-7626-b1ae76895940",
            "Iso": "0e38b510-41a8-5780-5e8f-568b2a4f2d6c",
            "Clove": "1dbf2edd-4729-0984-3115-daa5eed44993",
        }.items():
            self.assertEqual(self.catalog.find(name).uuid, expected)

    def test_names_are_case_and_punctuation_insensitive(self):
        self.assertEqual(self.catalog.find("kay/o").name, "KAY/O")
        self.assertEqual(self.catalog.find("KAYO").name, "KAY/O")
        self.assertEqual(self.catalog.find("pheonix").name, "Phoenix")
        self.assertEqual(normalize_name("  PHOENIX "), "phoenix")
        with self.assertRaises(CatalogError):
            self.catalog.find("not-an-agent")

    def test_all_local_portraits_exist(self):
        for agent in self.catalog.agents:
            image = agent.public_dict()["image"]
            self.assertTrue(image.startswith("/assets/agents/"))
            self.assertTrue(
                (DEFAULT_CATALOG.parent / "static" / image.lstrip("/")).is_file(), image
            )

    def test_legacy_name_uuid_file_is_supported(self):
        original = {
            "Pheonix": self.catalog.find("Phoenix").uuid,
            "KAYO": self.catalog.find("KAY/O").uuid,
            "Cypher": self.catalog.find("Cypher").uuid,
        }
        self.path.write_text(json.dumps(original))
        self.catalog.load()
        self.assertEqual(self.catalog.find("Cypher").role, "Sentinel")
        self.assertEqual(self.catalog.find("KAYO").role, "Initiator")
        self.assertEqual(len(self.catalog.agents), 3)

    def test_add_future_agent_and_persist_without_losing_roster(self):
        payload = self.remote()
        result = self.catalog.refresh(lambda: payload)
        self.assertEqual(result["count"], 31)
        self.assertEqual(AgentCatalog(self.path).find("Future Agent").role, "Duelist")
        self.assertEqual(
            self.catalog.find("Hush").uuid, "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04"
        )
        self.assertFalse(list(self.path.parent.glob(".agents-*.tmp")))

    def test_partial_api_response_does_not_remove_known_agents(self):
        self.catalog.refresh(lambda: self.remote())
        self.assertEqual(len(self.catalog.agents), 31)
        self.assertIsNotNone(self.catalog.find("Jett"))

    def test_duplicate_uuid_is_merged_not_duplicated(self):
        payload = self.remote(name="Hush", uuid=self.catalog.find("Hush").uuid)
        self.catalog.refresh(lambda: payload)
        self.assertEqual(len(self.catalog.agents), 30)

    def test_bad_or_offline_refresh_keeps_previous_disk_and_memory(self):
        before = self.path.read_bytes()
        for payload in (
            {"status": 500, "data": []},
            {"status": 200, "data": []},
            {"status": 200, "data": [{"isPlayableCharacter": True}]},
        ):
            with self.assertRaises(CatalogError):
                self.catalog.refresh(lambda payload=payload: payload)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(len(self.catalog.agents), 30)

        def offline():
            raise CatalogError("offline")

        with self.assertRaises(CatalogError):
            self.catalog.refresh(offline)
        self.assertEqual(self.path.read_bytes(), before)

    def test_non_playable_characters_are_excluded(self):
        payload = self.remote()
        payload["data"].append(
            {
                **payload["data"][0],
                "uuid": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "isPlayableCharacter": False,
            }
        )
        # A non-playable entry should not even need a valid agent role.
        payload["data"][-1]["role"] = None
        self.catalog.refresh(lambda: payload)
        self.assertEqual(len(self.catalog.agents), 31)

    def test_untrusted_portrait_and_invalid_uuid_are_rejected(self):
        for field, value in (
            ("fullPortrait", "javascript:alert(1)"),
            ("fullPortrait", "https://evil.example/image.png"),
            ("uuid", "not-a-uuid"),
        ):
            payload = self.remote()
            payload["data"][0][field] = value
            with self.assertRaises(CatalogError):
                self.catalog.refresh(lambda payload=payload: payload)
        self.assertEqual(len(self.catalog.agents), 30)

    def test_duplicate_ids_are_rejected_on_load(self):
        raw = copy.deepcopy(self.raw)
        raw["agents"].append(raw["agents"][0])
        self.path.write_text(json.dumps(raw))
        with self.assertRaises(CatalogError):
            self.catalog.load()
        self.assertEqual(len(self.catalog.agents), 30)

    def test_remote_duplicate_name_with_different_uuid_is_rejected(self):
        payload = self.remote(name="Jett")
        with self.assertRaises(CatalogError):
            self.catalog.refresh(lambda: payload)
        self.assertEqual(len(self.catalog.agents), 30)

    def test_unknown_legacy_role_is_not_guessed(self):
        self.path.write_text(
            json.dumps({"Custom": "12345678-1234-4123-8123-123456789abc"})
        )
        with self.assertRaises(CatalogError):
            self.catalog.load()
        self.assertEqual(len(self.catalog.agents), 30)

    def test_failed_disk_replace_rolls_back_memory(self):
        before = self.catalog.snapshot()
        with patch(
            "val_instalock.catalog.os.replace", side_effect=PermissionError("read only")
        ):
            with self.assertRaises(CatalogError):
                self.catalog.refresh(lambda: self.remote())
        self.assertEqual(self.catalog.snapshot(), before)
        self.assertFalse(list(self.path.parent.glob(".agents-*.tmp")))


if __name__ == "__main__":
    unittest.main()
