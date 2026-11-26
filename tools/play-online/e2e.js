// End-to-end check of the online pages (docs/play) through the real public relay:
// a stage, then a flute phone (scripted tilt + a fake mic that "blows") and a theremin phone (simulated sonar), all in
// headless Chrome. Needs the internet. Serves docs/play itself on a spare localhost port.
// Run: node tools/play-online/e2e.js [out-dir-for-screenshots]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, wait } = require("./cdp");
const { serve, FAKE_SENSORS, noiseWav } = require("./harness");

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
    check(await flute.js(`document.getElementById("scale").value`) === "pentatonic", "flute starts on the pentatonic scale");
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
    check(await stage.until(`window.__stage.players.size === 2`, 10000), "two players on the stage at once");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p && p.play === "penta" && !p.mapper.active.includes(65); })()`, 5000), "theremin starts on the pentatonic scale");
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p && p.cols > 50 && p.out.gate && p.voice.gain > 0; })()`, 20000), "theremin echo map and heights reach the stage, and it sounds");
    // the simulated book holds 10, 20 and 30 cm: on the 2-24 cm range that must be at least 3 different notes
    const notes = await stage.js(`(async () => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"), seen = new Set();
      const t0 = performance.now(); while (performance.now() - t0 < 12000) { if (p.out.gate) seen.add(p.out.name); await new Promise((r) => setTimeout(r, 50)); } return [...seen]; })()`);
    console.log("  theremin notes played over one 12 s simulated sweep: " + notes.join(" "));
    check(notes.length >= 3, "the theremin plays across its range on the stage (not stuck on 2 notes)");
    await stage.js(`document.querySelector('.pc [data-m="glide"]').click()`);
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p.mapper.o.mode === "glide" && p.out.gate && !Number.isInteger(p.out.midi); })()`, 12000), "Glide button on the stage card makes it glide");
    await stage.js(`document.querySelector('.pc [data-m="major"]').click()`);
    check(await stage.until(`(() => { const p = [...window.__stage.players.values()].find((p) => p.inst === "theremin"); return p.mapper.active.includes(65) && p.out.gate; })()`, 12000), "Full scale button on the theremin card adds F (C major)");
    await stage.js(`document.querySelector('.pc [data-m="penta"]').click()`);
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

    // ---- theremin with no stage: shows the sonar, says to open the stage, makes no sound ----
    const solo = await chrome.page(base + "theremin.html?sim", PHONE);
    await solo.click("#start");
    check(await solo.until(`window.__ht && window.__ht.last && !window.__ht.last.learning`, 15000), "theremin with no room still runs the sonar");
    check((await solo.text("#linkTxt")).startsWith("No stage"), "theremin with no room says to open the stage");
    check(await solo.js(`!document.querySelector("#local") && !window.__ht.synth`), "the theremin phone never plays music itself");
    check(+(await solo.js(`document.getElementById("vol").value`)) === 100, "sonar volume starts at 100%");

    const errs = [stage, flute, ther, solo].flatMap((p) => p.errors);
    check(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));
  } catch (e) { console.log("FAIL exception: " + e.stack); failed++; }
  finally { chrome.close(); srv.close(); }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  console.log("screenshots in " + out);
  process.exit(failed ? 1 : 0);
})();
