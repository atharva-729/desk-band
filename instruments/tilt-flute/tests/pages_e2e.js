// Browser check of the phone and stage pages: fake phone (fake mic + scripted gravity) -> server -> stage,
// then calibration, a fast prompted test run, and the session file it saves. Starts its own server on spare ports.
// Run: node tests/pages_e2e.js [out-dir-for-screenshots]
const path = require("path"), fs = require("fs"), os = require("os");
const { launch, startServer, wait } = require("./cdp");

// Runs inside the phone page: a phone held sideways like a flute. window.__turn (degrees) is how far the screen is
// turned; the test sets it. A small wobble is added so the numbers move.
const FAKE_SENSORS = `
  window.__turn = 0;
  window.__streams = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const st = await gum(c); window.__streams.push(st); return st; };
  setInterval(() => {
    const t = performance.now() / 1000, r = Math.PI / 180;
    const turn = (window.__turn + 0.6 * Math.sin(t * 3)) * r, lift = 3 * Math.sin(t * 1.3) * r;
    const g = [-9.81 * Math.cos(turn) * Math.cos(lift), 9.81 * Math.sin(lift), 9.81 * Math.sin(turn) * Math.cos(lift)];
    window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { alpha: 0, beta: Math.asin(g[1] / 9.81) / r, gamma: -80 }));
    window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: g[0], y: g[1], z: g[2] } }));
  }, 1000 / 60);`;

