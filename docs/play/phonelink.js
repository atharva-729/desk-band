// The phone's side of the relay, shared by flute.html and theremin.html.
// Reads ?r=ROOM&b=BROKER&n=NAME from the page address (the stage's QR code fills these in), connects, keeps
// reconnecting, measures the round trip to the stage every 2 s, and says goodbye when the page closes.
// With no room in the address the phone is on its own ("solo") and nothing is sent.
(function (root) {
  "use strict";
  const R = root.Relay;

  function PhoneLink(instrument) {
    const q = new URLSearchParams(location.search);
    this.instrument = instrument;
    this.room = R.cleanRoom(q.get("r"));
    this.b = Math.max(0, Math.min(R.BROKERS.length - 1, +q.get("b") || 0));
    let name = q.get("n");
    try { if (name == null) name = localStorage.getItem("pb.name"); } catch {}
    this.name = String(name || "").trim().slice(0, 24);
    try { this.id = sessionStorage.getItem("pb.id"); if (!this.id) { this.id = R.newId(); sessionStorage.setItem("pb.id", this.id); } }
    catch { this.id = R.newId(); }
    this.c = null; this.seq = 0; this.rtt = null; this.stageAt = 0; this.tries = 0; this.sent = []; this.closed = false;
    if (!this.room) return;
    this.T = R.topics(this.room);
    this._connect();
    this.pinger = setInterval(() => this.send({ t: "ping", ts: Math.round(performance.now()) }), 2000);
    const bye = () => this.bye();
    window.addEventListener("pagehide", bye);
  }
  PhoneLink.prototype._connect = function () {
    if (this.closed) return;
    const b = R.BROKERS[this.b];
    const c = new R.Mqtt(b.url, { will: { topic: this.T.phone(this.id), payload: JSON.stringify({ t: "bye" }) } });
    c.connect().then(() => {
      this.c = c; this.tries = 0;
      c.subscribe(this.T.stage); c.subscribe(this.T.to(this.id));
      c.onmessage = (topic, s) => {
        let m; try { m = JSON.parse(s); } catch { return; }
        if (topic === this.T.stage && m.t === "hello") this.stageAt = performance.now();
        if (m.t === "pong" && m.ts != null) { this.rtt = Math.round(performance.now() - m.ts); this.stageAt = performance.now(); }
      };
      c.onclose = () => { this.c = null; this._retry(); };
    }).catch(() => this._retry());
  };
  PhoneLink.prototype._retry = function () {
    if (this.closed) return;
    const ms = Math.min(8000, 1000 * Math.pow(2, this.tries++));
    clearTimeout(this.rt); this.rt = setTimeout(() => this._connect(), ms);
  };
  // msg: any object. Adds who and what this phone is. Returns false if it couldn't go (not connected, link backed up).
  PhoneLink.prototype.send = function (msg) {
    if (!this.c || !this.c.open) return false;
    msg.i = this.instrument; msg.n = this.name; msg.seq = ++this.seq;
    const ok = this.c.publish(this.T.phone(this.id), msg);
    if (ok) { const now = performance.now(); this.sent.push(now); while (this.sent[0] < now - 1000) this.sent.shift(); }
    return ok;
  };
  PhoneLink.prototype.bye = function () {
    if (this.c && this.c.open) { this.c.publish(this.T.phone(this.id), { t: "bye" }); }
  };
  PhoneLink.prototype.close = function () {
    this.bye(); this.closed = true; clearInterval(this.pinger); clearTimeout(this.rt);
    if (this.c) this.c.close();
  };
  // -> { state: "solo" | "connecting" | "nostage" | "ok", text }
  PhoneLink.prototype.status = function () {
    if (!this.room) return { state: "solo", text: "On its own (no stage)" };
    if (!this.c || !this.c.open) return { state: "connecting", text: `Connecting to room ${this.room}…` };
    if (performance.now() - this.stageAt > 4000) return { state: "nostage", text: `Room ${this.room}: no stage is listening. Is the stage page open on the laptop?` };
    return { state: "ok", text: `Playing on the stage · room ${this.room}` + (this.rtt == null ? "" : ` · lag about ${Math.round(this.rtt / 2)} ms`) };
  };
  PhoneLink.prototype.rate = function () { const now = performance.now(); while (this.sent.length && this.sent[0] < now - 1000) this.sent.shift(); return this.sent.length; };

  root.PhoneLink = PhoneLink;
})(typeof window !== "undefined" ? window : globalThis);
