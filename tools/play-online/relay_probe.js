// Checks each public broker from this computer: does it connect, and how long does a message take to come back?
// Two clients (like a phone and a stage) on one broker; the "phone" sends 40 pings, the "stage" answers each one.
// Run: node tools/play-online/relay_probe.js
const Relay = require("../../docs/play/relay.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(b) {
  const room = "PROBE" + Relay.newRoom(3), T = Relay.topics(room), id = Relay.newId();
  const t0 = Date.now();
  const stage = await new Relay.Mqtt(b.url).connect();
  const connectMs = Date.now() - t0;
  const phone = await new Relay.Mqtt(b.url).connect();
  stage.subscribe(T.phones); phone.subscribe(T.to(id));
  stage.onmessage = (topic, s) => { const m = JSON.parse(s); if (m.t === "ping") stage.publish(T.to(id), { t: "pong", k: m.k }); };
  const sent = new Map(), rtts = [];
  phone.onmessage = (topic, s) => { const m = JSON.parse(s); if (m.t === "pong" && sent.has(m.k)) rtts.push(Date.now() - sent.get(m.k)); };
  await wait(600);   // let the subscriptions settle
  for (let k = 0; k < 40; k++) { sent.set(k, Date.now()); phone.publish(T.phone(id), { t: "ping", k }); await wait(50); }
  await wait(1500);
  stage.close(); phone.close();
  rtts.sort((a, b) => a - b);
  const q = (f) => rtts[Math.min(rtts.length - 1, Math.floor(f * rtts.length))];
  return { connectMs, got: rtts.length, median: q(0.5), p90: q(0.9), max: rtts[rtts.length - 1] };
}

(async () => {
  for (const b of Relay.BROKERS) {
    try {
      const r = await probe(b);
      console.log(`${b.name.padEnd(10)} connect ${r.connectMs} ms · ${r.got}/40 back · round trip median ${r.median} ms, 90% ${r.p90} ms, worst ${r.max} ms`);
    } catch (e) { console.log(`${b.name.padEnd(10)} FAILED: ${e.message}`); }
  }
  process.exit(0);
})();