// Fake mic, looping: 1 s of a quiet room, then 1 s of "blowing" (loud low-passed noise, like breath on a mic).
// Written to a temp folder, never into the repo.
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
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-"));
  fs.mkdirSync(out, { recursive: true });
  const srv = await startServer();
  const wav = noiseWav(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tf-mic-")), "noise.wav"));
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--ignore-certificate-errors"]);
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
  try {
    const stage = await chrome.page(srv.stage, { width: 1280, height: 720 });
    const phone = await chrome.page(srv.phone + "?fast", { width: 390, height: 844, mobile: true, dpr: 2, init: FAKE_SENSORS });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone starts sensors");
    check(await stage.until(`document.getElementById("link").textContent === "phone connected"`), "stage sees the phone");

    // calibrate: lowest at 0°, highest at 48°
    await phone.click("#calBtn");
    await phone.until(`document.getElementById("ovPrompt").textContent.includes("HIGHEST")`);
    await phone.js("window.__turn = 48");
    check(await phone.until(`document.getElementById("doneCard").textContent.startsWith("Calibrated")`, 8000), "calibration finishes");
    const calTxt = await phone.text("#doneCard");
    const span = +calTxt.match(/(\d+)°/)[1];
    check(span >= 45 && span <= 51, `calibrated range is about 48° (${calTxt})`);
    await phone.js("window.__turn = 20"); // 20 of 48° -> note 4 of 8
    await wait(600);
    const p = await phone.js(`({ step: step.textContent, pos: posTxt.textContent, rates: rates.textContent })`);
    const s = await stage.js(`({ note: noteBig.textContent, rx: parseInt(rx.textContent), mic: mic.textContent })`);
    console.log("phone:", JSON.stringify(p)); console.log("stage:", JSON.stringify(s));
    check(p.step === "4 / 8" && s.note === "F", "turned 20° of 48° shows note 4 (F) on both pages");
    check(s.rx >= 25, `stage receives about 30 messages a second (got ${s.rx})`);
    check(/dB$/.test(s.mic), "stage shows the mic level");
    await phone.shot(path.join(out, "phone-live.png"));
    await stage.shot(path.join(out, "stage-live.png"));

    // the flute: sound on, the fake "blowing" second of the mic plays F5, the quiet second stops it
    await stage.click("#startSound");
    const sawPlay = await stage.until("window.__synth && window.__synth.playing && window.__synth.midi === 77", 5000);
    const sawStop = await stage.until("window.__synth && !window.__synth.playing", 5000);
    check(sawPlay && sawStop, "blowing plays F5 on the laptop and stopping silences it");
    const freq = await stage.js("document.getElementById('noteSub').textContent");
    check(/F5 · 698 Hz/.test(freq) || (await stage.until("/F5 · 698 Hz/.test(document.getElementById('noteSub').textContent)", 3000)), "F5 is 698 Hz");
    await phone.select("#scale", "pentatonic");
    check(await stage.until(`document.getElementById("noteBig").textContent === "G"`, 3000), "pentatonic mode: note 4 becomes G");
    await phone.select("#scale", "major");
    const key8 = await stage.js(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "8" })); return JSON.stringify(window.__synth); })()`);
    console.log("stage after key 8:", key8);
    await stage.js(`document.dispatchEvent(new KeyboardEvent("keyup", { key: "8" }))`);
    check(/"midi":84,"level":0.7,"playing":true/.test(key8), "key 8 plays C6 without the phone");
    await stage.shot(path.join(out, "stage-playing.png"));

    // speaker test runs end to end (headless Chrome has no speaker, so the beeps aren't really heard)
    await phone.click("#spkBtn");
    check(await phone.until(`/Loop|Didn't hear/.test(document.getElementById("doneCard").textContent)`, 30000), "speaker test finishes: " + (await phone.text("#doneCard")).slice(0, 60));

    // the mic dies (as it did on the iPhone): warning shows, a tap brings it back
    await phone.js("window.__streams.at(-1).getTracks().forEach((t) => t.stop())");
    check(await phone.until(`!document.getElementById("micWarn").classList.contains("hidden")`, 3000), "a stopped mic shows the warning");
    await phone.click("#micWarn");
    check(await phone.until(`document.getElementById("micWarn").classList.contains("hidden")`, 5000), "tapping the warning restarts the mic");
    check(await phone.until(`parseInt(document.getElementById("rates").textContent.split("·")[2]) > 50`, 3000), "mic frames flow again after the restart");

    // a fast test run (prompts shortened by ?fast)
    await phone.click("#runBtn");
    await wait(1500);
    await phone.shot(path.join(out, "phone-prompt.png"));
    check(await phone.until(`document.getElementById("doneCard").textContent.startsWith("Saved")`, 30000), "test run finishes and saves");
    console.log("phone:", await phone.text("#doneCard"));
    const dir = path.join(srv.data, "sessions");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    check(files.length === 1, "one session file saved on the laptop");
    if (files.length) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
      console.log(`session: ${d.prompts.length} prompts, ${d.mot.length} motion, ${d.ori.length} orientation, ${d.aud.length} mic frames, span ${d.cal.span}°`);
      check(d.complete && d.prompts.length === 16, "all 16 prompts recorded");
      check(d.mot.length > 300 && d.aud.length > 500 && d.aud[0].length === 5, "sensor samples and mic features recorded");
      fs.copyFileSync(path.join(dir, files[0]), path.join(out, "fake-session.json"));
    }
    // the sound-only test run: no calibration needed, 11 prompts, no "hold" prompts
    await phone.js(`document.getElementById("doneCard").textContent = ""`);
    await phone.click("#soundBtn");
    check(await phone.until(`document.getElementById("doneCard").textContent.startsWith("Saved")`, 30000), "sound test finishes and saves");
    const files2 = fs.readdirSync(dir).filter((f) => !files.includes(f));
    if (files2.length === 1) {
      const d2 = JSON.parse(fs.readFileSync(path.join(dir, files2[0]), "utf8"));
      check(d2.soundOnly && d2.prompts.length === 11 && !d2.prompts.some((q) => q.kind === "hold") && d2.aud.length > 300,
        `sound test: ${d2.prompts.length} prompts, ${d2.aud.length} mic frames, no tilt prompts`);
    } else check(false, "sound test saved one more file");

    check(phone.errors.length === 0 && stage.errors.length === 0, "no page errors " + JSON.stringify([...phone.errors, ...stage.errors]));
  } finally {
    chrome.close(); srv.stop();
  }
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
