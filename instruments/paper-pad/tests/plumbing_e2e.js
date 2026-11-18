// Phase 0 plumbing check: phone page + stage page in headless Chrome/Edge, with a FAKE MIC.
// The fake mic plays synthetic paper taps (short noise bursts). This checks plumbing only:
// the pages load, the sensors start, the stage sees the phone, and test hits and heard taps reach the stage.
// Starts its own server on spare ports (8101 / 8544) with a throwaway data folder.
// Run (from instruments/paper-pad):  node tests/plumbing_e2e.js [out-dir-for-screenshots]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, startServer, wait } = require("./cdp.js");
const OUT = process.argv[2] || os.tmpdir();

// A WAV of short, bright noise bursts (roughly what a fingertip tap on paper sounds like), 2 per second.
// Written to a temp folder, never the repo.
function fakeTaps(file) {
  const sr = 48000, secs = 20, n = sr * secs, pcm = Buffer.alloc(44 + n * 2);
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = (rnd() - 0.5) * 0.0006;
  for (let t = 0.4; t < secs - 0.2; t += 0.5) {
    const s0 = Math.round(t * sr), a = 0.1 + 0.2 * rnd();
    for (let i = 0; i < sr * 0.04; i++) sig[s0 + i] += a * Math.exp(-i / (sr * 0.006)) * (rnd() * 2 - 1);
  }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sig[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, pcm);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-e2e-")), wav = path.join(tmp, "taps.wav");
  fakeTaps(wav);
  const srv = await startServer();
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let fails = 0;
  const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fails++; };
  try {
    const SOUND = `window.__snd = 0; { const st = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...a) { window.__snd++; return st.apply(this, a); }; }`;
    const stage = await browser.page(srv.stage, { dpr: 1.5, init: SOUND });
    check(await stage.until(`document.querySelector("#qr svg") !== null`, 4000), "stage: QR code for the phone link is drawn");
    check(/^https:\/\/.+:8544$/.test(await stage.text("#joinUrl")), `stage: join link is ${await stage.text("#joinUrl")}`);
    check(await stage.until(`document.getElementById("connText").textContent.includes("waiting for phone")`, 4000), "stage: server connected, waiting for phone");
    await stage.click("#sound");
    check(await stage.until(`window.__snd >= 1`, 2000), "stage: sound starts after the click");

    const phone = await browser.page(srv.phone, { width: 390, height: 844, mobile: true });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone: sensors start (fake mic)");
    check(await stage.until(`document.getElementById("connText").textContent === "phone connected"`, 5000), "stage: shows phone connected");
    check(await stage.until(`document.getElementById("phSr").textContent.includes("kHz")`, 3000), `stage: phone mic is ${await stage.text("#phMic")}, ${await stage.text("#phSr")}`);

    const before = await stage.js(`window.__snd`);
    await phone.click("#test");
    check(await stage.until(`[...document.querySelectorAll("#rows td")].some((td) => td.textContent === "test hit")`, 3000), "test hit from the phone shows on the stage");
    check(await stage.until(`window.__snd > ${before}`, 2000), "stage: test hit plays a sound");

    // the fake mic plays a tap every 0.5 s; the phone mutes itself for 0.7 s after a screen touch
    check(await phone.until(`+document.getElementById("hits").textContent >= 4`, 8000), `phone: hears the fake taps (${await phone.text("#hits")} so far)`);
    check(await stage.until(`[...document.querySelectorAll("#rows tr")].filter((tr) => tr.children[1].textContent === "sound").length >= 3`, 4000), "heard taps reach the stage");
    const delays = await stage.js(`[...document.querySelectorAll("#rows tr")].filter((tr) => tr.children[1].textContent === "sound").map((tr) => parseInt(tr.children[3].textContent))`);
    check(delays.length && delays.every((d) => d >= 0 && d < 200), `phone listening delay per tap: ${delays.join(", ")} ms`);

    await wait(300);
    await phone.shot(path.join(OUT, "paper-pad-phone.png"));
    await stage.shot(path.join(OUT, "paper-pad-stage.png"));
    for (const [name, p] of [["phone", phone], ["stage", stage]]) check(!p.errors.length, `${name}: no JS errors${p.errors.length ? ": " + p.errors.join(" | ") : ""}`);
  } catch (e) {
    console.error(e); fails++;
  } finally {
    browser.close(); srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
