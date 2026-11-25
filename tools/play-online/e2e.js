// End-to-end check of the online pages (docs/play) through the real public relay:
// a stage, then a flute phone (scripted tilt + a fake mic that "blows") and a theremin phone (simulated sonar), all in
// headless Chrome. Needs the internet. Serves docs/play itself on a spare localhost port.
// Run: node tools/play-online/e2e.js [out-dir-for-screenshots]
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const { launch, wait } = require("./cdp");
const ROOT = path.join(__dirname, "..", "..", "docs", "play");

function serve(port) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/+/, "") || "index.html";
    const full = path.join(ROOT, rel);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// Runs inside the flute phone: a phone held sideways. window.__turn (degrees) is how far it's tilted.
const FAKE_SENSORS = `
  window.__turn = 0;
  setInterval(() => {
    const t = performance.now() / 1000, r = Math.PI / 180;
    const turn = (window.__turn + 0.6 * Math.sin(t * 3)) * r, lift = 3 * Math.sin(t * 1.3) * r;
    const g = [-9.81 * Math.cos(turn) * Math.cos(lift), 9.81 * Math.sin(lift), 9.81 * Math.sin(turn) * Math.cos(lift)];
    window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: g[0], y: g[1], z: g[2] } }));
  }, 1000 / 60);`;

