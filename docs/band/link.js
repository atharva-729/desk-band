// The phone's side of the relay for Desk Band Together (like ../play/phonelink.js, plus picking an instrument).
// Keeps reconnecting; pings every 2 s for the lag; learns from the stage which instrument it has and which are taken.
(function (root) {
  "use strict";
  const R = root.Relay;

  function BandLink(room, b, name) {
    this.room = R.cleanRoom(room);
    this.b = Math.max(0, Math.min(R.BROKERS.length - 1, +b || 0));
    this.name = String(name || "").trim().slice(0, 24);
    try { this.id = sessionStorage.getItem("band.id"); if (!this.id) { this.id = R.newId(); sessionStorage.setItem("band.id", this.id); } }
    catch { this.id = R.newId(); }
    this.T = R.topics("band-" + this.room);
    this.c = null; this.seq = 0; this.rtt = null; this.stageAt = 0; this.tries = 0;
    this.role = undefined;      // undefined: not told yet; null: no instrument free; else an instrument key
    this.who = {};              // instrument key -> name of whoever has it
    this.bpm = null; this.onrole = null; this.onhello = null;
    this._connect();
    setInterval(() => this.send({ t: "ping", ts: Math.round(performance.now()) }), 2000);
    window.addEventListener("pagehide", () => { if (this.c && this.c.open) this.c.publish(this.T.phone(this.id), { t: "bye" }); });
  }
  BandLink.prototype._connect = function () {
    const c = new R.Mqtt(R.BROKERS[this.b].url, { will: { topic: this.T.phone(this.id), payload: JSON.stringify({ t: "bye" }) } });
    c.connect().then(() => {
      this.c = c; this.tries = 0;
      c.subscribe(this.T.stage); c.subscribe(this.T.to(this.id));
      c.onmessage = (topic, s) => {
        let m; try { m = JSON.parse(s); } catch { return; }
        if (m.t === "hello") {
          this.stageAt = performance.now(); this.bpm = m.bpm; this.who = m.who || {};
          if (this.id in (m.roles || {})) this._setRole(m.roles[this.id]);
          else this.send({ t: "join" });          // the stage doesn't know this phone (yet, or it reloaded)
          if (this.onhello) this.onhello();
        }
        if (m.t === "role") { this.stageAt = performance.now(); this._setRole(m.role); }
        if (m.t === "pong" && m.ts != null) { this.rtt = Math.round(performance.now() - m.ts); this.stageAt = performance.now(); }
      };
      c.onclose = () => { this.c = null; this._retry(); };
      this.send({ t: "join" });
    }).catch(() => this._retry());
  };
  BandLink.prototype.pick = function (k) { this.send({ t: "pick", k }); };   // the stage says yes only if it's free
  BandLink.prototype._setRole = function (r) { if (r !== this.role) { this.role = r; if (this.onrole) this.onrole(r); } };
  BandLink.prototype._retry = function () { const ms = Math.min(8000, 1000 * Math.pow(2, this.tries++)); setTimeout(() => this._connect(), ms); };
  BandLink.prototype.send = function (msg) {
    if (!this.c || !this.c.open) return false;
    msg.n = this.name; msg.seq = ++this.seq; if (this.rtt != null) msg.rtt = this.rtt;
    return this.c.publish(this.T.phone(this.id), msg);
  };
  // -> { state: "connecting" | "nostage" | "ok", text }
  BandLink.prototype.status = function () {
    if (!this.c || !this.c.open) return { state: "connecting", text: `Connecting to room ${this.room}…` };
    if (performance.now() - this.stageAt > 4000) return { state: "nostage", text: `Room ${this.room}: no stage is listening. Is the stage page open?` };
    return { state: "ok", text: `In the band · room ${this.room}` + (this.rtt == null ? "" : ` · lag about ${Math.round(this.rtt / 2)} ms`) };
  };
  root.BandLink = BandLink;
})(typeof window !== "undefined" ? window : globalThis);
