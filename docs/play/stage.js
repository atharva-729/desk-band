// The stage: makes a room, shows its QR code, and plays every phone that joins it.
// Each phone gets a card and its own voice (flute or theremin), all mixed into this tab's sound so a video call
// can carry it as shared tab audio.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const R = window.Relay, FC = window.FluteCore, TH = window.Theremin;
  const COLORS = ["#5aa8ff", "#ff8a5a", "#3dd6a3", "#c792ff", "#ffc23d", "#ff6b9a", "#6be0ff", "#b8e05a"];
  const SILENT_MS = 700, GONE_MS = 20000;

  // ---------- room ----------
  const q = new URLSearchParams(location.search);
  let room = R.cleanRoom(location.hash.slice(1));
  if (!room) { room = R.newRoom(); history.replaceState(null, "", "#" + room); }   // reload keeps the same room
  const T = R.topics(room);
  let client = null, brokerIx = Math.max(0, Math.min(R.BROKERS.length - 1, +q.get("b") || 0));
  window.__stage = { room, players: null, broker: null };

  function showJoin() {
    const u = new URL("join.html", location.href);
    u.hash = ""; u.search = `?r=${room}&b=${brokerIx}`;
    $("code").textContent = room;
    $("joinUrl").textContent = u.href;
    try {
      const qr = qrcode(0, "M"); qr.addData(u.href); qr.make();
      $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch { $("qr").textContent = "(QR code didn't load: open the address below on the phone)"; }
    $("brokerName").textContent = R.BROKERS[brokerIx].name;
    window.__stage.joinUrl = u.href;
  }
  showJoin();

  async function connect() {
    $("relayPill").textContent = "connecting…"; $("relayPill").className = "pill";
    try {
      const { client: c, index } = await R.connectAny(brokerIx, {}, (b) => { $("relayPill").textContent = "connecting to " + b.name + "…"; });
      client = c;
      if (index !== brokerIx) { brokerIx = index; showJoin(); }
      window.__stage.broker = R.BROKERS[brokerIx].name;
      c.subscribe(T.phones);
      c.onmessage = onMessage;
      c.onclose = () => { client = null; $("relayPill").textContent = "relay lost: reconnecting…"; $("relayPill").className = "pill bad"; setTimeout(connect, 1000); };
      $("relayPill").textContent = "relay connected · " + R.BROKERS[brokerIx].name; $("relayPill").className = "pill on";
      hello();
    } catch (e) {
      $("relayPill").textContent = "no relay reachable: retrying"; $("relayPill").className = "pill bad";
      setTimeout(connect, 3000);
    }
  }
  const hello = () => { if (client && client.open) client.publish(T.stage, { t: "hello", n: players.size }); };
  setInterval(hello, 1000);

  // ---------- sound ----------
  let ctx = null, master = null;
  function ensureAudio() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    master = ctx.createGain(); master.gain.value = volume();
    const comp = ctx.createDynamicsCompressor(); master.connect(comp); comp.connect(ctx.destination);
    for (const p of players.values()) makeVoice(p);
    return ctx;
  }
  const volume = () => { const v = +$("vol").value / 100; return 1.1 * v * v; };
  $("vol").oninput = () => { if (master) master.gain.setTargetAtTime(volume(), ctx.currentTime, 0.05); };
  $("startBig").onclick = async () => {
    const fresh = !ctx;
    ensureAudio();
    // The first click always turns sound on (the browser may have started the audio already); later clicks toggle it.
    if (!fresh && ctx.state === "running") await ctx.suspend(); else await ctx.resume();
    soundButton();
  };
  function soundButton() {
    const on = ctx && ctx.state === "running";
    $("startBig").textContent = on ? "Sound on" : ctx ? "Sound off: click to start" : "Start sound";
    $("startBig").classList.toggle("on", on);
  }

  // The flute voice: a sine with a little 2nd/3rd/4th harmonic plus band-passed noise for "air", a 5.5 Hz vibrato
  // whose depth comes from turning the phone (or a ±1 semitone bend), a short glide between notes, loudness = breath.
  class FluteVoice {
    constructor(out) {
      const t = ctx.currentTime;
      this.osc = ctx.createOscillator();
      this.osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.18, 0.07, 0.03])));
      this.env = ctx.createGain(); this.env.gain.value = 0;
      this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 5.5;
      this.vib = ctx.createGain(); this.vib.gain.value = 0;
      this.lfo.connect(this.vib); this.vib.connect(this.osc.detune);
      const noise = ctx.createBufferSource(), buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noise.buffer = buf; noise.loop = true;
      this.bp = ctx.createBiquadFilter(); this.bp.type = "bandpass"; this.bp.Q.value = 2.5;
      this.air = ctx.createGain(); this.air.gain.value = 0.06;
      noise.connect(this.bp); this.bp.connect(this.air); this.air.connect(this.env);
      this.osc.connect(this.env); this.env.connect(out);
      this.osc.start(t); this.lfo.start(t); noise.start(t);
      this.nodes = [this.osc, this.lfo, noise];
      this.level = 0; this.midi = null;
    }
    set(midi, level, vibCents = 0, bendCents = 0, at = ctx.currentTime) {
      const f = FC.midiHz(midi);
      if (this.level < 0.01 || this.midi === null) { this.osc.frequency.setValueAtTime(f, at); this.bp.frequency.setValueAtTime(f * 2, at); }
      else { this.osc.frequency.setTargetAtTime(f, at, 0.008); this.bp.frequency.setTargetAtTime(f * 2, at, 0.008); }
      this.env.gain.setTargetAtTime(0.45 * Math.pow(level, 1.2), at, 0.012);
      this.vib.gain.setTargetAtTime(vibCents, at, 0.05);
      this.osc.detune.setTargetAtTime(bendCents, at, 0.02);
      this.midi = midi; this.level = level;
    }
    quiet() { this.env.gain.setTargetAtTime(0, ctx.currentTime, 0.03); this.level = 0; }
    stop() { this.quiet(); setTimeout(() => this.nodes.forEach((n) => { try { n.stop(); } catch {} }), 400); }
  }
  function vibratoFor(off, mode) {
    const a = Math.abs(off || 0);
    if (mode === "bend") return [0, Math.max(-1, Math.min(1, Math.sign(off) * Math.max(0, a - 3) / 15)) * 100];
    return [Math.min(40, Math.max(0, a - 4) * 2), 0]; // cents of vibrato: dead zone 4°, then 2 cents per degree
  }

  function makeVoice(p) {
    if (!ctx || p.voice) return;
    p.gain = ctx.createGain(); p.gain.gain.value = p.muted ? 0 : 1; p.gain.connect(master);
    p.voice = p.inst === "flute" ? new FluteVoice(p.gain) : TH.Synth(ctx, { out: p.gain });
  }
  function sound(p) {
    const m = p.last;
    if (!p.voice || !m) return;
    if (p.inst === "flute") {
      if (m.on && m.midi != null && !p.silent) { const [v, b] = vibratoFor(m.off, m.rollMode); p.voice.set(m.midi, m.level || 0, v, b); }
      else p.voice.quiet();
    } else {
      p.voice.set(p.silent ? { gate: false } : p.out, p.tvoice, p.mapper.o.mode);
    }
  }
  // Theremin settings live on the stage (as in the laptop version): one choice for every theremin card, remembered.
  const thStore = { get(k, d) { try { const v = localStorage.getItem("pb-th-" + k); return v == null ? d : v; } catch { return d; } },
                    set(k, v) { try { localStorage.setItem("pb-th-" + k, v); } catch {} } };
  const TH_LOW = 2, TH_HIGH = 24;   // lowest note 2 cm above the phone, highest 24 cm; every note gets at least 3 cm

  // Test sound: a short flute phrase on its own voice
  let demo = null;
  $("testSound").onclick = async () => {
    ensureAudio(); await ctx.resume(); soundButton();
    if (!demo) { const g = ctx.createGain(); g.connect(master); demo = new FluteVoice(g); }
    const t0 = ctx.currentTime + 0.03;
    [72, 76, 79, 84, 79, 76, 72].forEach((m, i) => demo.set(m, 0.75, 8, 0, t0 + i * 0.28));
    demo.env.gain.setTargetAtTime(0, t0 + 7 * 0.28, 0.04); demo.level = 0;
  };

  // ---------- players ----------
  const players = new Map();
  window.__stage.players = players;
  let joined = 0;
  function getPlayer(id, m) {
    let p = players.get(id);
    if (p && p.inst !== m.i) { removePlayer(p); p = null; }   // same phone switched instrument
    if (p) return p;
    joined++;
    p = { id, inst: m.i, color: COLORS[(joined - 1) % COLORS.length], num: joined, seen: 0, last: null, muted: false, silent: false, cols: 0 };
    p.el = document.createElement("div"); p.el.className = "pc"; p.el.style.setProperty("--c", p.color);
    const head = `<div class="pc-h"><b class="nm"></b><span class="inst">${m.i === "flute" ? "Flute" : "Theremin"}</span><span class="lag"></span><button class="ghost mute">Mute</button></div>`;
    if (m.i === "flute") {
      p.el.innerHTML = head + `<div class="pnote">–</div><div class="ladder">${"<div></div>".repeat(8)}</div><div class="meter"><i></i></div><div class="psub"></div>`;
    } else {
      p.el.innerHTML = head + `<div class="trow"><div class="pnote">–</div><div class="tcm"></div></div><canvas class="zones"></canvas><canvas class="map"></canvas>` +
        `<div class="tctl"><span class="seg"><button data-m="easy">Easy notes</button><button data-m="glide">Glide</button></span>` +
        `<span class="seg"><button data-v="theremin">Theremin voice</button><button data-v="marimba">Marimba</button></span></div><div class="psub"></div>`;
      p.zc = p.el.querySelector("canvas.zones");
      p.mapper = new TH.Mapper({ low: TH_LOW, high: TH_HIGH, mode: thStore.get("mode", "easy") });
      p.tvoice = thStore.get("voice", "theremin");
      p.out = { gate: false };
      const segs = () => {
        p.el.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === p.mapper.o.mode));
        p.el.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === p.tvoice));
      };
      p.el.querySelectorAll("[data-m]").forEach((b) => { b.onclick = () => { p.mapper.o.mode = b.dataset.m; p.mapper.zone = -1; thStore.set("mode", b.dataset.m); segs(); }; });
      p.el.querySelectorAll("[data-v]").forEach((b) => { b.onclick = () => { p.tvoice = b.dataset.v; thStore.set("voice", b.dataset.v); segs(); }; });
      segs();
    }
    p.q = (sel) => p.el.querySelector(sel);
    p.q(".mute").onclick = () => { p.muted = !p.muted; p.q(".mute").textContent = p.muted ? "Muted" : "Mute"; p.q(".mute").classList.toggle("muted", p.muted); if (p.gain) p.gain.gain.setTargetAtTime(p.muted ? 0 : 1, ctx.currentTime, 0.03); };
    $("players").appendChild(p.el);
    players.set(id, p);
    makeVoice(p);
    $("empty").style.display = "none";
    return p;
  }
  function removePlayer(p) {
    if (p.voice) { if (p.inst === "flute") p.voice.stop(); else p.voice.set({ gate: false }, "theremin", "easy"); }
    if (p.gain) setTimeout(() => { try { p.gain.disconnect(); } catch {} }, 600);
    p.el.remove(); players.delete(p.id);
    if (!players.size) $("empty").style.display = "";
  }

  function onMessage(topic, s) {
    const id = topic.slice(topic.lastIndexOf("/") + 1);
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.t === "ping") { if (client) client.publish(T.to(id), { t: "pong", ts: m.ts }); return; }
    if (m.t === "bye") { const p = players.get(id); if (p) removePlayer(p); return; }
    if (m.t !== "s" || (m.i !== "flute" && m.i !== "theremin")) return;
    const p = getPlayer(id, m);   // (one phone's messages arrive in order: MQTT over one connection keeps it)
    p.last = m; p.seen = performance.now(); p.silent = false;
    if (p.inst === "theremin") {
      // Every echo reading's height goes through the note mapper with its real time (now minus its age), as the
      // laptop version did: median of 3, smoothing, note zones with hysteresis, short dropouts hold the note.
      const now = performance.now();
      if (m.rows && (!p.map || p.map.rows !== m.rows)) p.map = new Sonar.EchoMap(p.q("canvas.map"), m.rows, m.cpr, 200);
      for (const [b64, h, a] of m.cols || []) {
        if (p.map) p.map.push({ change: Sonar.fromB64(b64), hand: h });
        p.out = p.mapper.update(m.ln ? null : h, now - (a || 0));
      }
      if (m.stopped || !(m.cols || []).length) p.out = p.mapper.update(null, now);
      p.cols += (m.cols || []).length;
    }
    sound(p);
  }

  // silence anyone who stops sending; drop them after a while
  setInterval(() => {
    const now = performance.now();
    for (const p of players.values()) {
      const quiet = now - p.seen > SILENT_MS;
      if (quiet && !p.silent) { p.silent = true; if (p.mapper) { p.mapper.zone = -1; p.out = { gate: false }; } sound(p); }
      p.el.classList.toggle("stale", quiet);
      if (now - p.seen > GONE_MS) removePlayer(p);
    }
  }, 100);

  // ---------- drawing ----------
  function drawFlute(p) {
    const m = p.last, on = !!(m && m.on && !p.silent);
    const name = (k) => FC.noteName(FC.noteFor(k, m.scale || "major")).replace(/\d+$/, "");
    p.q(".pnote").textContent = m.step == null ? "–" : name(m.step);
    p.q(".pnote").classList.toggle("on", on);
    const cells = p.q(".ladder").children;
    for (let k = 0; k < 8; k++) {
      cells[k].textContent = name(k);
      cells[k].classList.toggle("cur", m.step === k); cells[k].classList.toggle("on", m.step === k && on);
    }
    p.q(".meter i").style.width = ((on ? m.level : 0) * 100).toFixed(0) + "%";
    p.q(".psub").textContent = p.silent ? "not sending (screen locked or out of range?)"
      : `${m.scale === "pentatonic" ? "Pentatonic" : "Song mode (C major)"} · turn for ${m.rollMode === "bend" ? "a bend" : "vibrato"}` + (m.step == null ? " · range not set on the phone yet" : "");
  }
  function drawTheremin(p) {
    const m = p.last, o = p.out, on = !!(o.gate && !p.silent);
    p.q(".pnote").textContent = on ? o.name : "–"; p.q(".pnote").classList.toggle("on", on);
    p.q(".tcm").textContent = on ? `${o.cm.toFixed(1)} cm` : m.ln ? "measuring the table…" : "no book";
    p.q(".psub").textContent = p.silent ? "not sending (screen locked or stopped?)" : m.stopped ? "sonar stopped on the phone"
      : !m.heard ? "the phone can't hear its chirp: volume up, silent mode off"
      : m.clip ? "the phone's mic is clipping: bring its sonar volume down a little"
      : `lowest note ${TH_LOW} cm above the phone, highest ${TH_HIGH} cm · sonar volume ${m.vol}%`;
    const pm = { name: o.name, note: o.note, pos: o.pos, zn: p.mapper.active, mode: p.mapper.o.mode };
    // zone bar
    const zc = p.zc, zg = zc.getContext("2d"), d = devicePixelRatio || 1, W = zc.clientWidth, H = zc.clientHeight;
    if (zc.width !== Math.round(W * d)) { zc.width = Math.round(W * d); zc.height = Math.round(H * d); }
    zg.setTransform(d, 0, 0, d, 0, 0); zg.clearRect(0, 0, W, H);
    zg.font = "12px -apple-system, system-ui, sans-serif"; zg.textAlign = "center"; zg.textBaseline = "middle";
    const notes = pm.zn || [], N = notes.length;
    if (pm.mode !== "glide" && N) {
      for (let k = 0; k < N; k++) {
        const x = k / N * W, w = W / N, lit = on && pm.note === k;
        zg.fillStyle = lit ? p.color : k % 2 ? "#1b1e27" : "#20242f"; zg.fillRect(x + 1, 0, w - 2, H);
        zg.fillStyle = lit ? "#0b0c10" : "#8b90a3"; zg.fillText(TH.midiName(notes[k]), x + w / 2, H / 2);
      }
    } else {
      const grd = zg.createLinearGradient(0, 0, W, 0); grd.addColorStop(0, "#1d2b6b"); grd.addColorStop(1, p.color);
      zg.fillStyle = grd; zg.fillRect(0, 0, W, H);
      zg.fillStyle = "#eef0f6"; zg.fillText("low", 20, H / 2); zg.fillText("high", W - 22, H / 2);
    }
    if (on && pm.pos != null) { zg.fillStyle = "#ffffff"; zg.fillRect(pm.pos * W - 2, 0, 4, H); }
    if (p.map) p.map.draw("change");
  }
  // Card text on a timer (keeps going when the tab is in the background, e.g. behind the video call that shares it);
  // flute cards and the theremin canvases on every animation frame.
  function texts() {
    for (const p of players.values()) {
      if (!p.last) continue;
      p.q(".nm").textContent = p.last.n || `Player ${p.num}`;
      p.q(".lag").textContent = p.last.rtt == null ? "" : `lag ≈ ${Math.round(p.last.rtt / 2)} ms`;
    }
    if (ctx) soundButton();
  }
  setInterval(texts, 200);
  function frame() {
    for (const p of players.values()) { if (p.last) { if (p.inst === "flute") drawFlute(p); else drawTheremin(p); } }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  connect();
})();
