// Offline test of the Phase 1 analysis (tools/phase1.js) on SYNTHETIC sessions (tests/synth.js), written in exactly the
// format the phone's recorder saves. The accuracy here only proves the pipeline works end to end; it says nothing about real paper.
// Run (from instruments/paper-pad):  node tests/test_phase1.js
const fs = require("fs"), os = require("os"), path = require("path");
const P = require("../tools/phase1.js");
const { session } = require("./synth.js");

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
