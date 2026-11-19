#!/usr/bin/env python3
"""Tilt Flute server (copied from Desk Band's server.py and cut down).

Phone  -> https://<laptop-ip>:8445   (sensor page; HTTPS is required for mic + motion on iOS)
Laptop -> http://localhost:8002      (stage page; will play the flute)

The phone POSTs {tilt, roll, mic} about 30 times a second to /state. The server relays each one to every
stage page listening on /events (Server-Sent Events). Standard library only, plus a self-signed certificate
(made with `cryptography` if installed, otherwise the `openssl` command).
"""
import http.server
import json
import os
import queue
import socket
import ssl
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
CERTS = os.path.join(HERE, ".certs")
DATA = os.environ.get("TILTFLUTE_DATA") or os.path.join(HERE, "data")  # tests point this elsewhere
LIVE = os.path.join(DATA, "live")
SESSIONS = os.path.join(DATA, "sessions")
PHONE_URL = ""
HTTPS_PORT = int(os.environ.get("TILTFLUTE_HTTPS_PORT", 8445))
HTTP_PORT = int(os.environ.get("TILTFLUTE_HTTP_PORT", 8002))

FILES = {
    "/phone.html": ("phone.html", "text/html; charset=utf-8"),
    "/stage.html": ("stage.html", "text/html; charset=utf-8"),
    "/flute-core.js": ("flute-core.js", "application/javascript; charset=utf-8"),
    "/vendor/qrcode.js": (os.path.join("vendor", "qrcode.js"), "application/javascript; charset=utf-8"),
}

subscribers = []
sub_lock = threading.Lock()
log_lock = threading.Lock()


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
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "tilt-flute")])
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
            "-days", "365", "-subj", "/CN=tilt-flute"]
    try:
        r = subprocess.run(base + ["-addext", f"subjectAltName=IP:{ip},DNS:localhost"], capture_output=True)
        if r.returncode != 0:
            subprocess.run(base, check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        sys.exit("Could not make a certificate. Run:  pip install cryptography   and try again.")
    return cert, key


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

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
        self.send_error(404)

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

    def do_POST(self):
        if self.path.split("?")[0] == "/session":
            return self._save_session()
        if self.path.split("?")[0] != "/state":
            return self.send_error(404)
        n = int(self.headers.get("Content-Length", 0))
        try:
            msg = json.loads(self.rfile.read(min(n, 100_000)) or b"{}")
        except json.JSONDecodeError:
            return self.send_error(400)
        if not isinstance(msg, dict):
            return self.send_error(400)
        line = json.dumps(msg)
        broadcast(line)
        # Keep every message so a session can be read back afterwards: data/live/live-<date>.jsonl (gitignored).
        # Numbers only (angles, mic level), never audio. "rx" is the laptop's clock in ms.
        os.makedirs(LIVE, exist_ok=True)
        with log_lock, open(os.path.join(LIVE, f"live-{time.strftime('%Y-%m-%d')}.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"rx": round(time.time() * 1000), **msg}) + "\n")
        self.send_response(204)
        self.end_headers()


    def _save_session(self):
        """A prompted test run from the phone: sensor samples, mic features and prompts (numbers only, no audio)
        -> data/sessions/session-<date>-<time>.json"""
        n = int(self.headers.get("Content-Length", 0))
        if n > 50_000_000:
            return self.send_error(413)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self.send_error(400)
        if not isinstance(data, dict) or not isinstance(data.get("prompts"), list):
            return self.send_error(400)
        os.makedirs(SESSIONS, exist_ok=True)
        name = time.strftime("session-%Y%m%d-%H%M%S.json")
        with open(os.path.join(SESSIONS, name), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        print(f"  saved {name}", flush=True)
        return self._json({"file": name})


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
    print("\n  Tilt Flute is running\n")
    print(f"  Laptop (stage):        http://localhost:{HTTP_PORT}")
    print(f"  Phone  (sensor page):  https://{ip}:{HTTPS_PORT}")
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
