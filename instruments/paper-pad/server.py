#!/usr/bin/env python3
"""Paper Pad server (copied from Desk Band and trimmed).

Phone  -> https://<laptop-ip>:8444   (sensing page; HTTPS is required for mic + motion)
Laptop -> http://localhost:8001      (stage page; plays the sounds)

Events go phone -> POST /hit -> server -> Server-Sent Events -> stage page.
Standard library only, plus a self-signed certificate (made with `cryptography`
if installed, otherwise the `openssl` command). Certificates live in this folder's .certs/.
"""
import http.server
import json
import os
import queue
import re
import socket
import ssl
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
CERTS = os.path.join(HERE, ".certs")
DATA = os.environ.get("PAPERPAD_DATA") or os.path.join(HERE, "data")  # tests point this elsewhere
PHONE_URL = ""
HTTPS_PORT = int(os.environ.get("PAPERPAD_HTTPS_PORT", 8444))
HTTP_PORT = int(os.environ.get("PAPERPAD_HTTP_PORT", 8001))

FILES = {  # url path -> (file under static/, content type)
    "/phone.html": ("phone.html", "text/html; charset=utf-8"),
    "/stage.html": ("stage.html", "text/html; charset=utf-8"),
    "/core.js": ("core.js", "application/javascript; charset=utf-8"),
    "/paper.js": ("paper.js", "application/javascript; charset=utf-8"),
    "/engine.js": ("engine.js", "application/javascript; charset=utf-8"),
    "/train-worker.js": ("train-worker.js", "application/javascript; charset=utf-8"),
    "/vendor/qrcode.js": (os.path.join("vendor", "qrcode.js"), "application/javascript; charset=utf-8"),
}

subscribers = []
sub_lock = threading.Lock()
log_lock = threading.Lock()
last_phone = None  # the phone's latest status, replayed to stage pages that connect later
rec_lock = threading.Lock()
rec_next = {}  # recording id -> next audio chunk number expected
REC_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
FEAT_KEY = re.compile(r"^[A-Za-z0-9-]{1,100}$")  # feature cache name: <recording id>-v<version>-<hit ms>-<texture ms>
fix_lock = threading.Lock()


def sessions_dir():
    return os.path.join(DATA, "sessions")


def query(path):
    q = path.split("?", 1)[1] if "?" in path else ""
    return dict(p.split("=", 1) for p in q.split("&") if "=" in p)


def list_sessions():
    """Saved recordings, oldest first: what the phone shows as 'recorded so far'."""
    out = []
    root = sessions_dir()
    for sid in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        try:
            with open(os.path.join(root, sid, "meta.json"), encoding="utf-8") as fh:
                m = json.load(fh)
        except (OSError, ValueError):
            continue  # unfinished recording
        out.append({"id": sid, "setup": m.get("setup"), "length": m.get("length"), "seconds": m.get("seconds"),
                    "prompts": len(m.get("prompts", [])), "when": m.get("when")})
    return out


