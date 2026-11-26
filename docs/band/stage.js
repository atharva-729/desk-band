// Desk Band Together, the stage: makes a room, gives each phone that joins the next instrument (in join order), keeps
// the beat (metronome + chord loop) and plays every knock on the beat grid.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const R = window.Relay, B = window.BandMusic;
  const BPM0 = 70, BPM_MIN = 50, BPM_MAX = 140;
  const GONE_MS = 20000, QUIET_MS = 6000;

  // ---------- room and relay (same as the flute/theremin stage) ----------
  const q = new URLSearchParams(location.search);
  let room = R.cleanRoom(location.hash.slice(1));
  if (!room) { room = R.newRoom(); history.replaceState(null, "", "#" + room); }
  const T = R.topics("band-" + room);
  let client = null, brokerIx = Math.max(0, Math.min(R.BROKERS.length - 1, +q.get("b") || 0));
  const S = window.__band = { room, broker: null, log: [], clicks: 0, dropped: 0 };

  function showJoin() {
    const u = new URL("phone.html", location.href);
    u.hash = ""; u.search = `?r=${room}&b=${brokerIx}&v=7`;   // v: a new address each version, so phones don't use a cached old page
    $("code").textContent = room; $("joinUrl").textContent = u.href; $("brokerName").textContent = R.BROKERS[brokerIx].name;
    try { const qr = qrcode(0, "M"); qr.addData(u.href); qr.make(); $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
    catch { $("qr").textContent = "(QR code didn't load: open the address below on the phone)"; }
    S.joinUrl = u.href;
  }
  showJoin();
  async function connect() {
    $("relayPill").textContent = "connecting…"; $("relayPill").className = "pill";
    try {
      const { client: c, index } = await R.connectAny(brokerIx, {}, (b) => { $("relayPill").textContent = "connecting to " + b.name + "…"; });
      client = c;
      if (index !== brokerIx) { brokerIx = index; showJoin(); }
      S.broker = R.BROKERS[brokerIx].name;
      c.subscribe(T.phones); c.onmessage = onMessage;
      c.onclose = () => { client = null; $("relayPill").textContent = "relay lost: reconnecting…"; $("relayPill").className = "pill bad"; setTimeout(connect, 1000); };
      $("relayPill").textContent = "relay connected · " + S.broker; $("relayPill").className = "pill on";
      hello();
    } catch { $("relayPill").textContent = "no relay reachable: retrying"; $("relayPill").className = "pill bad"; setTimeout(connect, 3000); }
  }
  const send = (topic, m) => { if (client && client.open) client.publish(topic, m); };

  // ---------- the beat ----------
  let ctx = null, master = null, V = null, bpm = BPM0, t0 = 0, nextTick = 0, metroOn = true, prog = B.PROGRESSIONS[0];
  const beatSec = () => 60 / bpm;
  const beatAt = (t) => (t - t0) / beatSec();
  const timeAt = (b) => t0 + b * beatSec();
  const chordAt = (b) => { const name = prog.chords[Math.floor(Math.max(0, b) / 4) % prog.chords.length]; return { name, ...B.CHORDS[name] }; };
  const M = { chord: chordAt, get beatSec() { return beatSec(); } };

  B.PROGRESSIONS.forEach((p) => $("prog").insertAdjacentHTML("beforeend", `<option value="${p.id}">${p.name}</option>`));
  try { const p = B.PROGRESSIONS.find((x) => x.id === localStorage.getItem("band.prog")); if (p) prog = p; } catch {}
  $("prog").value = prog.id;
  $("prog").onchange = () => { prog = B.PROGRESSIONS.find((x) => x.id === $("prog").value); try { localStorage.setItem("band.prog", prog.id); } catch {} drawChords(); };

  function setTempo(n) {
    n = Math.max(BPM_MIN, Math.min(BPM_MAX, n));
    if (ctx) { const b = beatAt(ctx.currentTime); bpm = n; t0 = ctx.currentTime - b * beatSec(); } else bpm = n;   // the beat carries on smoothly
    $("bpm").textContent = bpm; hello();
  }
  $("slower").onclick = () => setTempo(bpm - 5); $("faster").onclick = () => setTempo(bpm + 5);
  $("metro").onclick = () => { metroOn = !metroOn; $("metro").textContent = "Metronome: " + (metroOn ? "on" : "off"); };
  const volume = () => { const v = +$("vol").value / 100; return 1.0 * v * v; };
  $("vol").oninput = () => { if (master) master.gain.setTargetAtTime(volume(), ctx.currentTime, 0.05); };

  $("go").onclick = async () => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      master = ctx.createGain(); master.gain.value = volume();
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp); comp.connect(ctx.destination);
      V = B.Voices(ctx, master);
      metroBus = ctx.createGain(); metroBus.gain.value = 0.8; metroBus.connect(master);
      for (const r of roles) r.bus = makeBus(r);
      await ctx.resume();
      t0 = ctx.currentTime + 0.15; nextTick = 0;
      setInterval(schedule, 25);
    } else if (ctx.state === "running") await ctx.suspend();
    else { await ctx.resume(); const b = Math.ceil(beatAt(ctx.currentTime)); nextTick = Math.max(nextTick, b); }
    goButton();
  };
  let metroBus = null;
  function goButton() { const on = ctx && ctx.state === "running"; $("go").textContent = on ? "Band playing (click to pause)" : ctx ? "Paused: click to play" : "Start the band"; $("go").classList.toggle("on", !!on); }

  // Look ahead and put the metronome clicks and arpeggiator notes on the audio clock. Background tabs only get a
  // timer about once a second, so look further ahead then.
  const visual = [];   // { t, fn } things to show when their sound plays
  function schedule() {
    if (!ctx || ctx.state !== "running") return;
    const ahead = document.hidden ? 1.5 : 0.15;
    if (timeAt(nextTick) < ctx.currentTime - 0.05) nextTick = Math.ceil(beatAt(ctx.currentTime) * 4) / 4;   // after a pause
    while (timeAt(nextTick) < ctx.currentTime + ahead) {
      const b = nextTick, t = timeAt(b);
      if (b % 1 === 0) {
        if (metroOn) { V.click(metroBus, t, b % 4 === 0); S.clicks++; }
        visual.push({ t, fn: () => showBeat(b) });
      }
      for (const r of roles) if (r.def.tick && r.bus) { const lbl = r.def.tick(b, t, r.mem, V, r.bus, M); if (lbl) visual.push({ t, fn: () => flash(r, lbl) }); }
      nextTick += 0.25;
    }
  }
  function runVisuals() {
    if (ctx) { const now = ctx.currentTime; for (let i = visual.length - 1; i >= 0; i--) if (visual[i].t <= now) { visual[i].fn(); visual.splice(i, 1); } }
    requestAnimationFrame(runVisuals);
  }
  requestAnimationFrame(runVisuals);
  setInterval(() => { if (document.hidden) runVisuals_once(); }, 200);
  function runVisuals_once() { if (!ctx) return; const now = ctx.currentTime; for (let i = visual.length - 1; i >= 0; i--) if (visual[i].t <= now) { visual[i].fn(); visual.splice(i, 1); } }

  let curBeat = -1;
  function showBeat(b) {
    curBeat = b;
    [...$("beats").children].forEach((el, k) => el.classList.toggle("on", k === b % 4));
    drawChords();
  }
  function drawChords() {
    const bar = curBeat < 0 ? 0 : Math.floor(curBeat / 4) % prog.chords.length;
    $("chords").innerHTML = prog.chords.map((c, k) => `<div class="${k === bar ? "cur" : ""}">${c}</div>`).join("");
  }
  drawChords();

  // ---------- instruments and players ----------
  // First come, first served: a new phone starts on the first free instrument (so knocking works straight away) and can
  // add or drop any instrument nobody else has.
  const roles = B.ROLES.map((def, k) => ({ def, k, player: null, mem: {}, muted: false, bus: null, lastSlot: -1e9 }));
  const players = new Map();   // phone id -> { id, name, roles (set of instrument indexes), seen, knocks, felt, rtt }
  const roleByKey = (k) => roles.find((r) => r.def.key === k);
  S.players = players; S.roles = roles;
  function makeBus(r) { const g = ctx.createGain(); g.gain.value = r.muted ? 0 : r.def.gain; g.connect(master); return g; }
  roles.forEach((r) => {
    const el = document.createElement("div");
    el.className = "rc free"; el.style.setProperty("--c", r.def.color);
    el.innerHTML = `<div class="flash"></div><div class="h"><span class="num">${r.k + 1}</span><span class="nm">${r.def.name}</span><button class="ghost mute">Mute</button></div>
      <div class="who"></div><div class="last">–</div><div class="how">${r.def.how}</div><div class="st"></div>`;
    r.el = el; r.q = (s) => el.querySelector(s);
    r.q(".mute").onclick = () => { r.muted = !r.muted; r.q(".mute").textContent = r.muted ? "Muted" : "Mute"; r.q(".mute").classList.toggle("muted", r.muted); if (r.bus) r.bus.gain.setTargetAtTime(r.muted ? 0 : r.def.gain, ctx.currentTime, 0.03); };
    $("roles").appendChild(el);
  });
  // A phone can hold several instruments at once: one tap plays all of them. Tapping a free one adds it, tapping one
  // of your own drops it. Others' instruments are off limits (first come, first served).
  function take(p, r) { r.player = p.id; r.mem = {}; r.lastSlot = -1e9; p.roles.add(r.k); }
  function drop(p, r) { if (r.player === p.id) r.player = null; p.roles.delete(r.k); }
  function assign(p) { if (!p.roles.size) { const r = roles.find((x) => !x.player); if (r) take(p, r); } }
  function release(p) { for (const k of p.roles) if (roles[k].player === p.id) roles[k].player = null; players.delete(p.id); hello(); }
  function playerFor(id) {
    let p = players.get(id);
    if (!p) { p = { id, name: "", roles: new Set(), seen: 0, knocks: 0, felt: 0, rtt: null }; players.set(id, p); assign(p); hello(); tellRole(p); }
    p.seen = performance.now();
    return p;
  }
  const keysOf = (p) => [...p.roles].sort((a, b) => a - b).map((k) => roles[k].def.key);
  const tellRole = (p) => send(T.to(p.id), { t: "role", role: keysOf(p) });

  // Every second: who has which instrument, so each phone can black out the taken ones.
  function hello() {
    const map = {}, who = {};
    for (const p of players.values()) map[p.id] = keysOf(p);
    for (const r of roles) if (r.player) { const p = players.get(r.player); who[r.def.key] = (p && p.name) || "someone"; }
    send(T.stage, { t: "hello", bpm, roles: map, who, full: roles.every((r) => r.player) });
  }
  setInterval(hello, 1000);

  function onMessage(topic, s) {
    const id = topic.slice(topic.lastIndexOf("/") + 1);
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.t === "bye") { const p = players.get(id); if (p) release(p); return; }
    const p = playerFor(id);
    if (m.n) p.name = String(m.n).slice(0, 24);
    if (m.rtt != null) p.rtt = m.rtt;
    if (m.t === "ping") { send(T.to(id), { t: "pong", ts: m.ts }); return; }
    if (m.t === "join") { assign(p); tellRole(p); return; }
    if (m.t === "pick") {   // toggle an instrument: add it if free, drop it if it's yours
      const r = roleByKey(m.k);
      if (r && r.player === id) drop(p, r); else if (r && !r.player) take(p, r);
      tellRole(p); hello(); return;
    }
    if (m.t === "hit") { if (m.f) p.felt++; hit(p, Math.max(0.15, Math.min(1, +m.v || 0.5))); }
  }

  // A knock: play it on the next free slot of this instrument's grid (half a beat, or a beat), at least 30 ms away.
  function hit(p, v) {
    p.knocks++;
    for (const k of p.roles) hitOne(roles[k], v);
  }
  function hitOne(r, v) {
    if (!ctx || ctx.state !== "running") { flash(r, "(start the band)"); return; }
    const g = r.def.grid, bMin = beatAt(ctx.currentTime + 0.03);
    let slot = Math.ceil(bMin / g - 1e-9) * g;
    if (slot <= r.lastSlot) slot = r.lastSlot + g;           // knocking faster than the grid: the next slot along
    if (slot - bMin > 2 * g) { S.dropped++; return; }         // way too fast: drop it rather than pile up
    r.lastSlot = slot;
    const t = timeAt(slot), lbl = r.def.play(slot, t, v, r.mem, V, r.bus, M);
    S.log.push({ role: r.def.key, slot, v, lbl, at: ctx.currentTime, t });
    if (S.log.length > 500) S.log.shift();
    visual.push({ t, fn: () => flash(r, lbl) });
  }
  function flash(r, lbl) {
    r.q(".last").textContent = lbl;
    r.el.classList.add("hit"); clearTimeout(r.ft); r.ft = setTimeout(() => r.el.classList.remove("hit"), 120);
  }

  // card text, and drop phones that went away
  setInterval(() => {
    const now = performance.now();
    for (const p of [...players.values()]) if (now - p.seen > GONE_MS) release(p);
    for (const r of roles) {
      const p = r.player ? players.get(r.player) : null;
      r.el.classList.toggle("free", !p);
      r.q(".who").textContent = p ? (p.name || "Player") : "Free: anyone can pick this";
      r.q(".st").textContent = !p ? "" : (now - p.seen > QUIET_MS ? "not heard from for a while · " : "") +
        `${p.knocks} knocks` + (p.felt ? ` (${p.felt} felt, not heard)` : "") + (p.rtt != null ? ` · lag ≈ ${Math.round(p.rtt / 2)} ms` : "");
    }
    goButton();
  }, 250);

  connect();
})();
