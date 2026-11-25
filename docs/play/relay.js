// The relay between phones and the stage: a tiny MQTT 3.1.1 client over WebSocket (QoS 0 only), plus room helpers.
// No server of our own: both sides connect to a free public MQTT broker and meet on topics named after a room code.
// Messages are small JSON objects (notes, levels, a player's chosen name). Runs in the browser and in Node 22+.
(function (root) {
  "use strict";

  // Tried in this order by the stage. The stage puts the one it got into its QR code, so the phone uses the same one.
  // Measured from India (26 Nov 2026, tools/play-online/relay_probe.js): both about 330 ms round trip, and both
  // passed 300 of 300 messages at 30 a second. EMQX's public broker was left out: it dropped over half at that rate.
  const BROKERS = [
    { name: "HiveMQ", url: "wss://broker.hivemq.com:8884/mqtt" },
    { name: "Mosquitto", url: "wss://test.mosquitto.org:8081/mqtt" },
  ];
  const PREFIX = "phoneband-x7/v1/";     // namespace on the shared broker
  const ROOM_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L: easy to read off a shared screen

  const enc = new TextEncoder(), dec = new TextDecoder();
  function str(s) { const b = enc.encode(s), o = new Uint8Array(2 + b.length); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; }
  function packet(first, parts) {
    const len = parts.reduce((a, p) => a + p.length, 0), lb = [];
    let x = len;
    do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; lb.push(d); } while (x > 0);
    const out = new Uint8Array(1 + lb.length + len);
    out[0] = first; out.set(lb, 1);
    let o = 1 + lb.length;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // opts: clientId, keepalive (s), will: { topic, payload } sent by the broker if this client vanishes
  function Mqtt(url, opts) {
    this.url = url;
    this.o = Object.assign({ clientId: "pb-" + Math.random().toString(36).slice(2, 10), keepalive: 30, timeoutMs: 6000 }, opts || {});
    this.ws = null; this.buf = new Uint8Array(0); this.pid = 1; this.open = false;
    this.onmessage = null; this.onclose = null;
  }
  Mqtt.prototype.connect = function () {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => { if (settled) return; settled = true; try { this.ws.close(); } catch {} reject(new Error(why)); };
      const timer = setTimeout(() => fail("no answer from " + this.url), this.o.timeoutMs);
      let ws;
      try { ws = new WebSocket(this.url, "mqtt"); } catch (e) { clearTimeout(timer); return reject(e); }
      this.ws = ws; ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        const w = this.o.will;
        const flags = 0x02 | (w ? 0x04 : 0);   // clean session, optional will (QoS 0, not retained)
        const parts = [str("MQTT"), new Uint8Array([4, flags, this.o.keepalive >> 8, this.o.keepalive & 255]), str(this.o.clientId)];
        if (w) parts.push(str(w.topic), str(w.payload));
        ws.send(packet(0x10, parts));
      };
      ws.onerror = () => fail("could not reach " + this.url);
      ws.onclose = () => {
        clearTimeout(timer);
        const was = this.open; this.open = false; clearInterval(this.pinger);
        if (!settled) fail("closed by " + this.url);
        else if (was && this.onclose) this.onclose();
      };
      ws.onmessage = (ev) => {
        const add = new Uint8Array(ev.data), b = new Uint8Array(this.buf.length + add.length);
        b.set(this.buf); b.set(add, this.buf.length); this.buf = b;
        for (;;) {
          const p = this._take();
          if (!p) break;
          if (p.type === 2) {                           // CONNACK
            clearTimeout(timer);
            if (p.body[1] !== 0) return fail("broker refused (code " + p.body[1] + ")");
            settled = true; this.open = true;
            this.pinger = setInterval(() => this._send(new Uint8Array([0xc0, 0])), (this.o.keepalive * 1000) / 2);
            resolve(this);
          } else if (p.type === 3) this._publishIn(p);
        }
      };
    });
  };
  // one whole packet off the front of the buffer, or null if it hasn't all arrived yet
  Mqtt.prototype._take = function () {
    const b = this.buf;
    if (b.length < 2) return null;
    let len = 0, mul = 1, i = 1;
    for (;;) {
      if (i >= b.length) return null;
      const d = b[i++]; len += (d & 127) * mul; mul *= 128;
      if (!(d & 128)) break;
      if (i > 4) { this.buf = new Uint8Array(0); return null; }
    }
    if (b.length < i + len) return null;
    const p = { type: b[0] >> 4, flags: b[0] & 15, body: b.subarray(i, i + len) };
    this.buf = b.slice(i + len);
    return p;
  };
  Mqtt.prototype._publishIn = function (p) {
    const b = p.body, tl = (b[0] << 8) | b[1], topic = dec.decode(b.subarray(2, 2 + tl));
    let o = 2 + tl;
    const qos = (p.flags >> 1) & 3;
    if (qos > 0) { const id = b.subarray(o, o + 2); o += 2; if (qos === 1) this._send(new Uint8Array([0x40, 2, id[0], id[1]])); }
    if (this.onmessage) { try { this.onmessage(topic, dec.decode(b.subarray(o))); } catch (e) { console.error(e); } }
  };
  Mqtt.prototype._send = function (bytes) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    if (this.ws.bufferedAmount > 64 * 1024) return false;   // the link is backed up: drop rather than queue stale notes
    this.ws.send(bytes);
    return true;
  };
  Mqtt.prototype.subscribe = function (topic) {
    const id = this.pid = (this.pid % 65535) + 1;
    return this._send(packet(0x82, [new Uint8Array([id >> 8, id & 255]), str(topic), new Uint8Array([0])]));
  };
  Mqtt.prototype.publish = function (topic, payload) {
    return this._send(packet(0x30, [str(topic), enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload))]));
  };
  Mqtt.prototype.close = function () {
    this.open = false; clearInterval(this.pinger);
    try { this._send(new Uint8Array([0xe0, 0])); this.ws.close(); } catch {}
  };

  // ---- rooms ----------------------------------------------------------------------------------------------
  // Topics: <prefix><room>/stage    stage -> everyone (a heartbeat every second)
  //         <prefix><room>/p/<id>   phone -> stage (state, pings, bye)
  //         <prefix><room>/to/<id>  stage -> one phone (pong)
  function newRoom(n = 5) { let s = ""; for (let i = 0; i < n; i++) s += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]; return s; }
  const cleanRoom = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const topics = (room) => ({ stage: PREFIX + room + "/stage", phones: PREFIX + room + "/p/+", phone: (id) => PREFIX + room + "/p/" + id,
    to: (id) => PREFIX + room + "/to/" + id });
  const newId = () => Math.random().toString(36).slice(2, 10);

  // Try each broker in turn (starting at `first`); resolves { client, index }.
  async function connectAny(first, opts, onTry) {
    let last;
    for (let k = 0; k < BROKERS.length; k++) {
      const index = (first + k) % BROKERS.length;
      if (onTry) onTry(BROKERS[index], index);
      try { const client = await new Mqtt(BROKERS[index].url, opts).connect(); return { client, index }; }
      catch (e) { last = e; }
    }
    throw last || new Error("no broker reachable");
  }

  const api = { Mqtt, BROKERS, PREFIX, newRoom, cleanRoom, topics, newId, connectAny };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Relay = api;
})(typeof window !== "undefined" ? window : globalThis);