def read_fixes():
    """Corrections made while playing, oldest first."""
    f = os.path.join(DATA, "fixes.jsonl")
    out = []
    if os.path.exists(f):
        with fix_lock, open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def broadcast(line):
    """Send one JSON line to every stage page listening on /events."""
    with sub_lock:
        for q in subscribers:
            q.put(line)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    cert = os.path.join(CERTS, f"cert-{ip}.pem")
    key = os.path.join(CERTS, f"key-{ip}.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    try:
        import datetime
        import ipaddress
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "paper-pad")])
        now = datetime.datetime.now(datetime.timezone.utc)
        c = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(k.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(
                [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address(ip))]), critical=False)
            .sign(k, hashes.SHA256())
        )
        with open(key, "wb") as f:
            f.write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                    serialization.NoEncryption()))
        with open(cert, "wb") as f:
            f.write(c.public_bytes(serialization.Encoding.PEM))
        return cert, key
    except ImportError:
        pass
    base = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
            "-days", "365", "-subj", "/CN=paper-pad"]
    try:
        r = subprocess.run(base + ["-addext", f"subjectAltName=IP:{ip},DNS:localhost"], capture_output=True)
        if r.returncode != 0:
            subprocess.run(base, check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        sys.exit("Could not make a certificate. Run:  pip install cryptography   and try again.")
    return cert, key


class Handler(http.server.BaseHTTPRequestHandler):
    # HTTP/1.1 keeps the phone's connection open between requests: while playing it sends ~20 small updates a second,
    # and a new TLS handshake for each would add delay. Every response carries Content-Length (or never ends: /events).
    protocol_version = "HTTP/1.1"
    timeout = 120  # an idle kept-open connection is dropped after this

    def log_message(self, *args):
        pass

    def send_error(self, *args, **kwargs):
        self.close_connection = True  # the request body may not have been read: don't reuse this connection
        super().send_error(*args, **kwargs)

    def _file(self, name, ctype):
        with open(os.path.join(STATIC, name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, default, limit=1_000_000):
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(min(n, limit)) or default)
        except json.JSONDecodeError:
            return None

    def _no_content(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            path = "/phone.html" if self.server.server_port == HTTPS_PORT else "/stage.html"
        if path in ("/phone", "/stage"):
            path += ".html"
        if path in FILES:
            return self._file(*FILES[path])
        if path == "/events":
            return self._events()
        if path == "/info":
            return self._json({"phone_url": PHONE_URL})
        if path == "/rec/list":
            return self._json(list_sessions())
        if path in ("/rec/meta", "/rec/pcm"):
            sid = query(self.path).get("id", "")
            name = "meta.json" if path == "/rec/meta" else "audio.pcm16"
            f = os.path.join(sessions_dir(), sid, name)
            if not REC_ID.match(sid) or not os.path.exists(f):
                return self.send_error(404)
            return self._send_file(f, "application/json" if name.endswith(".json") else "application/octet-stream")
        if path == "/train/features":
            key = query(self.path).get("key", "")
            f = os.path.join(DATA, "features", key + ".json")
            if not FEAT_KEY.match(key) or not os.path.exists(f):
                return self.send_error(404)
            return self._send_file(f, "application/json")
        if path == "/train/fixes":
            return self._json(read_fixes())
        self.send_error(404)

    def _send_file(self, f, ctype):
        with open(f, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = queue.Queue()
        with sub_lock:
            subscribers.append(q)
        try:
            self.wfile.write(b"data: {\"type\":\"hello\"}\n\n")
            if last_phone:
                self.wfile.write(f"data: {last_phone}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with sub_lock:
                if q in subscribers:
                    subscribers.remove(q)

    def _rec_audio(self):
        """One chunk of raw mic audio (16-bit mono PCM) from a recording, appended in order. Stays on this laptop."""
        args = query(self.path)
        sid, seq = args.get("id", ""), args.get("seq", "")
        n = int(self.headers.get("Content-Length", 0))
        if not REC_ID.match(sid) or not seq.isdigit() or n > 4_000_000:
            return self.send_error(400)
        body = self.rfile.read(n)
        folder = os.path.join(sessions_dir(), sid)
        with rec_lock:
            want = rec_next.get(sid, 0)
            if int(seq) != want:
                return self._json({"expected": want}, 409)
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, "audio.pcm16"), "wb" if want == 0 else "ab") as fh:
                fh.write(body)
            rec_next[sid] = want + 1
            size = os.path.getsize(os.path.join(folder, "audio.pcm16"))
        return self._json({"bytes": size})

    def _rec_done(self):
        """End of a recording: prompts (the labels), motion readings and device details."""
        sid = query(self.path).get("id", "")
        meta = self._body(b"{}", 20_000_000)
        folder = os.path.join(sessions_dir(), sid)
        audio = os.path.join(folder, "audio.pcm16")
        if not REC_ID.match(sid) or not isinstance(meta, dict) or not os.path.exists(audio):
            return self.send_error(400)
        meta["audioBytes"] = os.path.getsize(audio)
        with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        with rec_lock:
            rec_next.pop(sid, None)
        return self._json({"bytes": meta["audioBytes"]})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/rec/audio":
            return self._rec_audio()
        if path == "/rec/done":
            return self._rec_done()
        if path == "/train/features":
            # the phone worked out the features of a recording: keep them so it doesn't have to again (no audio in here)
            key = query(self.path).get("key", "")
            feats = self._body(b"{}", 30_000_000)
            if not FEAT_KEY.match(key) or not isinstance(feats, dict):
                return self.send_error(400)
            os.makedirs(os.path.join(DATA, "features"), exist_ok=True)
            with open(os.path.join(DATA, "features", key + ".json"), "w", encoding="utf-8") as fh:
                json.dump(feats, fh)
            return self._no_content()
        if path == "/train/fix":
            # "that was actually a rub": a correction made while playing, kept as extra training
            fix = self._body(b"{}", 2_000_000)
            if not isinstance(fix, dict) or not isinstance(fix.get("examples"), list):
                return self.send_error(400)
            os.makedirs(DATA, exist_ok=True)
            with fix_lock, open(os.path.join(DATA, "fixes.jsonl"), "a", encoding="utf-8") as fh:
                fh.write(json.dumps(fix) + "\n")
            return self._json({"fixes": len(read_fixes())})
        if path == "/train/fixes/clear":
            with fix_lock:
                f = os.path.join(DATA, "fixes.jsonl")
                if os.path.exists(f):
                    os.replace(f, os.path.join(DATA, f"fixes-cleared-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"))
            return self._json({"fixes": 0})
        if path == "/log":
            # session log from the phone: one JSON line per event, appended to data/log-<date>.jsonl
            events = self._body(b"[]", 5_000_000)
            if not isinstance(events, list):
                return self.send_error(400)
            os.makedirs(DATA, exist_ok=True)
            day = time.strftime("%Y-%m-%d")
            with log_lock, open(os.path.join(DATA, f"log-{day}.jsonl"), "a", encoding="utf-8") as fh:
                for ev in events:
                    fh.write(json.dumps(ev) + "\n")
            return self._no_content()
        if path != "/hit":
            return self.send_error(404)
        msg = self._body(b"{}")
        if not isinstance(msg, dict):
            return self.send_error(400)
        msg["serverMs"] = round(time.time() * 1000)
        line = json.dumps(msg)
        if msg.get("type") == "phone":
            global last_phone
            last_phone = line
        elif msg.get("type") != "frame":  # every event except the 20-a-second frames is kept, so a session can be checked afterwards
            os.makedirs(DATA, exist_ok=True)
            with log_lock, open(os.path.join(DATA, f"events-{time.strftime('%Y-%m-%d')}.jsonl"), "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        broadcast(line)
        self._no_content()


class PhoneServer(http.server.ThreadingHTTPServer):
    """HTTPS server that also forgives a plain http:// visit by redirecting it to https://."""

    def __init__(self, addr, handler, ctx):
        super().__init__(addr, handler)
        self.ctx = ctx

    def finish_request(self, request, client_address):
        try:
            request.settimeout(10)
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if first == b"\x16":  # a TLS handshake: serve the page securely
            try:
                tls = self.ctx.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):
                return
            try:
                tls.settimeout(None)
                self.RequestHandlerClass(tls, client_address, self)
            finally:
                try:
                    tls.close()
                except OSError:
                    pass
            return
        # Plain HTTP on the secure port (browser dropped the https://): redirect.
        try:
            head = request.recv(4096).decode("latin-1", "replace")
            path = head.split(" ")[1] if head.count(" ") >= 2 else "/"
            host = next((l.split(":", 1)[1].strip() for l in head.split("\r\n") if l.lower().startswith("host:")),
                        f"{lan_ip()}:{HTTPS_PORT}")
            request.sendall((f"HTTP/1.1 301 Moved Permanently\r\nLocation: https://{host}{path}\r\n"
                             "Content-Length: 0\r\nConnection: close\r\n\r\n").encode())
        except OSError:
            pass


def main():
    global PHONE_URL
    ip = lan_ip()
    PHONE_URL = f"https://{ip}:{HTTPS_PORT}"
    cert, key = ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    https = PhoneServer(("0.0.0.0", HTTPS_PORT), Handler, ctx)
    plain = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    for s in (https, plain):
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("\n  Paper Pad is running\n")
    print(f"  Laptop (stage, plays sound):  http://localhost:{HTTP_PORT}")
    print(f"  Phone  (sensor page):          https://{ip}:{HTTPS_PORT}")
    print("  (or just scan the QR code on the laptop page)")
    print("\n  Phone and laptop must be on the same Wi-Fi.")
    print("  The phone will warn the certificate is not private: tap Show Details -> visit this website.\n")
    print("  Ctrl+C to stop.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n  bye")


if __name__ == "__main__":
    main()
