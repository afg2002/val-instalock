import threading
import time
import unittest

from val_instalock.catalog import AgentCatalog
from val_instalock.gateway import GatewayError, NotInPregame, Pregame
from val_instalock.service import LockService, ServiceError


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Timed out waiting for worker state")


class FakeGateway:
    def __init__(
        self,
        *,
        pregame=None,
        error=None,
        connect_error=None,
        lock_error=None,
        block=False,
    ):
        self.pregame = pregame
        self.error = error
        self.connect_error = connect_error
        self.lock_error = lock_error
        self.block = block
        self.calls = []
        self.lock_started = threading.Event()
        self.allow_lock = threading.Event()
        self.fetch_started = threading.Event()
        self.allow_fetch = threading.Event()
        self.closed = threading.Event()

    def connect(self, stop):
        self.calls.append("connect")
        if self.connect_error:
            raise self.connect_error

    def fetch_pregame(self, agent_id, stop):
        self.calls.append("fetch")
        self.fetch_started.set()
        if self.block:
            while not stop.is_set() and not self.allow_fetch.wait(0.01):
                pass
        if stop.is_set():
            raise NotInPregame()
        if self.error:
            raise self.error
        if self.pregame is None:
            raise NotInPregame()
        return self.pregame

    def lock(self, agent_id, pregame, stop):
        if stop.is_set():
            return
        self.calls.append("lock")
        self.lock_started.set()
        if self.block:
            while not stop.is_set() and not self.allow_lock.wait(0.01):
                pass
        if stop.is_set():
            return
        if self.lock_error:
            raise self.lock_error

    def close(self):
        self.closed.set()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.catalog = AgentCatalog()
        self.agent = self.catalog.find("Hush")
        self.services = []

    def tearDown(self):
        for service in self.services:
            service.close()
            if service._thread:
                service._thread.join(timeout=1)

    def service(self, gateway, **kwargs):
        service = LockService(
            self.catalog,
            gateway_factory=lambda region: gateway,
            poll_interval=0.01,
            **kwargs,
        )
        self.services.append(service)
        return service

    def pregame(self, **kwargs):
        values = {
            "match_id": "match-1",
            "agent_id": self.agent.uuid,
            "own_state": "",
            "locked_by_teammate": False,
        }
        return Pregame(**{**values, **kwargs})

    def test_successful_lock_once_then_stops(self):
        gateway = FakeGateway(pregame=self.pregame())
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "locked")
        self.assertEqual(gateway.calls.count("lock"), 1)
        self.assertFalse(service.snapshot()["active"])
        self.assertTrue(gateway.closed.is_set())

    def test_already_locked_by_self_never_sends_post(self):
        gateway = FakeGateway(pregame=self.pregame(own_state="locked_requested"))
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "locked")
        self.assertNotIn("lock", gateway.calls)

    def test_teammate_lock_is_respected(self):
        gateway = FakeGateway(pregame=self.pregame(locked_by_teammate=True))
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "error")
        self.assertNotIn("lock", gateway.calls)
        self.assertIn("pemain lain", service.snapshot()["message"])

    def test_other_own_locked_agent_is_not_overwritten(self):
        gateway = FakeGateway(pregame=self.pregame(own_state="locked"))
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "error")
        self.assertNotIn("lock", gateway.calls)

    def test_stop_prevents_lock(self):
        gateway = FakeGateway(pregame=self.pregame(), block=True)
        service = self.service(gateway)
        service.start(self.agent.id)
        self.assertTrue(gateway.fetch_started.wait(1))
        service.stop()
        gateway.allow_fetch.set()
        wait_for(lambda: gateway.closed.is_set())
        self.assertNotIn("lock", gateway.calls)
        self.assertEqual(service.snapshot()["state"], "stopped")

    def test_stop_during_inflight_request_disables_new_locks(self):
        gateway = FakeGateway(pregame=self.pregame(), block=True)
        gateway.allow_fetch.set()
        service = self.service(gateway)
        service.start(self.agent.id)
        self.assertTrue(gateway.lock_started.wait(1))
        service.stop()
        wait_for(lambda: gateway.closed.is_set())
        snapshot = service.snapshot()
        self.assertEqual(snapshot["state"], "stopped")
        self.assertFalse(snapshot["active"])
        wait_for(lambda: not service.snapshot()["stopping"])
        self.assertFalse(snapshot["stopping"])
        # Once the in-flight worker has actually exited, a new match can be armed.
        service.start("jett")
        self.assertEqual(service.snapshot()["agent_id"], "jett")
        service.stop()

    def test_no_retry_after_ambiguous_lock_failure(self):
        gateway = FakeGateway(
            pregame=self.pregame(), lock_error=GatewayError("timeout")
        )
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "error")
        self.assertEqual(gateway.calls.count("lock"), 1)

    def test_invalid_input_does_not_start_thread(self):
        gateway = FakeGateway()
        service = self.service(gateway)
        for agent, region in (
            ("unknown", "ap"),
            (self.agent.id, "invalid"),
            (None, "ap"),
        ):
            with self.assertRaises(ServiceError):
                service.start(agent, region)
        self.assertEqual(gateway.calls, [])

    def test_connection_error_is_actionable_and_stops(self):
        gateway = FakeGateway(
            connect_error=GatewayError("Buka VALORANT terlebih dahulu.")
        )
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "error")
        self.assertIn("Buka VALORANT", service.snapshot()["message"])
        self.assertTrue(gateway.closed.is_set())

    def test_gateway_factory_error_does_not_leave_active_worker(self):
        def broken_factory(region):
            raise RuntimeError("constructor failed")

        service = LockService(self.catalog, gateway_factory=broken_factory)
        self.services.append(service)
        service.start(self.agent.id)
        wait_for(lambda: not service.snapshot()["active"])
        self.assertEqual(service.snapshot()["state"], "error")

    def test_unexpected_errors_do_not_leak_internals(self):
        gateway = FakeGateway(error=RuntimeError("SECRET-TOKEN should not appear"))
        service = self.service(gateway)
        service.start(self.agent.id)
        wait_for(lambda: service.snapshot()["state"] == "error")
        self.assertNotIn("SECRET-TOKEN", str(service.snapshot()))

    def test_duplicate_start_is_rejected(self):
        gateway = FakeGateway()
        service = self.service(gateway)
        service.start(self.agent.id)
        with self.assertRaises(ServiceError):
            service.start("jett")
        self.assertEqual(gateway.calls.count("connect"), 1)

    def test_demo_is_labelled_and_cancellable(self):
        service = LockService(self.catalog, demo=True)
        self.services.append(service)
        service.start(self.agent.id, "ap")
        self.assertTrue(service.snapshot()["demo"])
        self.assertIn("Simulasi", service.snapshot()["message"])
        service.stop()
        wait_for(lambda: not service.snapshot()["stopping"])
        self.assertEqual(service.snapshot()["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
