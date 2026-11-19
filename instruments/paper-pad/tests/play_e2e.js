// Phase 2 check of the live instrument, end to end, in headless Chrome/Edge:
//  - the laptop has ONE prompted recording (A); the phone page trains on it in its background worker
//  - the phone's fake mic plays touches cut from a DIFFERENT recording (B): taps, flicks, a scratch and a rub,
//    with B's own room noise between them, in a known order
//  - checks what the laptop was told to play against that order, that sounds start, the explainer gets frames,
//    a fix made on the phone is saved and learned from, the feature cache is written, and delay mode switches on/off.
// Uses your real recordings from data/sessions/ when there are two or more (they stay local: copied to a temp folder,
// the fake-mic WAV is written to a temp folder and deleted). Otherwise it falls back to synthetic sessions.
// Starts its own server on spare ports (8101 / 8544).
// Run (from instruments/paper-pad):  node tests/play_e2e.js [out-dir-for-screenshots]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, startServer, wait } = require("./cdp.js");
const { loadSessions } = require("../tools/phase1.js");
const synth = require("./synth.js");
const OUT = process.argv[2] || os.tmpdir();
const ORDER = ["tap", "flick", "scratch", "tap", "rub", "flick", "tap", "flick"];

function writeWav(file, x, sr) {
  const n = x.length, pcm = Buffer.alloc(44 + n * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, pcm);
}
// The fake mic: B's touches in ORDER, each from "now" to 0.3 s after its prompt ended, with B's quiet room noise between.
function buildMic(B, file) {
  const { meta, audio } = B, sr = meta.sr, parts = [];
  const q = meta.prompts.find((p) => p.kind === "quiet"), room = audio.subarray(q.now + Math.round(0.3 * sr), q.end);
  const gap = (sec) => { for (let need = Math.round(sec * sr); need > 0; need -= room.length) parts.push(room.subarray(0, Math.min(need, room.length))); };
  const used = {};
  gap(3);
  for (const kind of ORDER) {
    const list = meta.prompts.filter((p) => p.kind === kind), p = list[(used[kind] = (used[kind] || 0) + 1) - 1];
    parts.push(audio.subarray(p.now, Math.min(audio.length, p.end + Math.round(0.3 * sr))));
    gap(1.2);
  }
  gap(2);
  const n = parts.reduce((a, p) => a + p.length, 0), x = new Float32Array(n);
  let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  writeWav(file, x, sr);
  return n / sr;
}
// Longest common subsequence length: how much of the expected order came out, in order.
function lcs(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
  return d[a.length][b.length];
}
function copySession(src, dataDir) {
  const to = path.join(dataDir, "sessions", path.basename(src));
  fs.mkdirSync(to, { recursive: true });
  for (const f of ["meta.json", "audio.pcm16"]) fs.copyFileSync(path.join(src, f), path.join(to, f));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-play-")), wav = path.join(tmp, "mic.wav");
  const realRoot = path.join(__dirname, "..", "data", "sessions");
  let real = loadSessions(path.join(__dirname, "..", "data")), A, B, kind;
  if (real.length >= 2) {
    real.sort((a, b) => b.meta.seconds - a.meta.seconds);
    [A, B] = real; kind = "your recordings";
  } else {
    const sd = path.join(tmp, "synth");
    A = { meta: synth.session(sd, "synth-full-1", "next", "full", 3).meta }; A.id = "synth-full-1";
    B = { id: "synth-full-2", ...synth.session(sd, "synth-full-2", "next", "full", 5) }; kind = "SYNTHETIC sessions (record two for a real check)";
  }
  real = null;
  const seconds = buildMic(B, wav);
  console.log(`     trains on ${A.id}, fake mic plays ${ORDER.length} touches from ${B.id} (${kind}), ${seconds.toFixed(1)} s`);

  const srv = await startServer();
  copySession(kind.startsWith("your") ? path.join(realRoot, A.id) : path.join(tmp, "synth", "sessions", A.id), srv.data);
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let fails = 0;
  const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fails++; };
  try {
    const SOUND = `window.__snd = 0; { const st = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...a) { window.__snd++; return st.apply(this, a); }; }`;
    const stage = await browser.page(srv.stage, { dpr: 1.5, init: SOUND });
    await stage.click("#sound");
    const phone = await browser.page(srv.phone, { width: 390, height: 844, mobile: true, dpr: 2 });
    check(await phone.until(`/Learned from 1 recording/.test(document.getElementById("trainInfo").textContent)`, 60000), `phone: trains in the background: "${await phone.text("#trainInfo")}"`);
    const feat = fs.existsSync(path.join(srv.data, "features")) ? fs.readdirSync(path.join(srv.data, "features")) : [];
    check(feat.length === 1 && feat[0].startsWith(A.id + "-v"), `laptop: feature cache written (${feat.join(", ")})`);

    const snd0 = await stage.js("window.__snd");
    const t0 = Date.now();
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone: sensors start (fake mic)");
    // the fake mic loops: watch one pass
    let shot = false;
    while (Date.now() - t0 < (seconds + 1.5) * 1000) {
      if (!shot && (await stage.js(`document.getElementById("paper").classList.contains("tex")`))) {
        await stage.shot(path.join(OUT, "paper-pad-play-stage.png")); await phone.shot(path.join(OUT, "paper-pad-play-phone.png")); shot = true;
      }
      await wait(250);
    }
    const day = new Date().toISOString().slice(0, 10), logs = fs.readdirSync(srv.data).filter((f) => f.startsWith("events-"));
    const evs = logs.flatMap((f) => fs.readFileSync(path.join(srv.data, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
      .filter((e) => e.serverMs >= t0 && e.serverMs <= t0 + (seconds + 1.5) * 1000);
    const raw = evs.filter((e) => (e.type === "hit" && (e.kind === "tap" || e.kind === "flick")) || (e.type === "tex" && e.state)).map((e) => e.type === "hit" ? e.kind : e.state);
    // a scratch or rub that drops out and comes back counts once
    const seq = raw.filter((k, i) => !(i && (k === "scratch" || k === "rub") && raw[i - 1] === k));
    const got = lcs(ORDER, seq);
    console.log(`     expected: ${ORDER.join(" ")}`); console.log(`     played:   ${raw.join(" ")}`);
    check(got >= ORDER.length - 2, `laptop was told to play ${got} of ${ORDER.length} touches in the right order`);
    check(seq.length - got <= 5, `few extra sounds: ${seq.length - got} (the first Phase 2 build played 24 here)`);
    check(seq.includes("scratch") && seq.includes("rub"), "scratch and rub both switch on");
    const hits = evs.filter((e) => e.type === "hit" && e.delay != null).map((e) => e.delay);
    check(hits.length >= 4 && Math.max(...hits) < 120, `phone decides hits ${Math.min(...hits)}–${Math.max(...hits)} ms after the touch`);
    check((await stage.js("window.__snd")) - snd0 >= 5, `stage: plays sounds (${(await stage.js("window.__snd")) - snd0} oscillators started)`);
    check(/%$/.test(await stage.text("#v-quiet")), `stage: confidence bars fed by frames (quiet ${await stage.text("#v-quiet")})`);
    check(evs.length >= 4 && !evs.some((e) => e.type === "frame"), `laptop log: ${evs.length} events kept (frames not logged)`);
    if (!shot) { await stage.shot(path.join(OUT, "paper-pad-play-stage.png")); await phone.shot(path.join(OUT, "paper-pad-play-phone.png")); }

    // fix it while you play: whatever it heard last, say it was "Nothing"
    const heardLast = await phone.text("#nowWhat");
    await phone.click(`#fixRow button[data-fix="${heardLast === "Nothing" ? "tap" : "quiet"}"]`);
    check(await phone.until(`/Got it/.test(document.getElementById("fixInfo").textContent)`, 4000), `phone: fix saved: "${await phone.text("#fixInfo")}"`);
    const fixes = await (await fetch(srv.stage + "train/fixes")).json();
    check(fixes.length === 1 && fixes[0].examples.length >= 1, `laptop: fix stored (${fixes.length ? fixes[0].heard + " -> " + fixes[0].label + ", " + fixes[0].examples.length + " examples" : "none"})`);
    check(await phone.until(`/\\+ 1 fix/.test(document.getElementById("trainInfo").textContent)`, 30000), `phone: retrains with the fix: "${await phone.text("#trainInfo")}"`);
    check(await stage.until(`[...document.querySelectorAll("#rows td")].some((td) => td.textContent.startsWith("fix:"))`, 3000), "stage: shows the fix");

    // delay measurement mode toggles on the laptop (the beep needs real speakers, so no number here)
    await phone.click("#measure");
    check(await stage.until(`/Measuring/.test(document.getElementById("delayLines").textContent)`, 3000), "stage: delay measuring switches on");
    await phone.click("#measure");
    check(await stage.until(`/No beeps|median/.test(document.getElementById("delayLines").textContent)`, 3000), `stage: delay measuring switches off: "${await stage.text("#delayLines")}"`);
    for (const [name, pg] of [["phone", phone], ["stage", stage]]) check(!pg.errors.length, `${name}: no JS errors${pg.errors.length ? ": " + pg.errors.join(" | ") : ""}`);
  } catch (e) {
    console.error(e); fails++;
  } finally {
    browser.close(); srv.stop();
    await wait(300);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(srv.data, { recursive: true, force: true }); } catch {}
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
