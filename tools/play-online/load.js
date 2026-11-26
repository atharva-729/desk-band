// Load test through the real public relay: one stage, N phones playing at once (flutes and theremins in turn),
// all real pages in headless Chrome on this computer. Measures, per phone, what reaches the stage: messages a second,
// messages lost, lag; and whether the stage keeps up (sound from every player, frame rate, timer delay).
// Needs the internet. Run: node tools/play-online/load.js [players=5] [seconds=60] [out-dir]
const fs = require("fs"), os = require("os"), path = require("path");
const { launch, wait } = require("./cdp");
const { serve, FAKE_SENSORS, noiseWav } = require("./harness");

const N = +process.argv[2] || 5, SECS = +process.argv[3] || 60;
const out = process.argv[4] || fs.mkdtempSync(path.join(os.tmpdir(), "play-load-"));
const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const port = 8250 + Math.floor(Math.random() * 50);
  const srv = await serve(port), base = `http://127.0.0.1:${port}/`;
  const wav = noiseWav(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "play-mic-")), "noise.wav"));
  const chrome = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  const PHONE = { width: 390, height: 844, mobile: true, dpr: 1 };
  const plan = Array.from({ length: N }, (_, k) => (k % 5 === 1 || k % 5 === 3 ? "theremin" : "flute"));  // 5 -> 3 flutes, 2 theremins
  let ok = true;
  try {
    const stage = await chrome.page(base, { width: 1440, height: 900 });
    if (!(await stage.until(`document.getElementById("relayPill").textContent.startsWith("relay connected")`, 20000))) throw new Error("stage did not reach the relay");
    await stage.click("#startBig");
    const join = await stage.js("window.__stage.joinUrl"), broker = await stage.js("window.__stage.broker");
    console.log(`stage on ${broker}, ${N} phones: ${plan.filter((p) => p === "flute").length} flutes, ${plan.filter((p) => p === "theremin").length} theremins, ${SECS} s`);

    // ---- phones join one by one ----
    const phones = [];
    for (let k = 0; k < N; k++) {
      const inst = plan[k], name = `${inst === "flute" ? "Flute" : "Theremin"} ${k + 1}`;
      const url = join.replace("join.html", inst + ".html") + "&n=" + encodeURIComponent(name) + (inst === "flute" ? "&fast" : "&sim");
      const p = await chrome.page(url, inst === "flute" ? { ...PHONE, init: FAKE_SENSORS } : PHONE);
      await p.click("#start");
      if (inst === "flute") {
        await p.until(`!document.getElementById("main").classList.contains("hidden")`);
        await p.click("#calFirst");
        await p.until(`document.getElementById("ovPrompt").textContent.includes("HIGHEST")`);
        await p.js("window.__turn = 48");
        await p.until(`document.getElementById("overlay").classList.contains("hidden")`, 8000);
        // each flute wanders up and down the 8 notes at its own speed
        await p.js(`setInterval(() => { window.__turn = 24 + 22 * Math.sin(performance.now() / ${1400 + 500 * k}); }, 50)`);
      }
      phones.push({ p, inst, name });
    }
    const allIn = await stage.until(`window.__stage.players.size === ${N}`, 20000);
    console.log(allIn ? `all ${N} phones are on the stage` : `only ${await stage.js("window.__stage.players.size")} of ${N} phones reached the stage`);
    ok = ok && allIn;

    // ---- measure ----
    await stage.send("Page.bringToFront");
    await stage.js(`(() => { const s = window.__load = { frames: 0, lagMax: 0, lags: [] };
      const f = () => { s.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
      let t = performance.now(); setInterval(() => { const n = performance.now(), d = n - t - 50; t = n; s.lags.push(d); if (d > s.lagMax) s.lagMax = d; }, 50); })()`);
    const snap = () => stage.js(`[...window.__stage.players.values()].map((p) => { const s = window.__stage.seqs.get(p.id) || {};
      return { id: p.id, name: p.last && p.last.n, inst: p.inst, rx: s.rx || 0, lost: s.lost || 0, rtt: p.last ? p.last.rtt : null,
        sounding: p.inst === "flute" ? !!(p.voice && p.voice.level > 0.05) : !!(p.voice && p.voice.gain > 0), stale: p.el.classList.contains("stale") }; })`);
    const start = await snap(), per = new Map(start.map((s) => [s.id, { ...s, rtts: [], soundSec: 0, staleSec: 0, rxSec: [] }]));
    let prev = start;
    const t0 = Date.now();
    for (let sec = 1; sec <= SECS; sec++) {
      await wait(t0 + sec * 1000 - Date.now());
      const now = await snap();
      for (const s of now) {
        const r = per.get(s.id); if (!r) continue;
        const was = prev.find((x) => x.id === s.id);
        if (was) r.rxSec.push(s.rx - was.rx);
        if (s.rtt != null) r.rtts.push(s.rtt / 2);
        if (s.sounding) r.soundSec++;
        if (s.stale) r.staleSec++;
        r.end = s;
      }
      prev = now;
      if (sec % 15 === 0) console.log(`  ${sec} s…`);
    }
    const st = await stage.js(`({ fps: window.__load.frames / ${SECS}, lagMax: window.__load.lagMax, lag99: (() => { const a = window.__load.lags.slice().sort((x, y) => x - y); return a[Math.floor(0.99 * a.length)]; })() })`);
    await stage.shot(path.join(out, `stage-${N}.png`));

    // ---- report ----
    console.log(`\nper phone, over ${SECS} s at the stage:`);
    console.log("phone        | msgs/s avg (worst second) | lost          | lag one way median / worst | sounding | went quiet");
    let totalRx = 0, totalLost = 0;
    for (const r of per.values()) {
      const rx = r.end.rx - r.rx, lost = r.end.lost - r.lost, avg = rx / SECS;
      totalRx += rx; totalLost += lost;
      const lostPct = rx + lost ? (100 * lost) / (rx + lost) : 0;
      console.log(`${(r.end.name || r.inst).padEnd(12)} | ${avg.toFixed(1).padStart(5)} (${String(q(r.rxSec, 0)).padStart(2)})              | ${String(lost).padStart(4)} (${lostPct.toFixed(2)}%)  | ${String(Math.round(q(r.rtts, 0.5))).padStart(4)} / ${String(Math.round(q(r.rtts, 1))).padStart(4)} ms               | ${String(r.soundSec).padStart(3)} s    | ${r.staleSec} s`);
      if (lostPct > 1 || r.staleSec > 2 || avg < (r.inst === "flute" ? 25 : 20)) ok = false;
    }
    console.log(`\nall phones together: ${(totalRx / SECS).toFixed(0)} messages a second into the stage, ${totalLost} lost of ${totalRx + totalLost}`);
    console.log(`stage page: ${st.fps.toFixed(0)} frames a second, timers late by ${Math.round(st.lag99)} ms at worst 1 in 100 (${Math.round(st.lagMax)} ms worst)`);
    if (st.fps < 30 || st.lag99 > 50) ok = false;
    const errs = [stage, ...phones.map((x) => x.p)].flatMap((p) => p.errors);
    if (errs.length) { ok = false; console.log("page errors: " + errs.slice(0, 3).join(" | ")); }
  } catch (e) { console.log("FAILED: " + e.stack); ok = false; }
  finally { chrome.close(); srv.close(); }
  console.log(ok ? `\nPASS: ${N} phones played together without trouble` : `\nNOT OK: see above`);
  console.log("screenshot in " + out);
  process.exit(ok ? 0 : 1);
})();
