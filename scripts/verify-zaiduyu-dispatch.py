"""Offline regressions for Zaiduyu's real transport and explicit model selection.
Run: python -B scripts/verify-zaiduyu-dispatch.py [path/to/generate.py]
Every network operation is intercepted; no credentials, generation or file cleanup.
"""
from __future__ import annotations
import email.message
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
TARGET = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "skills/zaiduyu-imagegen/scripts/generate.py"
SPEC = importlib.util.spec_from_file_location("offline_zaiduyu_transport", TARGET)
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)

COOKIE = "offline-session=not-a-real-credential"
WORKER = "https://worker.example.com"
MODEL = "offline-image-model"


def headers(**values):
    result = email.message.Message()
    for key, value in values.items():
        result[key.replace("_", "-")] = value
    return result


class Wire:
    def __init__(self, allocation=None, node_status=200, node_headers=None, fail_allocation=False, fail_node=False):
        self.allocation = allocation if allocation is not None else {"enabled": True, "origin": WORKER, "ticket": "OFFLINE-TICKET"}
        self.node_status = node_status
        self.node_headers = node_headers or headers()
        self.fail_allocation = fail_allocation
        self.fail_node = fail_node
        self.calls = []

    def request(self, method, url, body=None, request_headers=None, timeout=30):
        self.calls.append({"method": method, "url": url, "body": body, "headers": dict(request_headers or {}), "timeout": timeout})
        if url == m.BASE + "/api/compute-route":
            if self.fail_allocation:
                raise m.ApiError("offline allocation timeout", uncertain=True)
            if isinstance(self.allocation, tuple):
                status, value = self.allocation
                return status, json.dumps(value).encode(), headers()
            return 200, json.dumps(self.allocation).encode(), headers()
        if url.startswith(WORKER + "/") or (isinstance(self.allocation, dict) and self.allocation.get("enabled") is False):
            if self.fail_node:
                raise m.ApiError("offline worker timeout", uncertain=True)
            return self.node_status, json.dumps({"error": {"message": "offline upstream error"}} if self.node_status != 200 else {}).encode(), self.node_headers
        # Real site behavior for direct requests lacking compute allocation.
        return 409, json.dumps({"message": "请刷新页面以获取服务器分配"}, ensure_ascii=False).encode(), headers()


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.old_request = m._request
        self.old_extract = m.extract_images
        self.old_sleep = m.time.sleep
        m.extract_images = lambda _value, _cookie, _timeout: [b"OFFLINE-IMAGE"]
        m.time.sleep = lambda _seconds: self.fail("unexpected retry/sleep")

    def tearDown(self):
        m._request = self.old_request
        m.extract_images = self.old_extract
        m.time.sleep = self.old_sleep

    def install(self, wire):
        m._request = wire.request
        return wire

    def generate(self, config=None):
        return m._direct_generate_batch(COOKIE, {"model": MODEL, "prompt": "offline icon", "n": 1}, 60, 3, config or {})

    def check_dispatch(self, wire, path):
        self.assertEqual(len(wire.calls), 2)
        allocation, submission = wire.calls
        self.assertEqual(allocation["url"], m.BASE + "/api/compute-route")
        self.assertEqual(allocation["headers"].get("Cookie"), COOKIE)
        value = json.loads(allocation["body"])
        self.assertEqual(value["path"], path)
        self.assertEqual(value["model"], MODEL)
        self.assertTrue(value["requestId"])
        self.assertEqual(submission["url"], WORKER + path)
        self.assertEqual(submission["headers"].get("X-Qx-Compute-Ticket"), "OFFLINE-TICKET")
        self.assertEqual(submission["headers"].get("X-Qx-Request-Id"), value["requestId"])
        self.assertEqual(submission["headers"].get("Idempotency-Key"), value["requestId"])
        for name in submission["headers"]:
            self.assertNotIn(name.lower(), m.SENSITIVE_HEADERS, "site credentials must never reach a worker")
        self.assertEqual(submission["method"], "POST")
        return submission

    def test_images_allocate_before_exactly_one_generation(self):
        wire = self.install(Wire())
        self.assertEqual(self.generate(), [b"OFFLINE-IMAGE"])
        self.check_dispatch(wire, "/api/openai/v1/images/generations")

    def test_custom_chat_payload_keeps_model_and_image_routing_header(self):
        wire = self.install(Wire())
        config = {"modelImageRouting": {MODEL: {"mode": "custom", "generation": {"protocol": "openai-chat", "path": "chat/completions"}}}}
        self.generate(config)
        submitted = self.check_dispatch(wire, "/api/openai/v1/images/generations")
        self.assertEqual(submitted["headers"].get("X-Image-Routing"), "1")
        self.assertEqual(json.loads(submitted["body"])["model"], MODEL)

    def test_multipart_edit_retains_every_reference_and_body_boundary(self):
        wire = self.install(Wire())
        refs = [m.ReferenceImage("one.png", b"OFFLINE-ONE", "image/png"), m.ReferenceImage("two.png", b"OFFLINE-TWO", "image/png")]
        m._edit_request_once(COOKIE, refs, "offline edit", "1024x1024", MODEL, 60, 3, {})
        submitted = self.check_dispatch(wire, "/api/openai/v1/images/edits")
        self.assertIn("multipart/form-data; boundary=", submitted["headers"]["Content-Type"])
        self.assertIn(b"OFFLINE-ONE", submitted["body"])
        self.assertIn(b"OFFLINE-TWO", submitted["body"])
        self.assertEqual(submitted["body"].count(b'name="image[]"'), 2)

    def test_json_edit_uses_same_allocation_contract(self):
        wire = self.install(Wire())
        refs = [m.ReferenceImage("one.png", b"OFFLINE-ONE", "image/png")]
        config = {"modelImageRouting": {MODEL: {"mode": "custom", "edit": {"protocol": "openai-images", "path": "images/edits"}}}}
        m._edit_request_once(COOKIE, refs, "offline edit", "1024x1024", MODEL, 60, 3, config)
        submitted = self.check_dispatch(wire, "/api/openai/v1/images/edits")
        self.assertEqual(len(json.loads(submitted["body"])["images"]), 1)

    def test_only_explicit_disabled_dispatch_permits_same_origin_request(self):
        wire = self.install(Wire(allocation={"enabled": False}))
        self.generate()
        self.assertEqual(len(wire.calls), 2)
        self.assertEqual(wire.calls[1]["url"], m.BASE + "/api/openai/v1/images/generations")
        self.assertEqual(wire.calls[1]["headers"].get("Cookie"), COOKIE)
        self.assertNotIn("X-Qx-Compute-Ticket", wire.calls[1]["headers"])

    def test_bad_worker_origins_stop_before_any_generation(self):
        for origin in ["http://worker.example.com", "https://a:b@worker.example.com", WORKER + "/bad", WORKER + "?q=1", WORKER + "#frag", "https://127.0.0.1", "https://10.0.0.1", "https://localhost", "https://worker.local"]:
            with self.subTest(origin=origin):
                wire = self.install(Wire(allocation={"enabled": True, "origin": origin, "ticket": "OFFLINE-TICKET"}))
                with self.assertRaises(m.ApiError):
                    self.generate()
                self.assertEqual(len(wire.calls), 1)
                self.assertEqual(wire.calls[0]["url"], m.BASE + "/api/compute-route")

    def test_empty_or_header_injecting_tickets_stop_before_generation(self):
        for ticket in ["", " \t", "bad\r\nCookie: injected", None, False]:
            with self.subTest(ticket=ticket):
                wire = self.install(Wire(allocation={"enabled": True, "origin": WORKER, "ticket": ticket}))
                with self.assertRaises(m.ApiError):
                    self.generate()
                self.assertEqual(len(wire.calls), 1)
                self.assertEqual(wire.calls[0]["url"], m.BASE + "/api/compute-route")

    def test_allocation_409_is_not_login_failure_and_does_not_submit(self):
        wire = self.install(Wire(allocation=(409, {"message": "请刷新页面以获取服务器分配"})))
        with self.assertRaises(m.ApiError) as caught:
            self.generate()
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(getattr(caught.exception, "phase", None), "allocation")
        self.assertFalse(getattr(caught.exception, "submitted", True))
        self.assertEqual(len(wire.calls), 1)
        self.assertNotIn("重新登录", str(caught.exception))

    def test_allocation_timeout_never_becomes_a_paid_retry(self):
        wire = self.install(Wire(fail_allocation=True))
        with self.assertRaises(m.ApiError) as caught:
            self.generate()
        self.assertFalse(getattr(caught.exception, "submitted", True))
        self.assertEqual(getattr(caught.exception, "phase", None), "allocation")
        self.assertIn("未提交", str(caught.exception))
        self.assertEqual(len(wire.calls), 1)

    def test_worker_timeout_is_unknown_and_never_resubmitted(self):
        wire = self.install(Wire(fail_node=True))
        with self.assertRaises(m.ApiError) as caught:
            self.generate()
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(len(wire.calls), 2)
        self.assertIn("未自动重投", str(caught.exception))

    def test_worker_failure_never_retries_or_changes_model(self):
        for status in [409, 429, 500, 502, 503]:
            with self.subTest(status=status):
                wire = self.install(Wire(node_status=status, node_headers=headers(X_Qx_Route_Retry="1")))
                with self.assertRaises(m.ApiError):
                    self.generate()
                self.assertEqual(len(wire.calls), 2)
                self.assertEqual(json.loads(wire.calls[1]["body"])["model"], MODEL)

    def test_raw_python_cannot_choose_site_or_first_default_model(self):
        catalog = [{"model": MODEL, "enabled": True}, {"model": "more-expensive", "enabled": True}]
        with self.assertRaises(SystemExit):
            m.resolve_model(catalog, None, {"defaultModel": "more-expensive"})

    def test_explicit_model_still_resolves_without_changing_site_default(self):
        config = {"defaultModel": "more-expensive"}
        catalog = [{"model": MODEL, "enabled": True}, {"model": "more-expensive", "enabled": True}]
        self.assertEqual(m.resolve_model(catalog, MODEL, config)["model"], MODEL)
        self.assertEqual(config["defaultModel"], "more-expensive")

    def test_missing_model_main_stops_before_login(self):
        old_argv, old_login = sys.argv, m.login
        try:
            sys.argv = [str(TARGET), "--prompt", "offline icon"]
            m.login = lambda *_: self.fail("missing model must not login")
            with self.assertRaises(SystemExit):
                m.main()
        finally:
            sys.argv, m.login = old_argv, old_login

    def test_async_uncertain_409_never_falls_back_to_another_paid_post(self):
        replacements = {
            "login": lambda *_: COOKIE,
            "get_site_config": lambda *_: {},
            "get_credits": lambda *_: {},
            "build_model_catalog": lambda *_: [{"model": MODEL, "enabled": True}],
            "load_reference_images": lambda *_: [],
            "print_request_preflight": lambda *_args, **_kwargs: None,
            "check_request_balance": lambda *_: None,
            "image_route_kind": lambda *_: "images",
            "generation_payload": lambda *_: {"model": MODEL, "prompt": "offline icon"},
            "direct_generate": lambda *_: self.fail("ambiguous async job must not create a second paid request"),
        }
        def pending(*_args):
            raise m.ApiError("offline pending job polling returned 409", 409, uncertain=True)
        replacements["async_generate"] = pending
        old = {name: getattr(m, name) for name in replacements}
        old_argv = sys.argv
        try:
            for name, value in replacements.items():
                setattr(m, name, value)
            sys.argv = [str(TARGET), "--async", "--model", MODEL, "--prompt", "offline icon"]
            with self.assertRaises(m.ApiError) as caught:
                m.main()
            self.assertTrue(caught.exception.uncertain)
        finally:
            sys.argv = old_argv
            for name, value in old.items():
                setattr(m, name, value)

    def test_disabled_or_unknown_requested_model_stops(self):
        for requested in [MODEL, "missing-image"]:
            with self.subTest(model=requested):
                with self.assertRaises(SystemExit):
                    m.resolve_model([{"model": MODEL, "enabled": False}], requested, {})


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
