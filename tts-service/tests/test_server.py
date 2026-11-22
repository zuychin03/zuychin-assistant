import http.client
import json
import threading
import time
import unittest

from server import SAMPLE_RATE, activation_fd, create_server, token_matches

TOKEN = "t" * 40


class FakeEngine:
    model = "fake"

    def __init__(self):
        self.calls = []
        self.gates = {}
        self.fail_on = None

    def synthesize(self, sentence, voice):
        self.calls.append((sentence, voice))
        gate = self.gates.get(sentence)
        if gate:
            gate.wait(5)
        if self.fail_on and self.fail_on in sentence:
            raise RuntimeError("boom")
        return bytes([len(sentence) % 250 + 1, 0]) * 400


def pcm_for(sentence):
    return bytes([len(sentence) % 250 + 1, 0]) * 400


class ServerCase(unittest.TestCase):
    engine = None
    options = {}

    def setUp(self):
        self.logs = []
        self.fake = FakeEngine() if self.engine is None else self.engine
        self.server = create_server(TOKEN, engine=self.fake, log=self.logs.append, **self.options)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, method="POST", path="/speak", body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        base = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
        base.update(headers or {})
        base = {k: v for k, v in base.items() if v is not None}
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        conn.request(method, path, body=data, headers=base)
        return conn, conn.getresponse()

    def speak(self, body, **kwargs):
        conn, res = self.request(body=body, **kwargs)
        data = res.read()
        conn.close()
        return res, data

    # The server logs a reply after its last byte is sent, so the client can finish reading first.
    def wait_for_log(self, event, timeout=3):
        deadline = time.time() + timeout
        while time.time() < deadline:
            entries = [e for e in self.logs if e.get("event") == event]
            if entries:
                return entries
            time.sleep(0.02)
        self.fail(f"no {event!r} log entry within {timeout} s")


class HealthAndAuthTests(ServerCase):
    def test_health_needs_no_token_and_shows_no_secrets(self):
        conn, res = self.request("GET", "/health", headers={"Authorization": None})
        body = json.loads(res.read())
        conn.close()
        self.assertEqual(res.status, 200)
        self.assertEqual(body, {"ok": True, "model": "fake", "loaded": True, "busy": False, "waiting": 0})

    def test_wrong_and_missing_tokens_are_refused(self):
        for header in ({"Authorization": "Bearer wrong"}, {"Authorization": None}, {"Authorization": "Basic abc"}):
            res, _ = self.speak({"text": "Hello."}, headers=header)
            self.assertEqual(res.status, 401)
        self.assertEqual(self.fake.calls, [])

    def test_wrong_content_type(self):
        res, _ = self.speak(None, headers={"Content-Type": "text/plain"}, raw=b"Hello.")
        self.assertEqual(res.status, 415)

    def test_unknown_path_and_method(self):
        conn, res = self.request("GET", "/other")
        res.read()
        conn.close()
        self.assertEqual(res.status, 404)
        res, _ = self.speak({"text": "Hello."}, path="/other")
        self.assertEqual(res.status, 404)


class ValidationTests(ServerCase):
    options = {"max_chars": 60}

    def test_bad_bodies(self):
        cases = [
            (b"not json", 400, "bad_body"),
            (b'{"nope": 1}', 400, "bad_body"),
            (b'{"text": 5}', 400, "empty"),
            (b'{"text": "   "}', 400, "empty"),
            (b'{"text": "Hi.", "voice": "Kore"}', 400, "bad_voice"),
            (json.dumps({"text": "x" * 61}).encode(), 413, "too_long"),
        ]
        for raw, status, error in cases:
            res, data = self.speak(None, raw=raw)
            self.assertEqual((res.status, json.loads(data)["error"]), (status, error), raw)

    def test_oversized_body_is_refused_before_reading_it(self):
        res, data = self.speak(None, raw=b"x" * (16 * 1024 + 1))
        self.assertEqual((res.status, json.loads(data)["error"]), (413, "too_large"))

    def test_unsupported_text_is_422(self):
        res, data = self.speak({"text": "Xin chào, hôm nay bạn khỏe không?"})
        body = json.loads(data)
        self.assertEqual((res.status, body["error"], body["reason"]), (422, "unsupported_text", "not_english"))
        self.assertEqual(self.fake.calls, [])


