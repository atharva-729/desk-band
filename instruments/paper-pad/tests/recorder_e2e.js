// Recorder check: a fake-mic phone page records two short prompted sessions (4x faster via ?fast=1) and the laptop
// saves them. Checks the audio arrives complete and in order, the prompt times make sense, the stage shows the prompts,
// and the Phase 1 analysis runs on what was saved. The fake mic doesn't follow the prompts, so no accuracy is checked.
// Starts its own server on spare ports (8101 / 8544) with a throwaway data folder.
// Run (from instruments/paper-pad):  node tests/recorder_e2e.js [out-dir-for-screenshots]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, startServer, wait } = require("./cdp.js");
const P = require("../tools/phase1.js");
const OUT = process.argv[2] || os.tmpdir();

function fakeAudio(file) { // quiet room noise with a short bright click every 0.7 s
  const sr = 48000, secs = 30, n = sr * secs, pcm = Buffer.alloc(44 + n * 2);
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = (rnd() - 0.5) * 0.0008;
  for (let t = 0.3; t < secs - 0.1; t += 0.7) { const s0 = Math.round(t * sr); for (let i = 0; i < sr * 0.03; i++) sig[s0 + i] += 0.2 * Math.exp(-i / (sr * 0.004)) * (rnd() * 2 - 1); }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sig[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, pcm);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-rec-")), wav = path.join(tmp, "room.wav");
  fakeAudio(wav);
  const srv = await startServer();
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let fails = 0;
  const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fails++; };
  try {
    const stage = await browser.page(srv.stage);
    const phone = await browser.page(srv.phone + "?fast=1", { width: 390, height: 844, mobile: true });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone: sensors start (fake mic)");
    check(await phone.until(`document.getElementById("recList").textContent.includes("Nothing recorded yet")`, 3000), "phone: 'recorded so far' list shows nothing yet");
    check(await phone.until(`/Nothing to learn from yet/.test(document.getElementById("trainInfo").textContent)`, 5000), "phone: Play says there is nothing to learn from yet");
    check(await phone.js(`document.getElementById("recBox").open`), "phone: the recorder is open when there are no recordings");

    for (const k of [1, 2]) {
      await phone.select("#setup", "a4"); await phone.select("#length", "short");
      await phone.click("#recGo");
      if (k === 1) {
        check(await stage.until(`/get ready|now/.test(document.getElementById("lastSmall").textContent)`, 4000), "stage: shows the prompt while recording");
        await phone.shot(path.join(OUT, "paper-pad-recording-phone.png")); await stage.shot(path.join(OUT, "paper-pad-recording-stage.png"));
      }
      check(await phone.until(`/^Saved: 16 prompts/.test(document.getElementById("recResult").textContent)`, 60000), `recording ${k}: ${await phone.text("#recResult")}`);
      await wait(300);
    }
    check(await phone.until(`document.getElementById("recList").textContent.includes("✓ Single loose A4 sheet: 2 (0 full, 2 short)")`, 3000), "phone: list shows both A4 recordings");
    check(await phone.until(`/Learned from 2 recordings/.test(document.getElementById("trainInfo").textContent)`, 60000), `phone: learns from the new recordings: "${await phone.text("#trainInfo")}"`);
    check(await stage.until(`(document.getElementById("recLines").textContent.match(/✓ a4-short-/g) || []).length === 2`, 3000), "stage: lists both saved recordings");

    const root = path.join(srv.data, "sessions"), ids = fs.readdirSync(root);
    check(ids.length === 2 && ids.every((id) => /^a4-short-\d{8}-\d{6}$/.test(id)), `server: 2 session folders (${ids.join(", ")})`);
    for (const id of ids) {
      const meta = JSON.parse(fs.readFileSync(path.join(root, id, "meta.json"), "utf8"));
      const bytes = fs.statSync(path.join(root, id, "audio.pcm16")).size;
      check(bytes === meta.samples * 2 && meta.samples > meta.sr * 10, `${id}: audio complete (${(meta.samples / meta.sr).toFixed(1)} s, ${bytes} bytes)`);
      const p = meta.prompts, kinds = {};
      p.forEach((x) => (kinds[x.kind] = (kinds[x.kind] || 0) + 1));
      check(kinds.tap === 5 && kinds.flick === 5 && kinds.scratch === 2 && kinds.rub === 2 && kinds.quiet === 2, `${id}: prompts 5 tap, 5 flick, 2 scratch, 2 rub, 2 quiet`);
      const okTimes = p.every((x, i) => x.ready <= x.now && x.now < x.end && x.end <= meta.samples && (i === 0 || p[i - 1].end <= x.ready));
      const nowMs = p.map((x) => ((x.end - x.now) / meta.sr) * 1000);
      check(okTimes, `${id}: prompt times in order on the audio clock (now-windows ${Math.round(Math.min(...nowMs))}–${Math.round(Math.max(...nowMs))} ms)`);
    }
    check(ids[0] !== ids[1] && JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, ids[0], "meta.json"))).prompts.map((x) => x.kind)) !==
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, ids[1], "meta.json"))).prompts.map((x) => x.kind)), "the two sessions used different random orders");

    const r = P.analyse({ data: srv.data, out: path.join(tmp, "results") });
    check(r.mainSetup === "a4" && r.main.length === 8, "analysis runs on the saved sessions (a4 used as the main setup)");
    for (const [name, pg] of [["phone", phone], ["stage", stage]]) check(!pg.errors.length, `${name}: no JS errors${pg.errors.length ? ": " + pg.errors.join(" | ") : ""}`);
  } catch (e) {
    console.error(e); fails++;
  } finally {
    browser.close(); srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
