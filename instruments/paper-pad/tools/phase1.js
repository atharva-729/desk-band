// Phase 1 signal test: can one phone mic tell tap, flick, scratch, rub and quiet apart?
// Reads the prompted recordings in data/sessions/ (raw audio stays there, never committed), cuts labelled examples
// using ONLY the prompt times, then trains on one session and tests on another (never a split of one session).
// Writes results/features/<session>.json (features + labels, no audio) and results/phase1-report.{json,md}.
// Run (from instruments/paper-pad):  node tools/phase1.js [--data data] [--out results]
const fs = require("fs"), path = require("path");
const C = require("../static/core.js"), F = require("../static/paper.js");

const CLASSES = F.CLASSES;
const SETS = { "mic": ["mic"], "mic + accel": ["mic", "accel"], "mic + texture": ["mic", "tex"], "mic + accel + texture": ["mic", "accel", "tex"] };
const WINDOWS = [150, 50]; // ms per example; 50 ms is what a fast hit path could afford
const SETUP_NAMES = { next: "Paper next to the phone", notebook: "Phone on an open notebook", a4: "Single loose A4 sheet" };

function loadSessions(dataDir) {
  const root = path.join(dataDir, "sessions");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap((id) => {
    const metaFile = path.join(root, id, "meta.json"), audioFile = path.join(root, id, "audio.pcm16");
    if (!fs.existsSync(metaFile) || !fs.existsSync(audioFile)) return [];
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")), buf = fs.readFileSync(audioFile);
    const audio = new Float32Array(buf.length >> 1);
    for (let i = 0; i < audio.length; i++) audio[i] = buf.readInt16LE(i * 2) / 32767;
    return [{ id, meta, audio }];
  });
}

// Example cutting lives in static/paper.js, shared with the phone (live training) and tools/simulate.js.
const onsets = F.onsets;
const examples = (s, winMs, opts) => F.examples(s.meta, s.audio, winMs, opts);

const vec = (e, groups) => groups.flatMap((g) => e.f[g]);
function train(exs, groups) {
  const count = {};
  for (const e of exs) count[e.label] = (count[e.label] || 0) + 1;
  return new C.Model().fit(exs.map((e) => vec(e, groups)), exs.map((e) => e.label), { iters: 500, weights: exs.map((e) => 1 / count[e.label]) });
}
function emptyCM() { return Object.fromEntries(CLASSES.map((a) => [a, Object.fromEntries(CLASSES.map((b) => [b, 0]))])); }
function score(model, exs, groups, cm = emptyCM(), bySrc = {}) {
  for (const e of exs) {
    const got = model.predict(vec(e, groups)).zone;
    cm[e.label][got]++;
    const s = (bySrc[e.src] = bySrc[e.src] || { ok: 0, n: 0 });
    s.n++; s.ok += got === e.label;
  }
  return { cm, bySrc };
}
function summary(cm) {
  const present = CLASSES.filter((c) => Object.values(cm[c]).reduce((a, b) => a + b, 0) > 0);
  const recall = Object.fromEntries(present.map((c) => { const n = Object.values(cm[c]).reduce((a, b) => a + b, 0); return [c, cm[c][c] / n]; }));
  const n = present.reduce((a, c) => a + Object.values(cm[c]).reduce((x, y) => x + y, 0), 0);
  const ok = present.reduce((a, c) => a + cm[c][c], 0);
  return { balanced: present.reduce((a, c) => a + recall[c], 0) / Math.max(1, present.length), accuracy: ok / Math.max(1, n), recall, n };
}
// Train on A, test on B, for every ordered pair; counts are summed over all pairs.
function crossPass(pairs, groups, trainFilter = (x) => x) {
  const cm = emptyCM(), bySrc = {};
  for (const [A, B] of pairs) score(train(trainFilter(A), groups), B, groups, cm, bySrc);
  return { ...summary(cm), cm, bySrc };
}
const pct = (x) => (x == null || isNaN(x) ? "–" : `${Math.round(100 * x)}%`);