class StreamingTests(ServerCase):
    def test_streams_pcm_with_headers(self):
        res, data = self.speak({"text": "First sentence. Second one here!", "voice": "F2"})
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("X-Sample-Rate"), str(SAMPLE_RATE))
        self.assertEqual(res.getheader("X-Voice"), "F2")
        self.assertEqual(res.getheader("Content-Type"), "application/octet-stream")
        self.assertEqual(data, pcm_for("First sentence.") + pcm_for("Second one here!"))
        self.assertEqual(self.fake.calls, [("First sentence.", "F2"), ("Second one here!", "F2")])

    def test_default_voice_is_m2(self):
        self.speak({"text": "Hello there."})
        self.assertEqual(self.fake.calls, [("Hello there.", "M2")])

    def test_first_audio_arrives_before_the_next_sentence_is_made(self):
        gate = threading.Event()
        self.fake.gates["Second one here!"] = gate
        conn, res = self.request(body={"text": "First sentence. Second one here!"})
        first = res.read(len(pcm_for("First sentence.")))
        self.assertEqual(first, pcm_for("First sentence."))
        deadline = time.time() + 3
        while time.time() < deadline and len(self.fake.calls) < 2:
            time.sleep(0.02)
        self.assertEqual([c[0] for c in self.fake.calls][:2], ["First sentence.", "Second one here!"])
        gate.set()
        self.assertEqual(res.read(), pcm_for("Second one here!"))
        conn.close()

    def test_failure_before_audio_is_a_clean_500(self):
        self.fake.fail_on = "First"
        res, data = self.speak({"text": "First sentence. Second."})
        self.assertEqual((res.status, json.loads(data)["error"]), (500, "synth_failed"))

    def test_failure_after_audio_breaks_the_stream(self):
        self.fake.fail_on = "Second"
        conn, res = self.request(body={"text": "First sentence. Second one here!"})
        self.assertEqual(res.status, 200)
        with self.assertRaises(http.client.IncompleteRead):
            res.read()
        conn.close()

    def test_closing_the_connection_stops_synthesis(self):
        text = " ".join(f"Sentence number {n} is here." for n in range(12))
        gate = threading.Event()
        self.fake.gates["Sentence number 1 is here."] = gate
        conn, res = self.request(body={"text": text})
        res.read(10)
        # The response keeps the socket open until it is closed too.
        res.close()
        conn.close()
        time.sleep(0.2)
        gate.set()
        entry = self.wait_for_log("speak")[-1]
        self.assertEqual(entry["error"], "client_closed")
        self.assertLess(len(self.fake.calls), 12)

    def test_logs_carry_sizes_and_timings_never_text(self):
        self.speak({"text": "A private sentence about the dentist."})
        entry = self.wait_for_log("speak")[0]
        self.assertNotIn("dentist", json.dumps(self.logs))
        self.assertEqual((entry["status"], entry["chars"], entry["sentences"], entry["voice"]), (200, 37, 1, "M2"))
        self.assertGreater(entry["audioSec"], 0)

    def test_rejections_log_no_text_either(self):
        self.speak({"text": "Secret words", "voice": "Kore"})
        self.wait_for_log("rejected")
        self.assertNotIn("Secret", json.dumps(self.logs))


class QueueTests(ServerCase):
    options = {"max_waiting": 1, "queue_wait_s": 0.4}

    def test_busy_after_one_running_and_one_waiting(self):
        gate = threading.Event()
        self.fake.gates["Hold this."] = gate
        results = []

        def call(text):
            res, data = self.speak({"text": text})
            results.append((text, res.status, data))

        first = threading.Thread(target=call, args=("Hold this.",))
        first.start()
        deadline = time.time() + 3
        while time.time() < deadline and not self.fake.calls:
            time.sleep(0.02)
        second = threading.Thread(target=call, args=("Wait for me.",))
        second.start()
        time.sleep(0.15)
        res, data = self.speak({"text": "Too many."})
        self.assertEqual((res.status, json.loads(data)["error"]), (503, "busy"))
        gate.set()
        first.join(5)
        second.join(5)
        statuses = {text: status for text, status, _ in results}
        self.assertEqual(statuses["Hold this."], 200)
        # The waiter may have run out its 0.4 s wait; either way it never ran two at once.
        self.assertIn(statuses["Wait for me."], (200, 503))

    def test_waiting_too_long_gives_queue_timeout(self):
        gate = threading.Event()
        self.fake.gates["Hold this."] = gate
        holder = threading.Thread(target=lambda: self.speak({"text": "Hold this."}))
        holder.start()
        deadline = time.time() + 3
        while time.time() < deadline and not self.fake.calls:
            time.sleep(0.02)
        res, data = self.speak({"text": "Next in line."})
        self.assertEqual((res.status, json.loads(data)["error"]), (503, "queue_timeout"))
        gate.set()
        holder.join(5)


