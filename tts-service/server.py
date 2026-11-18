"""Local speech service for Assistant replies. POST /speak streams 24 kHz mono 16-bit PCM, one sentence at a time."""
import hashlib
import hmac
import json
import os
import select
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prepare import UnsupportedText, prepare

SAMPLE_RATE = 24000
VOICES = ("F2", "M2")
MAX_CHARS = 2500
MAX_BODY = 16 * 1024


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def token_matches(header: str | None, token: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    given = header[7:]
    return bool(given) and " " not in given and hmac.compare_digest(_digest(given), _digest(token))


# systemd socket activation hands over the listening socket as fd 3 (sd_listen_fds).
def activation_fd(env=None, pid=None):
    env = os.environ if env is None else env
    pid = os.getpid() if pid is None else pid
    try:
        return 3 if env.get("LISTEN_PID") == str(pid) and int(env.get("LISTEN_FDS", "0")) >= 1 else None
    except ValueError:
        return None


def _stdout_log(entry: dict) -> None:
    print(json.dumps(entry), flush=True)


class Service:
    def __init__(self, token, engine, max_chars, max_waiting, queue_wait_s, load_wait_s, max_total_s, idle_s, on_idle, log):
        self.token = token
        self.engine = engine
        self.loaded = threading.Event()
        if engine is not None:
            self.loaded.set()
        self.max_chars = max_chars
        self.max_waiting = max_waiting
        self.queue_wait_s = queue_wait_s
        self.load_wait_s = load_wait_s
        self.max_total_s = max_total_s
        self.idle_s = idle_s
        self.on_idle = on_idle
        self.log = log
        self.slot = threading.Semaphore(1)
        self.lock = threading.Lock()
        self.active = 0
        self.waiting = 0
        self.open = 0
        self.timer = None

    def busy(self) -> bool:
        return self.open > 0 or self.active > 0 or self.waiting > 0

    def arm_idle(self) -> None:
        with self.lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if not self.idle_s or self.busy():
                return
            self.timer = threading.Timer(self.idle_s, self._idle_fired)
            self.timer.daemon = True
            self.timer.start()

    def _idle_fired(self) -> None:
        with self.lock:
            self.timer = None
            if self.busy():
                return
        self.log({"event": "idle_exit", "idleSec": round(self.idle_s)})
        self.on_idle()


def create_server(token, engine=None, max_chars=MAX_CHARS, max_waiting=2, queue_wait_s=5.0, load_wait_s=8.0,
                  max_total_s=90.0, idle_s=0, on_idle=lambda: None, log=_stdout_log, address=("127.0.0.1", 0), sock=None):
    if not token:
        raise ValueError("A token is required.")
    service = Service(token, engine, max_chars, max_waiting, queue_wait_s, load_wait_s, max_total_s, idle_s, on_idle, log)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "zuychin-tts"
        sys_version = ""

        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            with service.lock:
                service.open += 1
            service.arm_idle()

        def finish(self):
            try:
                super().finish()
            finally:
                with service.lock:
                    service.open -= 1
                service.arm_idle()

        def _json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        # An unread body would reset the connection under the client, so drain it before replying.
        def _reject(self, status, error, **extra):
            self._drain()
            service.log({"event": "rejected", "status": status, "error": error})
            self._json(status, {"error": error, **extra})

        def _drain(self):
            try:
                left = min(int(self.headers.get("Content-Length") or 0), MAX_BODY * 4)
            except ValueError:
                left = 0
            while left > 0:
                chunk = self.rfile.read(min(left, 8192))
                if not chunk:
                    break
                left -= len(chunk)

        def do_GET(self):
            if self.path.split("?")[0] != "/health":
                return self._json(404, {"error": "not_found"})
            self._json(200, {"ok": True, "model": getattr(service.engine, "model", None), "loaded": service.loaded.is_set(),
                             "busy": service.active > 0, "waiting": service.waiting})

        def do_POST(self):
            if self.path.split("?")[0] != "/speak":
                return self._reject(404, "not_found")
            if not token_matches(self.headers.get("Authorization"), service.token):
                return self._reject(401, "unauthorised")
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._reject(415, "content_type")
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                return self._reject(411, "length_required")
            if length < 0 or length > MAX_BODY:
                return self._reject(413, "too_large")
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw)
                text, voice = body["text"], body.get("voice", "M2")
            except (ValueError, KeyError, TypeError):
                return self._json_error(400, "bad_body")
            if not isinstance(text, str) or not text.strip():
                return self._json_error(400, "empty")
            if voice not in VOICES:
                return self._json_error(400, "bad_voice")
            if len(text) > service.max_chars:
                return self._json_error(413, "too_long")
            try:
                sentences = prepare(text)
            except UnsupportedText as error:
                return self._json_error(422, "unsupported_text", reason=str(error))
            self._speak(sentences, voice, len(text))

        def _json_error(self, status, error, **extra):
            service.log({"event": "rejected", "status": status, "error": error})
            self._json(status, {"error": error, **extra})

        # The request body is fully read, so a readable socket that returns no bytes means the client hung up.
        def _client_gone(self) -> bool:
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
            except (OSError, ValueError):
                return True

        def _write_chunk(self, data: bytes):
            self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()

        def _speak(self, sentences, voice, chars):
            arrived = time.monotonic()
            if not service.loaded.wait(service.load_wait_s):
                return self._json_error(503, "loading")
            with service.lock:
                if service.active + service.waiting >= 1 + service.max_waiting:
                    return self._json_error(503, "busy")
                service.waiting += 1
            acquired = service.slot.acquire(timeout=service.queue_wait_s)
            with service.lock:
                service.waiting -= 1
                if acquired:
                    service.active = 1
            if not acquired:
                return self._json_error(503, "queue_timeout")
            started = time.monotonic()
            info = {"event": "speak", "chars": chars, "sentences": len(sentences), "voice": voice,
                    "waitMs": round((started - arrived) * 1000), "firstMs": 0, "audioSec": 0.0}
            status, error, headers_sent = 200, None, False
            try:
                for sentence in sentences:
                    if time.monotonic() - started > service.max_total_s:
                        error = "time_limit"
                        break
                    if self._client_gone():
                        raise ConnectionAbortedError("client closed")
                    pcm = service.engine.synthesize(sentence, voice)
                    if not headers_sent:
                        self.send_response(200)
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
                        self.send_header("X-Voice", voice)
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Connection", "close")
                        self.end_headers()
                        headers_sent = True
                        info["firstMs"] = round((time.monotonic() - started) * 1000)
                    self._write_chunk(pcm)
                    info["audioSec"] += len(pcm) / 2 / SAMPLE_RATE
                if headers_sent:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                else:
                    status = 503
                    self._json(503, {"error": error or "no_audio"})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                status, error = 499, "client_closed"
            except Exception:
                status, error = 500, "synth_failed"
                if not headers_sent:
                    self._json(500, {"error": "synth_failed"})
            finally:
                service.active = 0
                service.slot.release()
                info.update(status=status, totalMs=round((time.monotonic() - started) * 1000), audioSec=round(info["audioSec"], 2))
                if error:
                    info["error"] = error
                service.log(info)
                self.close_connection = True

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 8

    if sock is not None:
        server = Server(address, Handler, bind_and_activate=False)
        server.socket.close()
        server.socket = sock
        server.server_address = sock.getsockname()
    else:
        server = Server(address, Handler)
    server.service = service
    server.set_engine = lambda value: (setattr(service, "engine", value), service.loaded.set())
    return server


