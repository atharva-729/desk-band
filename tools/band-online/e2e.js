// End-to-end check of Desk Band Together (docs/band) through the real public relay, in headless Chrome:
// a stage and up to 10 phones. The fake mic knocks every 0.6 s; a test hook makes each phone "feel" its knocks (or not).
// Needs the internet. Run: node tools/band-online/e2e.js [out-dir]
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { launch, wait } = require("../play-online/cdp");
const ROOT = path.join(__dirname, "..", "..", "docs");

function serve(port) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/+/, "");
    let full = path.join(ROOT, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, "index.html");
    if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
// knocks: a 25 ms decaying burst every 0.6 s over a quiet room
function knockWav(file) {
  const sr = 48000, n = Math.round(sr * 2.4), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const k = i % Math.round(sr * 0.6), e = k < sr * 0.025 ? Math.exp(-k / (sr * 0.005)) : 0, strong = Math.floor(i / (sr * 0.6)) % 2 ? 0.25 : 0.6;
    const v = (Math.random() * 2 - 1) * (0.0004 + strong * e);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf); return file;
}
// Runs in each phone: a resting phone's motion noise, and (while window.__feel) a jolt each time the mic hears a knock.
const FAKE_MOTION = `
  window.__feel = true;
  const shake = (m) => window.dispatchEvent(new DeviceMotionEvent("devicemotion", { acceleration: { x: m, y: m * 0.5, z: m * 0.3 }, accelerationIncludingGravity: { x: 0, y: 0, z: -9.8 } }));
  setInterval(() => shake(0.004 * (Math.random() - 0.5)), 16);
  let dc;
  Object.defineProperty(window, "DeskCore", { configurable: true, get: () => dc, set: (v) => {
    const P = v.Detector.prototype, proc = P.process;
    P.process = function (chunk, now, onHit) { return proc.call(this, chunk, now, (h) => { if (window.__feel) { shake(0.25); shake(0.12); } onHit(h); }); };
    dc = v; } });`;

(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "band-e2e-"));
  fs.mkdirSync(out, { recursive: true });
  const port = 8300 + Math.floor(Math.random() * 50), srv = await serve(port), base = `http://127.0.0.1:${port}/band/`;
  const wav = knockWav(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "band-mic-")), "knocks.wav"));
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
  const PHONE = { width: 390, height: 844, mobile: true, dpr: 1, init: FAKE_MOTION };
  const NAMES = ["Asha", "Ben", "Chen", "Dev", "Esi", "Farah", "Gil", "Hana", "Ivo", "Jun", "Kai"];
  const phones = [];
  const join = async (k) => {
    const p = await chrome.page(S.url + "&n=" + NAMES[k], PHONE);
    await p.click("#start");
    phones[k] = p; return p;
  };
  let S;
  try {
    const stage = await chrome.page(base, { width: 1440, height: 1000 });
    check(await stage.until(`document.getElementById("relayPill").textContent.startsWith("relay connected")`, 20000), "stage connects to the relay");
    S = { url: await stage.js("window.__band.joinUrl") };
    console.log("  join: " + S.url + " on " + (await stage.js("window.__band.broker")));
    check(/band\/phone\.html\?r=[A-Z0-9]{5}&b=\d/.test(S.url), "QR points to the band phone page with the room");
    await stage.click("#go");
    check(await stage.until(`document.getElementById("go").textContent.startsWith("Band playing")`), "the band starts");
    await wait(2500);
    check((await stage.js("window.__band.clicks")) >= 2, "metronome clicks on the beat");
    check((await stage.text("#bpm")) === "70", "tempo starts slow, at 70 BPM");

    // ---- three phones join, in order ----
    for (let k = 0; k < 3; k++) await join(k);
    check(await stage.until(`(() => { const r = window.__band.roles; return ["Asha","Ben","Chen"].every((n, k) => r[k].player && window.__band.players.get(r[k].player).name === n); })()`, 15000),
      "join order: 1st Drums, 2nd Strings, 3rd Synth lead");
    check(await phones[0].until(`document.getElementById("roleName").textContent === "Drums"`, 8000), "the phone shows its instrument (Drums)");
    check(await stage.until(`window.__band.log.filter((e) => e.role === "drums").length >= 4 && window.__band.log.some((e) => e.role === "strings")`, 15000), "knocks from the phones play on the stage");
    const log = await stage.js("window.__band.log");
    const drums = log.filter((e) => e.role === "drums"), strings = log.filter((e) => e.role === "strings");
    check(drums.every((e) => e.slot % 0.5 === 0) && strings.every((e) => e.slot % 1 === 0), "every knock lands on the grid (drums half-beats, strings beats)");
    check(drums.every((e) => { const p = e.slot % 4; return p % 1 ? e.lbl === "hi-hat" : p === 1 || p === 3 ? e.lbl === "snare" : e.lbl.startsWith("kick"); }), "drums: kick on 1 and 3, snare on 2 and 4, hi-hat between");
    check(log.every((e) => e.t >= e.at), "nothing is scheduled in the past");

    // ---- the "felt" gate ----
    await phones[2].js("window.__feel = false");
    const before = await phones[2].js("window.__band.ignored");
    await wait(3000);
    check((await phones[2].js("window.__band.ignored")) > before, "a sound the phone didn't feel is ignored (speaker or voice)");
    check(await stage.until(`/sounds ignored/.test(window.__band.roles[2].el.querySelector(".st").textContent)`, 6000), "the stage card shows the ignored count");
    await phones[2].js("window.__feel = true");

    // ---- tempo ----
    await stage.click("#faster");
    check((await stage.text("#bpm")) === "75", "+5 raises the tempo");
    check(await phones[0].until(`window.__band.link.bpm === 75`, 5000), "phones hear the new tempo");

    // ---- someone leaves, the next joiner takes the free instrument ----
    await phones[1].js("location.href = 'about:blank'");
    check(await stage.until(`!window.__band.roles[1].player`, 8000), "leaving frees Strings");
    await join(3);
    check(await stage.until(`window.__band.roles[1].player && window.__band.players.get(window.__band.roles[1].player).name === "Dev"`, 15000), "the next person to join gets the free Strings");

    // ---- fill the band: 9 instruments, the 10th phone is told it's full ----
    for (let k = 4; k < 11; k++) await join(k);   // 9 in the band (Ben left) + 1 too many
    check(await stage.until(`window.__band.roles.every((r) => r.player)`, 20000), "all 9 instruments taken");
    check(await phones[10].until(`document.getElementById("roleName").textContent === "The band is full"`, 10000), "the 10th phone is told the band is full");
    await wait(6000);
    const all = await stage.js("window.__band.log");
    const seen = new Set(all.map((e) => e.role));
    check(["drums", "strings", "synth", "bass", "piano", "marimba", "shakers", "desi", "arp"].every((k) => seen.has(k)), "all 9 instruments played: " + [...seen].join(", "));
    const lags = await stage.js(`[...window.__band.players.values()].filter((p) => p.rtt != null).map((p) => Math.round(p.rtt / 2))`);
    console.log("  lag one way per phone (ms): " + lags.join(", "));
    await stage.shot(path.join(out, "stage.png")); await phones[0].shot(path.join(out, "phone-drums.png")); await phones[10].shot(path.join(out, "phone-full.png"));
    const errs = [stage, ...phones.filter(Boolean)].flatMap((p) => p.errors);
    check(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  } catch (e) { console.log("FAIL exception: " + e.stack); failed++; }
  finally { chrome.close(); srv.close(); }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  console.log("screenshots in " + out);
  process.exit(failed ? 1 : 0);
})();