function analyse({ data, out }) {
  const sessions = loadSessions(data);
  if (!sessions.length) throw new Error(`No recordings found in ${path.join(data, "sessions")}`);
  fs.mkdirSync(path.join(out, "features"), { recursive: true });
  const X = {}; // X[winMs][sessionId] = examples
  const info = [];
  for (const s of sessions) {
    const per = {};
    const hp = F.highpass(s.audio, s.meta.sr), ons = F.onsets(s.audio, s.meta.sr);
    for (const w of WINDOWS) { const r = examples(s, w, { hp, ons }); (X[w] = X[w] || {})[s.id] = r.ex; per[w] = r; }
    const d = per[WINDOWS[0]].detect, hits = (k) => d.filter((x) => x.kind === k);
    const perSec = (k) => { const r = hits(k); const sec = r.reduce((a, x) => a + x.seconds, 0); return sec ? r.reduce((a, x) => a + x.n, 0) / sec : null; };
    info.push({ id: s.id, setup: s.meta.setup, length: s.meta.length, seconds: s.meta.seconds, sr: s.meta.sr, aborted: !!s.meta.aborted,
      prompts: s.meta.prompts.length, motionReadings: (s.meta.motion || []).length,
      heard: Object.fromEntries(["tap", "flick"].map((k) => [k, { prompts: hits(k).length, heard: hits(k).filter((x) => x.n > 0).length, once: hits(k).filter((x) => x.n === 1).length }])),
      onsetsPerSecond: Object.fromEntries(["scratch", "rub", "quiet"].map((k) => [k, perSec(k)])),
      examples: Object.fromEntries(CLASSES.map((c) => [c, X[WINDOWS[0]][s.id].filter((e) => e.label === c).length])) });
    // features + labels only (no audio), rounded
    const r4 = (a) => a.map((v) => +v.toFixed(4));
    fs.writeFileSync(path.join(out, "features", `${s.id}.json`), JSON.stringify({
      id: s.id, setup: s.meta.setup, length: s.meta.length, sr: s.meta.sr,
      groups: { mic: "Desk Band band energies (18) + level", accel: "Desk Band motion jolt (7)", tex: "centroid, flatness, roll-off, hi/lo, ZCR, env CV, env crest, 500 ms level, 500 ms CV, 500 ms rhythm, level vs 500 ms" },
      windows: Object.fromEntries(WINDOWS.map((w) => [w, X[w][s.id].map((e) => ({ label: e.label, src: e.src, prompt: e.prompt, start: e.start, mic: r4(e.f.mic), accel: r4(e.f.accel), tex: r4(e.f.tex) }))])),
    }));
  }

  const bySetup = {};
  for (const s of sessions) (bySetup[s.meta.setup] = bySetup[s.meta.setup] || []).push(s.id);
  const pairsOf = (ids, w) => ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [X[w][a], X[w][b]]));
  const mainSetup = (bySetup.next || []).length >= 2 ? "next" : Object.keys(bySetup).find((k) => bySetup[k].length >= 2);
  const report = { when: new Date().toISOString(), sessions: info, mainSetup, main: [], setups: [], transfer: [], learning: [] };
  if (!mainSetup) { report.note = "Need at least two sessions with the same setup for a cross-session test."; return write(report, out); }

  // 1. main result: every feature set and window length, cross-session on the main setup
  for (const w of WINDOWS) for (const [name, groups] of Object.entries(SETS)) {
    const r = crossPass(pairsOf(bySetup[mainSetup], w), groups);
    report.main.push({ window: w, features: name, balanced: r.balanced, accuracy: r.accuracy, recall: r.recall, n: r.n, cm: r.cm,
      bySrc: Object.fromEntries(Object.entries(r.bySrc).map(([k, v]) => [k, v.ok / v.n])) });
  }
  const best = report.main.reduce((a, b) => (b.balanced > a.balanced ? b : a));
  report.best = { window: best.window, features: best.features, balanced: best.balanced };
  const bestGroups = SETS[best.features];

  // 2. learning curve: train on the first part of a session (in recorded order), test on the other session
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const pairs = pairsOf(bySetup[mainSetup], best.window);
    const keep = (A) => { const maxP = Math.max(...A.map((e) => e.prompt)) + 1; return A.filter((e) => e.prompt < Math.ceil(maxP * frac)); };
    const r = crossPass(pairs, bestGroups, keep);
    const A0 = keep(pairs[0][0]);
    report.learning.push({ fraction: frac, tapExamples: A0.filter((e) => e.label === "tap").length, flickExamples: A0.filter((e) => e.label === "flick").length,
      scratchWindows: A0.filter((e) => e.label === "scratch").length, balanced: r.balanced });
  }

  // 3. setups: cross-session within each setup, and train-on-one-setup / test-on-another
  for (const [setup, ids] of Object.entries(bySetup)) {
    if (ids.length < 2) { report.setups.push({ setup, sessions: ids.length }); continue; }
    const r = crossPass(pairsOf(ids, best.window), bestGroups);
    report.setups.push({ setup, sessions: ids.length, balanced: r.balanced, recall: r.recall });
  }
  for (const a of Object.keys(bySetup)) for (const b of Object.keys(bySetup)) {
    if (a === b) continue;
    const trainEx = bySetup[a].flatMap((id) => X[best.window][id]), m = train(trainEx, bestGroups);
    const cm = emptyCM();
    for (const id of bySetup[b]) score(m, X[best.window][id], bestGroups, cm);
    report.transfer.push({ train: a, test: b, balanced: summary(cm).balanced });
  }
  report.go = best.balanced >= 0.85;
  return write(report, out);
}

