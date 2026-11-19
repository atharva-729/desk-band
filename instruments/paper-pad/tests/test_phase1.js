// Offline test of the Phase 1 analysis (tools/phase1.js) on SYNTHETIC sessions, written in exactly the format the
// phone's recorder saves (audio.pcm16 + meta.json with prompt times in samples). The sounds are crude stand-ins:
// tap = low thump, flick = short bright click, scratch = hiss with micro-clicks, rub = soft noise swelling 4x a second.
// So the accuracy here only proves the pipeline works end to end; it says nothing about real paper.
// Run (from instruments/paper-pad):  node tests/test_phase1.js
const fs = require("fs"), os = require("os"), path = require("path");
const P = require("../tools/phase1.js");

const sr = 48000;
const PLAN = { full: { tap: 10, flick: 10, scratch: 4, rub: 4, quiet: 4 }, short: { tap: 5, flick: 5, scratch: 2, rub: 2, quiet: 2 } };
const T = { readyHit: 1200, nowHit: 1800, readyTex: 1500, nowTex: 3000, after: 300 };

function session(dir, id, setup, length, seed) {
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const order = [];
  for (const [k, n] of Object.entries(PLAN[length])) for (let i = 0; i < n; i++) order.push(k);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const ms = (x) => Math.round((x * sr) / 1000);
  let t = ms(1000);
  const prompts = order.map((kind) => {
    const hit = kind === "tap" || kind === "flick";
    const p = { kind, ready: t, now: t + ms(hit ? T.readyHit : T.readyTex) };
    p.end = p.now + ms(hit ? T.nowHit : T.nowTex);
    t = p.end + ms(T.after);
    return p;
  });
  const n = t + ms(500), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (rnd() - 0.5) * 0.001;
  for (const p of prompts) {
    const react = ms(250 + 300 * rnd());
    if (p.kind === "tap") {
      const s0 = p.now + react, a = 0.15 + 0.25 * rnd(), f = 220 + 80 * rnd();
      for (let i = 0; i < ms(60); i++) x[s0 + i] += a * Math.exp(-i / ms(8)) * (Math.sin((2 * Math.PI * f * i) / sr) + 0.3 * (rnd() - 0.5));
    } else if (p.kind === "flick") {
      const s0 = p.now + react, a = 0.1 + 0.2 * rnd();
      let prev = 0;
      for (let i = 0; i < ms(25); i++) { const w = rnd() - 0.5; x[s0 + i] += a * Math.exp(-i / ms(2)) * (w - prev) * 2; prev = w; }
    } else if (p.kind === "scratch") {
      let prev = 0;
      for (let i = p.now + react; i < p.end; i++) {
        const w = rnd() - 0.5; x[i] += 0.03 * (w - prev); prev = w;
        if (rnd() < 25 / sr) for (let k = 0; k < ms(3); k++) x[i + k] += 0.05 * (rnd() - 0.5);
      }
    } else if (p.kind === "rub") {
      let lp = 0;
      for (let i = p.now + react; i < p.end; i++) {
        lp = 0.9 * lp + 0.1 * (rnd() - 0.5);
        x[i] += 0.12 * lp * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * (i - p.now)) / sr));
      }
    }
  }
  const folder = path.join(dir, "sessions", id), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "audio.pcm16"), pcm);
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ id, setup, length, sr, seconds: n / sr, samples: n, timing: T, prompts, motion: [] }));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-phase1-")), data = path.join(tmp, "data"), out = path.join(tmp, "results");
let fails = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fails++; };
try {
  session(data, "next-full-1", "next", "full", 3);
  session(data, "next-full-2", "next", "full", 5);
  session(data, "a4-short-1", "a4", "short", 7);
  session(data, "a4-short-2", "a4", "short", 9);
  session(data, "notebook-short-1", "notebook", "short", 11);
  const t0 = Date.now();
  const r = P.analyse({ data, out });
  console.log(`     analysis took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(r.sessions.length === 5, "all 5 sessions loaded");
  for (const s of r.sessions) check(s.heard.tap.heard === s.heard.tap.prompts && s.heard.flick.heard === s.heard.flick.prompts, `${s.id}: every synthetic tap and flick detected`);
  check(r.mainSetup === "next" && r.main.length === 8, "main result: 4 feature sets x 2 window lengths on 'next'");
  check(r.best && r.best.balanced >= 0.85, `synthetic best balanced accuracy ${Math.round(100 * r.best.balanced)}% (${r.best.window} ms, ${r.best.features})`);
  check(r.learning.length === 4, "learning curve has 4 points");
  const ns = (k) => r.setups.find((s) => s.setup === k);
  check(ns("a4").balanced != null && ns("notebook").balanced == null, "setups: a4 scored (2 sessions), notebook waits for a 2nd session");
  check(r.transfer.length === 6, "setup transfer: 6 train/test pairs");
  const feat = JSON.parse(fs.readFileSync(path.join(out, "features", "next-full-1.json"), "utf8"));
  const e = feat.windows["150"][0];
  check(e.mic.length === 19 && e.accel.length === 7 && e.tex.length === 11 && !("audio" in feat), "features file: 19 mic + 7 accel + 11 texture values per example, no audio");
  check(fs.readFileSync(path.join(out, "phase1-report.md"), "utf8").includes("## Go / no-go"), "markdown report written");
} catch (e) {
  console.error(e); fails++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
