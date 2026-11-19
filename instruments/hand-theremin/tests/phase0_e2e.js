// Phase 0 plumbing check, in headless Chrome. Starts its own server on spare ports.
// Run: node tests/phase0_e2e.js [out-dir-for-screenshots]
//  1. Real mic path (Chrome's fake mic): sonar starts, profiles flow at ~47/s, the stage receives the map, Stop works.
//  2. ?sim: the phone page's pretend mic with a pretend hand at 10, 20, 30 cm and a sweep. The hand estimate on
//     the phone and the stage must follow it. (This tests the pipeline, not a real hand.)
const path = require("path"), fs = require("fs"), os = require("os");
const { launch, startServer, wait } = require("./cdp");

(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "ht-p0-"));
  fs.mkdirSync(out, { recursive: true });
  const srv = await startServer();
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--ignore-certificate-errors"]);
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
  try {
    const stage = await chrome.page(srv.stage, { width: 1366, height: 900 });

    // 1. real mic path
    let phone = await chrome.page(srv.phone, { width: 390, height: 844, mobile: true, dpr: 2 });
    await phone.click("#start");
    check(await phone.until(`!document.getElementById("main").classList.contains("hidden")`), "phone starts the sonar (fake mic)");
    check(await stage.until(`document.getElementById("link").textContent.startsWith("phone connected")`), "stage sees the phone");
    await wait(2500);
    const p1 = await phone.js(`({ rate: rate.textContent, fps: parseInt(fps.textContent), sent: parseInt(sendHz.textContent), fails: +fails.textContent, heard: heard.textContent, learning: __ht.last.learning })`);
    console.log("phone (fake mic):", JSON.stringify(p1));
    check(p1.rate === "48.0 kHz", "AudioContext runs at 48 kHz");
    check(p1.fps >= 40, `about 47 echo profiles a second (got ${p1.fps})`);
    check(p1.sent >= 25 && p1.fails === 0, `sends about 30 a second with no failures (got ${p1.sent})`);
    check(!p1.learning, "background learnt after about 1 s");
    check(/^NO/.test(p1.heard), "fake mic plays a beep, not our chirp: phone says chirp NOT heard");
    check(await stage.until(`document.getElementById("status").textContent.startsWith("The phone can't hear its chirp")`, 2000), "stage tells you the chirp isn't heard");
    const s1 = await stage.js(`({ cols: __stage.cols, rx: parseInt(rx.textContent) })`);
    check(s1.cols > 60, `stage receives echo-map columns (${s1.cols})`);
    await phone.click("#stop");
    check(await stage.until(`document.getElementById("link").textContent === "sonar stopped"`, 3000), "Stop sonar: the stage shows it stopped");
    check(await phone.js(`!document.getElementById("intro").classList.contains("hidden") && document.getElementById("stop").classList.contains("hidden")`), "Stop sonar: the phone is back on the start card");
    check(phone.errors.length === 0, "no phone page errors " + JSON.stringify(phone.errors));
    phone.ws.close();

    // 2. simulated hand
    phone = await chrome.page(srv.phone + "?sim", { width: 390, height: 844, mobile: true, dpr: 2 });
    await phone.click("#start");
    await phone.until(`window.__ht && __ht.learntAt != null`);
    const samples = [];
    const t0 = Date.now();
    let shotAt = 11500, shot = false;
    while (Date.now() - t0 < 13000) {
      const l = await phone.js(`({ h: __ht.last.handCm, s: __ht.last.simCm, learning: __ht.last.learning })`);
      samples.push(l);
      if (!shot && Date.now() - t0 > shotAt) { await stage.shot(path.join(out, "phase0-stage-sim.png")); await phone.shot(path.join(out, "phase0-phone-sim.png")); shot = true; }
      await wait(60);
    }
    const withHand = samples.filter((x) => !x.learning && x.s != null), noHand = samples.filter((x) => !x.learning && x.s == null);
    const good = withHand.filter((x) => x.h != null && Math.abs(x.h - x.s) < 1).length;
    const quiet = noHand.filter((x) => x.h == null).length;
    console.log(`sim: hand present ${good}/${withHand.length} within 1 cm, hand away ${quiet}/${noHand.length} silent`);
    check(withHand.length > 50 && good / withHand.length >= 0.9, "phone follows the simulated hand (≥ 90% of samples within 1 cm)");
    check(noHand.length > 5 && quiet / noHand.length >= 0.8, "phone says no hand when the simulated hand is away (≥ 80%; it lags a frame or two)");
    const st = await stage.js(`({ hand: hand.textContent, link: link.textContent, cols: __stage.cols })`);
    console.log("stage:", JSON.stringify(st));
    check(/cm$|no hand/.test(st.hand) && st.link === "phone connected (simulated mic)", "stage shows the hand distance from the simulated phone");
    const behind = await phone.js(`Math.round(__ht.behind / 48)`), remeasures0 = await phone.js(`__ht.sonar.relearns`);
    check(remeasures0 === 0, `no re-measuring unless asked (${remeasures0})`);
    console.log(`INFO mic audio behind the clock: ${behind} ms`);

    // Re-measure button: 2 s countdown, then 1 s of measuring
    await phone.click("#relearn");
    check(await phone.until(`/Take your hand away/.test(document.getElementById("status").textContent)`, 1000), "Re-measure starts with a countdown");
    check(await phone.until(`__ht.last.learning`, 4000), "then measures the table");
    check(await phone.until(`!__ht.last.learning`, 3000) && (await phone.js(`__ht.sonar.relearns`)) === 1, "and goes back to tracking");
    check(phone.errors.length === 0 && stage.errors.length === 0, "no page errors " + JSON.stringify([...phone.errors, ...stage.errors]));

    // Session saved on the laptop, and the replay tool reads it back
    const sid = await phone.js(`__ht.sid`);
    await phone.click("#stop");
    await wait(1500);
    const base = path.join(srv.data, sid);
    const ok = fs.existsSync(base + ".jsonl") && fs.existsSync(base + ".pcm");
    check(ok, `session saved: ${sid}.jsonl and .pcm in the data folder`);
    if (ok) {
      const secs = fs.statSync(base + ".pcm").size / 2 / 48000;
      const lines = fs.readFileSync(base + ".jsonl", "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      check(secs > 15, `audio saved: ${secs.toFixed(1)} s`);
      check(lines[0].type === "meta" && lines.some((l) => l.ev === "remeasure") && lines.filter((l) => l.f).length > 15 * 40,
        `log saved: meta, ${lines.filter((l) => l.f).length} frames, the re-measure tap`);
      const { execFileSync } = require("child_process");
      const rep = execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "replay.js"), base], { encoding: "utf-8" });
      const agree = +(/replay vs live phone: (\d+)%/.exec(rep) || [])[1];
      check(agree >= 95, `replay of the saved session matches the live phone (${agree}% of frames)`);
      check(fs.existsSync(base + "-replay.png"), "replay draws the session picture");
      fs.copyFileSync(base + "-replay.png", path.join(out, "replay-sim.png"));
    }
  } finally {
    chrome.close(); srv.stop();
  }
  console.log("screenshots in", out);
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
