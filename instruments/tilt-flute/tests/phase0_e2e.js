// Phase 0 plumbing check: fake phone (fake mic + scripted tilt/roll) -> server -> stage page.
// Starts its own server on spare ports. Run: node tests/phase0_e2e.js [out-dir-for-screenshots]
const path = require("path"), fs = require("fs");
const { launch, startServer, wait } = require("./cdp");

// Runs inside the phone page: pretend to be a phone being tilted slowly and rolled a little.
const FAKE_SENSORS = `
  setInterval(() => {
    const t = performance.now() / 1000;
    const beta = 60 + 25 * Math.sin(t * 0.8), gamma = 8 * Math.sin(t * 2.3);
    window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { alpha: 0, beta, gamma }));
    const r = Math.PI / 180;
    window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity:
      { x: 9.81 * Math.sin(gamma * r), y: 9.81 * Math.sin(beta * r), z: 9.81 * Math.cos(beta * r) } }));
  }, 1000 / 60);`;

// 2 s of quiet noise (about -30 dBFS) as the fake mic, written to a temp folder (never into the repo)
function noiseWav(file) {
  const sr = 48000, n = sr * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * 0.05 * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(require("os").tmpdir(), "tf-p0-"));
  fs.mkdirSync(out, { recursive: true });
  const srv = await startServer();
  const wav = noiseWav(path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "tf-mic-")), "noise.wav"));
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
  try {
    const stage = await chrome.page(srv.stage, { width: 1280, height: 720 });
    const phone = await chrome.page(srv.phone, { width: 390, height: 844, mobile: true, dpr: 2, init: FAKE_SENSORS });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone starts sensors");
    check(await stage.until(`document.getElementById("link").textContent === "phone connected"`), "stage sees the phone");
    await wait(3000);
    const p = await phone.js(`({ aud: audHz.textContent, beta: beta.textContent, gamma: gamma.textContent, mic: mic.textContent, sent: parseInt(sendHz.textContent), fails: +fails.textContent })`);
    const s = await stage.js(`({ beta: beta.textContent, gamma: gamma.textContent, mic: mic.textContent, rx: parseInt(rx.textContent), gap: parseInt(gap.textContent), lost: +lost.textContent })`);
    console.log("phone:", JSON.stringify(p));
    console.log("stage:", JSON.stringify(s));
    check(/°$/.test(p.beta) && /°$/.test(p.gamma), "phone shows tilt and roll");
    check(p.mic !== "–" && +p.mic > -120, "phone shows a mic level (fake mic plays noise)");
    check(/°$/.test(s.beta) && /°$/.test(s.gamma) && s.mic !== "–", "stage shows tilt, roll and mic");
    check(s.rx >= 28, `stage receives about 30 messages a second (got ${s.rx})`);
    check(p.fails === 0, "no failed sends");
    check(phone.errors.length === 0 && stage.errors.length === 0, "no page errors " + JSON.stringify([...phone.errors, ...stage.errors]));
    await phone.shot(path.join(out, "phase0-phone.png"));
    await stage.shot(path.join(out, "phase0-stage.png"));
  } finally {
    chrome.close(); srv.stop();
  }
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
