import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from val_instalock.gateway import (
    AgentUnavailable,
    GatewayError,
    NotInPregame,
    Pregame,
    ValorantGateway,
)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.gateway = ValorantGateway("ap")
        self.gateway._puuid = "own-player"
        self.gateway._base = "https://glz-ap-1.ap.a.pvp.net"
        self.gateway._session = Mock()
        self.agent_id = "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04"
        self.stop = threading.Event()

    def response(self, status=200, data=None):
        return SimpleNamespace(status_code=status, json=lambda: data)

    def match(self, state="", character="", teammate_state=""):
        return {
            "ID": "match-1",
            "AllyTeam": {
                "Players": [
                    {
                        "Subject": "own-player",
                        "CharacterID": character,
                        "CharacterSelectionState": state,
                    },
                    {
                        "Subject": "teammate",
                        "CharacterID": self.agent_id,
                        "CharacterSelectionState": teammate_state,
                    },
                ]
            },
        }

    def test_pregame_lookup_uses_one_match_id_for_snapshot(self):
        self.gateway._session.request.side_effect = [
            self.response(data={"MatchID": "match-1"}),
            self.response(data=self.match()),
        ]
        result = self.gateway.fetch_pregame(self.agent_id, self.stop)
        self.assertEqual(result.match_id, "match-1")
        self.assertEqual(result.agent_id, self.agent_id)
        self.assertEqual(self.gateway._session.request.call_count, 2)
        self.assertEqual(
            self.gateway._session.request.call_args.kwargs["timeout"], (3, 5)
        )

    def test_no_pregame_is_normal(self):
        self.gateway._session.request.return_value = self.response(404)
        with self.assertRaises(NotInPregame):
            self.gateway.fetch_pregame(self.agent_id, self.stop)

    def test_locked_teammate_is_detected(self):
        self.gateway._session.request.side_effect = [
            self.response(data={"MatchID": "match-1"}),
            self.response(data=self.match(teammate_state="locked")),
        ]
        self.assertTrue(
            self.gateway.fetch_pregame(self.agent_id, self.stop).locked_by_teammate
        )

    def test_lock_requires_server_confirmation(self):
        self.gateway._session.request.return_value = self.response(
            data=self.match("locked", self.agent_id)
        )
        self.gateway.lock(
            self.agent_id, Pregame("match-1", self.agent_id, "", False), self.stop
        )
        call = self.gateway._session.request.call_args
        self.assertEqual(
            call.args,
            (
                "POST",
                f"https://glz-ap-1.ap.a.pvp.net/pregame/v1/matches/match-1/lock/{self.agent_id}",
            ),
        )

    def test_empty_lock_response_uses_read_only_confirmation_not_second_post(self):
        self.gateway._session.request.side_effect = [
            self.response(data={}),
            self.response(data=self.match("locked", self.agent_id)),
        ]
        self.gateway.lock(
            self.agent_id, Pregame("match-1", self.agent_id, "", False), self.stop
        )
        methods = [
            call.args[0] for call in self.gateway._session.request.call_args_list
        ]
        self.assertEqual(methods, ["POST", "GET"])

    def test_unconfirmed_lock_stops(self):
        self.gateway._session.request.return_value = self.response(
            data=self.match("", "")
        )
        with self.assertRaises(AgentUnavailable):
            self.gateway.lock(
                self.agent_id, Pregame("match-1", self.agent_id, "", False), self.stop
            )
        self.assertEqual(self.gateway._session.request.call_count, 2)

    def test_cancelled_lock_never_sends_request(self):
        self.stop.set()
        self.gateway.lock(
            self.agent_id, Pregame("match-1", self.agent_id, "", False), self.stop
        )
        self.gateway._session.request.assert_not_called()

    def test_bad_response_and_mismatched_match_are_rejected(self):
        self.gateway._session.request.side_effect = [
            self.response(data={"MatchID": "match-1"}),
            self.response(data={**self.match(), "ID": "other-match"}),
        ]
        with self.assertRaises(GatewayError):
            self.gateway.fetch_pregame(self.agent_id, self.stop)

    def test_taken_agent_error_is_not_retried(self):
        self.gateway._session.request.return_value = self.response(400)
        with self.assertRaises(AgentUnavailable):
            self.gateway.fetch_pregame(self.agent_id, self.stop)
        self.assertEqual(self.gateway._session.request.call_count, 1)

    def test_missing_own_player_does_not_send_lock(self):
        self.gateway._session.request.side_effect = [
            self.response(data={"MatchID": "match-1"}),
            self.response(data={"ID": "match-1", "AllyTeam": {"Players": []}}),
        ]
        with self.assertRaises(GatewayError):
            self.gateway.fetch_pregame(self.agent_id, self.stop)
        self.assertEqual(self.gateway._session.request.call_count, 2)

    def test_network_errors_do_not_expose_headers(self):
        self.gateway._session.request.side_effect = TimeoutError("secret details")
        with self.assertRaises(GatewayError) as caught:
            self.gateway.fetch_pregame(self.agent_id, self.stop)
        self.assertNotIn("secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