// Fake mic, looping: 1 s of a quiet room, then 1 s of "blowing" (loud low-passed noise). Written to a temp folder.
function noiseWav(file) {
  const sr = 48000, n = sr * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const v = i < sr ? (Math.random() * 2 - 1) * 0.0005 : (y += 0.12 * ((Math.random() * 2 - 1) * 0.5 - y));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "play-e2e-"));
  fs.mkdirSync(out, { recursive: true });
  const port = 8190 + Math.floor(Math.random() * 50);
  const srv = await serve(port), base = `http://127.0.0.1:${port}/`;
  const wav = noiseWav(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "play-mic-")), "noise.wav"));
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
  const PHONE = { width: 390, height: 844, mobile: true, dpr: 2 };
  try {
    // ---- stage ----
    const stage = await chrome.page(base, { width: 1440, height: 900 });
    check(await stage.until(`document.getElementById("relayPill").textContent.startsWith("relay connected")`, 20000), "stage connects to the public relay");
    const st = await stage.js(`({ room: window.__stage.room, url: window.__stage.joinUrl, broker: window.__stage.broker, qr: !!document.querySelector("#qr svg") })`);
    console.log(`  room ${st.room} on ${st.broker} · join ${st.url}`);
    check(st.qr && /join\.html\?r=[A-Z0-9]{5}&b=\d/.test(st.url), "stage shows a QR code for join.html with the room");
    await stage.click("#startBig");
    check(await stage.until(`document.getElementById("startBig").textContent === "Sound on"`), "stage sound starts");

    // ---- join page ----
    const join = await chrome.page(st.url, PHONE);
    check((await join.text("#room")) === st.room, "join page shows the room from the QR link");
    await join.js(`document.getElementById("name").value = "Flute tester"`);
    await join.click("#goFlute");
    await wait(1500);
    const flUrl = await join.js("location.href");
    check(/flute\.html\?r=[A-Z0-9]+&b=\d&n=Flute\+tester/.test(flUrl), "join page opens the flute with room, broker and name");
    join.ws.close();

    // ---- flute phone ----
    const flute = await chrome.page(flUrl + "&fast", { ...PHONE, init: FAKE_SENSORS });
    await flute.click("#start");
    check(await flute.until(`!document.getElementById("main").classList.contains("hidden")`), "flute phone starts sensors and mic");
    check(await flute.until(`document.getElementById("link").classList.contains("ok")`, 15000), "flute phone sees the stage");
    check(await stage.until(`[...window.__stage.players.values()].some((p) => p.inst === "flute")`, 10000), "a flute card appears on the stage");
    check(await stage.until(`document.querySelector(".pc .nm") && document.querySelector(".pc .nm").textContent === "Flute tester"`), "the card shows the player's name");
    await flute.click("#calFirst");
    await flute.until(`document.getElementById("ovPrompt").textContent.includes("HIGHEST")`);
    await flute.js("window.__turn = 48");
    check(await flute.until(`document.getElementById("needCal").classList.contains("hidden") && document.getElementById("overlay").classList.contains("hidden")`, 8000), "flute range set");
    await flute.js("window.__turn = 2");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "flute"); return p && p.last && p.last.step === 0; })()`, 6000), "stage gets note 1 at the low end");
    await flute.js("window.__turn = 46");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "flute"); return p && p.last && p.last.step === 7; })()`, 6000), "stage gets note 8 at the high end");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "flute"); return p && p.voice && p.voice.level > 0.1 && p.last.on; })()`, 12000), "fake blowing plays the flute on the stage");
    check(await stage.until(`/lag ≈ \\d+ ms/.test(document.querySelector(".pc .lag").textContent)`, 8000), "stage shows the flute's lag");

    // ---- theremin phone (simulated sonar), playing at the same time ----
    const ther = await chrome.page(st.url.replace("join.html", "theremin.html") + "&n=Book&sim", PHONE);
    await ther.click("#start");
    check(await ther.until(`document.getElementById("link").classList.contains("ok")`, 15000), "theremin phone sees the stage");
    check(!(await ther.js(`document.getElementById("local").checked`)), "theremin phone doesn't play its own sound when a stage is there");
    check(await stage.until(`window.__stage.players.size === 2`, 10000), "two players on the stage at once");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p && p.cols > 50 && p.last.g === 1 && p.voice.gain > 0; })()`, 20000), "theremin echo map and notes reach the stage, and it sounds");
    const tr = await stage.js(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return { rows: p.last.rows, name: p.last.name, cm: p.last.cm }; })()`);
    console.log(`  theremin: ${tr.rows} map rows, playing ${tr.name} at ${tr.cm} cm`);
    const rates = await stage.js(`(async () => { const c = {}; for (const p of window.__stage.players.values()) c[p.inst] = p.last.seq; await new Promise((r) => setTimeout(r, 2000)); const o = {}; for (const p of window.__stage.players.values()) o[p.inst] = (p.last.seq - c[p.inst]) / 2; return o; })()`);
    console.log(`  messages a second reaching the stage: flute ${rates.flute}, theremin ${rates.theremin}`);
    check(rates.flute >= 25 && rates.theremin >= 20, "both phones keep up their send rate through the relay");
    await wait(1500);
    await stage.shot(path.join(out, "stage.png")); await flute.shot(path.join(out, "flute.png")); await ther.shot(path.join(out, "theremin.png"));

    // ---- leaving ----
    await ther.click("#stop");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p && p.last.stopped; })()`, 5000), "stopping the sonar shows on the stage");
    await ther.js("location.href = 'about:blank'");
    check(await stage.until(`window.__stage.players.size === 1`, 8000), "closing the theremin page removes its card");

    // ---- theremin alone (no stage): plays on the phone ----
    const solo = await chrome.page(base + "theremin.html?sim", PHONE);
    check(await solo.js(`document.getElementById("local").checked`), "theremin with no room plays on the phone by default");
    await solo.click("#start");
    check(await solo.until(`window.__ht && window.__ht.synth && window.__ht.synth.gain > 0`, 15000), "solo theremin makes sound on the phone");
    check((await solo.text("#linkTxt")).startsWith("On its own"), "solo theremin says it's on its own");

    const errs = [stage, flute, ther, solo].flatMap((p) => p.errors);
    check(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  } catch (e) { console.log("FAIL exception: " + e.stack); failed++; }
  finally { chrome.close(); srv.close(); }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  console.log("screenshots in " + out);
  process.exit(failed ? 1 : 0);
})();