function write(report, out) {
  fs.writeFileSync(path.join(out, "phase1-report.json"), JSON.stringify(report, null, 1));
  const L = [];
  L.push("# Paper Pad · Phase 1 signal test", "", `Generated ${report.when.slice(0, 16).replace("T", " ")} by \`node tools/phase1.js\`. Every number is from **training on one recorded session and testing on a different one** (both directions, counts summed). No split of a single session is used.`, "");
  L.push("## Sessions", "", "| session | setup | length | seconds | taps heard (exactly once) | flicks heard (exactly once) | sharp sounds per second: scratch / rub / quiet |", "|---|---|---|---|---|---|---|");
  for (const s of report.sessions) {
    const h = (k) => `${s.heard[k].heard} of ${s.heard[k].prompts} (${s.heard[k].once})`;
    const o = s.onsetsPerSecond, f = (v) => (v == null ? "–" : v.toFixed(1));
    L.push(`| ${s.id}${s.aborted ? " (stopped early)" : ""} | ${s.setup} | ${s.length} | ${s.seconds} | ${h("tap")} | ${h("flick")} | ${f(o.scratch)} / ${f(o.rub)} / ${f(o.quiet)} |`);
  }
  if (report.note) { L.push("", `**${report.note}**`); fs.writeFileSync(path.join(out, "phase1-report.md"), L.join("\n") + "\n"); return report; }
  L.push("", `## Main result: ${SETUP_NAMES[report.mainSetup] || report.mainSetup}`, "",
    "Balanced accuracy = the average of the five per-class hit rates, so 10 taps count as much as hundreds of scratch windows. Chance is 20%.", "",
    "| window | features | balanced accuracy | tap | flick | scratch | rub | quiet | sharp sounds during scratch/rub named right |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of report.main)
    L.push(`| ${r.window} ms | ${r.features} | **${pct(r.balanced)}** | ${CLASSES.map((c) => pct(r.recall[c])).join(" | ")} | ${pct(r.bySrc.onset)} |`);
  const b = report.main.find((r) => r.window === report.best.window && r.features === report.best.features);
  L.push("", `### Confusion matrix: ${b.window} ms, ${b.features}`, "", "Rows: what the prompt asked for. Columns: what the model said.", "",
    `| asked \\ heard | ${CLASSES.join(" | ")} | right |`, `|---|${CLASSES.map(() => "---").join("|")}|---|`);
  for (const a of CLASSES) {
    const row = b.cm[a], n = Object.values(row).reduce((x, y) => x + y, 0);
    if (!n) continue;
    L.push(`| **${a}** | ${CLASSES.map((c) => (c === a ? `**${row[c]}**` : row[c] || "·")).join(" | ")} | ${pct(row[a] / n)} |`);
  }
  L.push("", "## How much training it needs", "", "Trained on the first part of one session (in the order it was recorded), tested on the whole other session.", "",
    "| part of session | tap examples | flick examples | scratch windows | balanced accuracy |", "|---|---|---|---|---|");
  for (const l of report.learning) L.push(`| ${pct(l.fraction)} | ${l.tapExamples} | ${l.flickExamples} | ${l.scratchWindows} | ${pct(l.balanced)} |`);
  L.push("", "## Setups", "", "| setup | sessions | balanced accuracy (session to session) |", "|---|---|---|");
  for (const s of report.setups) L.push(`| ${SETUP_NAMES[s.setup] || s.setup} | ${s.sessions} | ${s.balanced == null ? "needs 2 sessions" : pct(s.balanced)} |`);
  if (report.transfer.length) {
    L.push("", "Trained on one setup, tested on another (no retraining):", "", "| trained on | tested on | balanced accuracy |", "|---|---|---|");
    for (const t of report.transfer) L.push(`| ${t.train} | ${t.test} | ${pct(t.balanced)} |`);
  }
  L.push("", "## Go / no-go", "", `Best: **${pct(report.best.balanced)}** balanced accuracy (${report.best.window} ms windows, ${report.best.features}). Threshold 85%: **${report.go ? "GO" : "NO-GO"}**.`,
    "", "Caveat: the best of 8 combinations is picked on the test sessions, which flatters it slightly. The live Check accuracy round (Phase 3) is the real number.");
  fs.writeFileSync(path.join(out, "phase1-report.md"), L.join("\n") + "\n");
  return report;
}

module.exports = { analyse, examples, onsets, loadSessions, CLASSES };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const here = path.join(__dirname, "..");
  const report = analyse({ data: arg("--data", path.join(here, "data")), out: arg("--out", path.join(here, "results")) });
  console.log(fs.readFileSync(path.join(arg("--out", path.join(here, "results")), "phase1-report.md"), "utf8"));
  if (report.best) console.log(`best: ${pct(report.best.balanced)} (${report.best.window} ms, ${report.best.features}) -> ${report.go ? "GO" : "NO-GO"}`);
}
