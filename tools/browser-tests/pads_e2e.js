// End-to-end plumbing check for 4 / 5 / 6 / 8 pads, phone page + stage page, with a FAKE MIC.
// Synthetic knocks are fed in as the microphone. The prompts are random and the audio isn't, so the accuracy numbers
// it prints are meaningless: this checks plumbing (pad count sync, names, training per count, check round, play,
// migration of old 4-pad training), not accuracy.
// Starts its own server on spare ports with a throwaway data folder. Run:  node tools/browser-tests/pads_e2e.js [out-dir]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, startServer, wait } = require("./cdp.js");
const OUT = process.argv[2] || os.tmpdir();

// A WAV of decaying knocks, ~3 per second, cycling through 5 different "spots". Written to a temp folder, never the repo.
function fakeKnocks(file) {
  const sr = 48000, secs = 20, n = sr * secs, pcm = Buffer.alloc(44 + n * 2), freqs = [600, 1500, 3200, 5500, 900];
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = (rnd() - 0.5) * 0.0006;
  for (let k = 0, t = 0.3; t < secs - 0.2; k++, t += 0.33) {
    const s0 = Math.round(t * sr), f = freqs[k % 5], a = 0.15 + 0.25 * rnd();
    for (let i = 0; i < sr * 0.08; i++) sig[s0 + i] += a * Math.exp(-i / (sr * 0.012)) * Math.sin((2 * Math.PI * f * i) / sr);
  }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sig[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, pcm);
}
const fakeSamples = (n, zones) => Array.from({ length: n }, (_, i) => ({ zone: 1 + (i % zones), f: Array.from({ length: 26 }, () => Math.random()) }));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-e2e-")), wav = path.join(tmp, "knocks.wav");
  fakeKnocks(wav);
  const srv = await startServer({ http: 8102, https: 8545 });
  // Training saved before pad counts existed: the old server file name, 4 pads. Must still load as 4-pad training.
  fs.writeFileSync(path.join(srv.data, "training-45ms.json"), JSON.stringify(fakeSamples(28, 4)));
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let fails = 0;
  const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fails++; };
  try {
    // 150% display scaling, like most Windows laptops: canvases must not grow with each knock (a past bug crashed the tab)
    const SOUND = `window.__snd = 0; for (const P of [AudioBufferSourceNode, OscillatorNode]) { const st = P.prototype.start; P.prototype.start = function (...a) { window.__snd++; return st.apply(this, a); }; }`;
    const stage = await browser.page(srv.stage, { dpr: 1.5, init: SOUND });
    await stage.click("#go");
    check(await stage.until(`window.__snd >= 2`, 2000), "stage: start chime plays");
    const canvasSizes = () => stage.js(`[...document.querySelectorAll("canvas")].map((c) => c.clientHeight).join(",")`);
    // expose the phone's AudioContext and mic stream so the test can break them the way an iPhone can
    const PHONE_PROBE = `(() => {
      const AC = window.AudioContext; window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__ctx = this; } };
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => (window.__stream = await gum(c));
    })();`;
    const phone = await browser.page(srv.phone, { width: 390, height: 844, mobile: true, init: PHONE_PROBE });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone sensors start (fake mic)");
    check(await phone.until(`/Loaded 28 training taps/.test(document.getElementById("acc").textContent) || !document.getElementById("play").disabled`),
      "old 4-pad training file (training-45ms.json) loads as 4-pad training");
    check(!(await phone.js(`document.getElementById("play").disabled`)), "4 pads: ready to play with the migrated taps");
    await phone.shot(path.join(OUT, "phone-4-pads.png")); await stage.shot(path.join(OUT, "stage-4-pads.png"));

    for (const N of [5, 6, 8]) {
      const per = N <= 5 ? 15 : 10; // knocks per pad the phone suggests
      await phone.select("#padCount", N);
      check(await stage.until(`document.querySelectorAll(".pad").length === ${N}`, 4000), `${N} pads: stage follows live (SSE)`);
      check(await phone.js(`document.querySelectorAll("#grid .pad").length === ${N}`), `${N} pads: phone grid has ${N} pads`);
      check(await phone.js(`document.getElementById("play").disabled`), `${N} pads: starts untrained (its own training store)`);
      check((await phone.js(`document.getElementById("perPad").value`)) === String(per), `${N} pads: defaults to ${per} knocks per pad`);
      // rename pad N; the stage should show the new name
      const nm = `Spot ${N} test`;
      await phone.js(`(() => { const i = document.querySelectorAll("#names input")[${N - 1}]; i.value = ${JSON.stringify(nm)}; i.dispatchEvent(new Event("input")); })()`);
      check(await stage.until(`[...document.querySelectorAll(".pad .lab")].some((e) => e.textContent === ${JSON.stringify(nm)})`, 4000), `${N} pads: pad name reaches the stage`);
      check(await stage.js(`document.querySelectorAll("#fps .fp").length === ${N} && document.querySelectorAll("#bars .b").length === ${N}`), `${N} pads: ${N} fingerprint cards and confidence bars`);
      // guided teaching, N x 10 prompted knocks
      check((await phone.text("#guided")) === `Teach all spots (${N * per} knocks)`, `${N} pads: teach button says ${N * per} knocks`);
      await phone.click("#guided");
      const t0 = Date.now();
      const taught = await phone.until(`!document.getElementById("play").disabled && document.getElementById("promptBox").classList.contains("hidden")`, 90000);
      const counts = await phone.js(`[...document.querySelectorAll("#grid .pad .c")].map((e) => parseInt(e.textContent))`);
      check(taught && counts.length === N && counts.every((c) => c === per), `${N} pads: guided teaching done in ${Math.round((Date.now() - t0) / 1000)} s, taps per pad ${counts.join(",")}`);
      // check-accuracy round: 2 per pad, prompted, not added to training
      await phone.click("#check");
      const checked = await phone.until(`/^Check: \\d+ of ${2 * N} right/.test(document.getElementById("checkResult").textContent)`, 60000);
      check(checked, `${N} pads: check round finished: "${await phone.text("#checkResult")}"`);
      const after = await phone.js(`[...document.querySelectorAll("#grid .pad .c")].map((e) => parseInt(e.textContent))`);
      check(after.every((c) => c === per), `${N} pads: check knocks were not added to training`);
      check(await stage.until(`/Check round/.test(document.getElementById("trained").textContent)`, 3000), `${N} pads: stage shows the check result`);
      // play: hits arrive at the stage
      const before = await stage.js(`parseInt(document.getElementById("count").textContent)`);
      const sizes0 = await canvasSizes();
      await stage.js(`window.__snd = 0`);
      await phone.click("#play");
      check(await stage.until(`parseInt(document.getElementById("count").textContent) >= ${before + 8}`, 10000), `${N} pads: hits reach the stage while playing`);
      check((await stage.js(`window.__snd`)) >= 8, `${N} pads: every hit makes a sound on the stage`);
      const sizes1 = await canvasSizes();
      check(sizes0 === sizes1, `${N} pads: explainer charts keep their size at 150% scaling after 8+ hits (${sizes1})`);
      await stage.shot(path.join(OUT, `stage-${N}-pads.png`));
      await phone.js(`window.scrollTo(0, 0)`); await phone.shot(path.join(OUT, `phone-${N}-pads.png`));
      await phone.click("#stop");
      const saved = path.join(srv.data, `training-${N}p-45ms.json`);
      await wait(900);
      check(fs.existsSync(saved) && JSON.parse(fs.readFileSync(saved, "utf8")).length === N * per, `${N} pads: laptop copy saved as training-${N}p-45ms.json`);
    }
    // back to 4: the 4-pad taps are still there
    await phone.select("#padCount", 4);
    check(await phone.until(`!document.getElementById("play").disabled`, 4000), "back to 4 pads: 4-pad training still there");
    check(await stage.until(`document.querySelectorAll(".pad").length === 4`, 4000), "back to 4 pads: stage follows");
    const cfg = JSON.parse(fs.readFileSync(path.join(srv.data, "pads.json"), "utf8"));
    check(cfg.count === 4 && cfg.names["8"] === "Spot 8 test", `pads.json on the laptop: ${JSON.stringify(cfg)}`);

    // The mic must keep listening after "Reset all" (it used to go silent until a reload), and come back if paused
    const tapTotal = `[...document.querySelectorAll("#grid .pad .c")].map((e) => parseInt(e.textContent) || 0).reduce((a, b) => a + b, 0)`;
    const knocksRegister = async (label) => {
      await phone.click("#guided");
      check(await phone.until(`${tapTotal} >= 3`, 8000), label);
      await phone.click("#stop"); await wait(300);
    };
    await phone.click("#reset");
    check(/Tap again/.test(await phone.text("#reset")), "Reset all asks for a second tap (no native pop-up)");
    await phone.click("#reset");
    check((await phone.js(tapTotal)) === 0, "Reset all clears the taps");
    await phone.send("HeapProfiler.enable"); await phone.send("HeapProfiler.collectGarbage"); await wait(300);
    await knocksRegister("after Reset all + garbage collection, knocks still register (no reload)");
    await phone.click("#reset"); await phone.click("#reset");
    await phone.js(`window.__ctx.suspend()`);
    check(await phone.until(`!document.getElementById("micWarn").classList.contains("hidden")`, 3000), "paused audio: 'Mic paused' button appears");
    await phone.click("#micWarn");
    check(await phone.until(`document.getElementById("micWarn").classList.contains("hidden")`, 3000), "paused audio: one tap brings the mic back");
    await knocksRegister("paused audio: knocks register again");
    await phone.click("#reset"); await phone.click("#reset");
    await phone.js(`window.__stream.getTracks().forEach((t) => t.stop())`);
    check(await phone.until(`!document.getElementById("micWarn").classList.contains("hidden")`, 3000), "mic track ended: 'Mic paused' button appears");
    await phone.click("#micWarn");
    check(await phone.until(`document.getElementById("micWarn").classList.contains("hidden")`, 5000), "mic track ended: one tap sets the mic up again");
    await knocksRegister("mic track ended: knocks register again");

    // Taps kept only in the phone's browser under the old key (deskband.v2.<ms>) also become 4-pad taps
    fs.rmSync(path.join(srv.data, "training-45ms.json"));
    await phone.js(`localStorage.clear(); localStorage.setItem("deskband.v2.45", ${JSON.stringify(JSON.stringify(fakeSamples(32, 4)))})`);
    await phone.reload(); await phone.click("#start");
    check(await phone.until(`[...document.querySelectorAll("#grid .pad .c")].map((e) => parseInt(e.textContent)).reduce((a, b) => a + b, 0) === 32`, 6000),
      "old phone storage (deskband.v2.45) migrates to deskband.v3.4p.45");
    check(await phone.js(`!!localStorage.getItem("deskband.v3.4p.45")`), "migrated key written");

    // the session log reached the laptop, one line per knock
    await wait(1200);
    const logs = fs.readdirSync(srv.data).filter((f) => f.startsWith("log-"));
    const lines = logs.length ? fs.readFileSync(path.join(srv.data, logs[0]), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)) : [];
    const kinds = {}; for (const l of lines) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
    check(kinds.train >= 75 + 60 + 80 && kinds.check >= 10 + 12 + 16 && kinds.play > 0 && kinds.mic >= 1 && kinds.reset >= 1, `session log on the laptop: ${JSON.stringify(kinds)}`);
    if (process.env.KEEP_LOG) fs.copyFileSync(path.join(srv.data, logs[0]), process.env.KEEP_LOG);

    for (const [name, p] of [["stage", stage], ["phone", phone]]) if (p.errors.length) { fails += p.errors.length; console.log(name, "page errors:", p.errors); }
    console.log(fails ? `${fails} FAILURES` : "ALL OK, no page errors");
  } catch (e) { fails++; console.error(e); }
  finally { browser.close(); srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(fails ? 1 : 0);
})();