class LoadingTests(unittest.TestCase):
    def test_requests_wait_for_the_model_then_succeed(self):
        server = create_server(TOKEN, engine=None, load_wait_s=3, log=lambda e: None)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_address[1]
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("GET", "/health")
            self.assertFalse(json.loads(conn.getresponse().read())["loaded"])
            threading.Timer(0.3, lambda: server.set_engine(FakeEngine())).start()
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("POST", "/speak", body=json.dumps({"text": "Hello."}), headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
            res = conn.getresponse()
            self.assertEqual((res.status, res.read()), (200, pcm_for("Hello.")))
        finally:
            server.shutdown()
            server.server_close()

    def test_503_loading_when_the_model_is_too_slow(self):
        server = create_server(TOKEN, engine=None, load_wait_s=0.2, log=lambda e: None)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            conn.request("POST", "/speak", body=json.dumps({"text": "Hello."}), headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
            res = conn.getresponse()
            self.assertEqual((res.status, json.loads(res.read())["error"]), (503, "loading"))
        finally:
            server.shutdown()
            server.server_close()


class TimeLimitTests(ServerCase):
    options = {"max_total_s": 0.0}

    def test_no_audio_before_the_limit_is_a_503(self):
        res, data = self.speak({"text": "Hello there."})
        self.assertEqual((res.status, json.loads(data)["error"]), (503, "time_limit"))


class IdleTests(unittest.TestCase):
    def test_idle_exit_fires_only_after_a_quiet_period(self):
        fired = threading.Event()
        logs = []
        server = create_server(TOKEN, engine=FakeEngine(), idle_s=0.4, on_idle=fired.set, log=logs.append)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            server.service.arm_idle()
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.request("GET", "/health")
            conn.getresponse().read()
            conn.close()
            self.assertFalse(fired.wait(0.2))
            self.assertTrue(fired.wait(2))
            self.assertIn("idle_exit", [e.get("event") for e in logs])
        finally:
            server.shutdown()
            server.server_close()

    def test_an_open_connection_blocks_idle_exit(self):
        fired = threading.Event()
        server = create_server(TOKEN, engine=FakeEngine(), idle_s=0.3, on_idle=fired.set, log=lambda e: None)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            conn.connect()
            time.sleep(0.2)
            self.assertFalse(fired.wait(0.8))
            conn.close()
            self.assertTrue(fired.wait(2))
        finally:
            server.shutdown()
            server.server_close()


class HelperTests(unittest.TestCase):
    def test_token_matching(self):
        self.assertTrue(token_matches(f"Bearer {TOKEN}", TOKEN))
        self.assertFalse(token_matches("Bearer nope", TOKEN))
        self.assertFalse(token_matches(f"bearer {TOKEN}", TOKEN))
        self.assertFalse(token_matches(None, TOKEN))
        self.assertFalse(token_matches("Bearer ", TOKEN))

    def test_activation_fd(self):
        self.assertEqual(activation_fd({"LISTEN_PID": "42", "LISTEN_FDS": "1"}, 42), 3)
        self.assertIsNone(activation_fd({"LISTEN_PID": "41", "LISTEN_FDS": "1"}, 42))
        self.assertIsNone(activation_fd({"LISTEN_PID": "42", "LISTEN_FDS": "0"}, 42))
        self.assertIsNone(activation_fd({"LISTEN_PID": "42", "LISTEN_FDS": "x"}, 42))
        self.assertIsNone(activation_fd({}, 42))


if __name__ == "__main__":
    unittest.main()