def main() -> None:
    token = os.environ.get("TTS_TOKEN", "")
    model_dir = os.environ.get("TTS_MODEL_DIR", "")
    port = int(os.environ.get("TTS_PORT", "3011"))
    idle_s = float(os.environ.get("TTS_IDLE_EXIT_SEC", "900"))
    overrides = os.environ.get("TTS_OVERRIDES") or None
    if len(token) < 32:
        raise SystemExit("TTS_TOKEN must be set to at least 32 characters.")
    if not 0 <= idle_s <= 86400:
        raise SystemExit("TTS_IDLE_EXIT_SEC must be between 0 and 86400.")
    for name in ("onnx/model.onnx", "phonemizer/lexicon.tsv"):
        if not model_dir or not os.path.exists(os.path.join(model_dir, name)):
            raise SystemExit(f"TTS_MODEL_DIR must hold {name}.")
    if overrides and not os.path.exists(overrides):
        raise SystemExit("TTS_OVERRIDES names a file that does not exist.")

    fd = activation_fd()
    # Exiting hands the model's memory back, and only the systemd socket starts the service again,
    # so a directly started service never idles out.
    stop = threading.Event()
    server = create_server(token, idle_s=0 if fd is None else idle_s, on_idle=lambda: threading.Thread(target=server.shutdown).start(),
                           address=("127.0.0.1", port), sock=None if fd is None else socket.socket(fileno=fd))
    _stdout_log({"event": "listening", **({"port": port} if fd is None else {"socket": "systemd"}), "idleExitSec": 0 if fd is None else idle_s})

    def load():
        started = time.monotonic()
        from engine import Engine
        server.set_engine(Engine.load(model_dir, overrides))
        _stdout_log({"event": "loaded", "ms": round((time.monotonic() - started) * 1000), "rssMb": _rss_mb()})
        server.service.arm_idle()

    threading.Thread(target=load, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


def _rss_mb():
    try:
        with open("/proc/self/status") as status:
            for line in status:
                if line.startswith("VmRSS"):
                    return round(int(line.split()[1]) / 1024)
    except OSError:
        pass
    return None


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exit_:
        if exit_.code not in (None, 0):
            print(json.dumps({"event": "fatal", "error": str(exit_.code)}), file=sys.stderr, flush=True)
        raise
