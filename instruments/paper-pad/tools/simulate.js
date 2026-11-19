// Phase 2 offline check of the LIVE pipeline: train on one recording, then replay a different recording through the
// exact engine the phone runs (static/engine.js), sample by sample, with motion readings arriving when they arrived.
// Scores what the laptop would have played against the prompts that were showing (labels come only from prompts).
// Tries a few settings (hit window, how many frames a texture needs to switch on) and reports each.
// Writes results/phase2-sim.{json,md}. Raw audio is read from data/sessions/ and never written anywhere.
// Run (from instruments/paper-pad):  node tools/simulate.js [--data data] [--out results] [--quick]
const fs = require("fs"), path = require("path");
const E = require("../static/engine.js"), F = require("../static/paper.js");
const { loadSessions } = require("./phase1.js");

const VARIANTS = [ // options not given use the engine's defaults (static/engine.js DEFAULTS)
  { name: "default: hit 75 ms; texture on after 1 frame if 80% sure (else 2); loudness gate; trained on the quiet around taps", hitMs: 75 },
  { name: "texture on after 1 frame if 70% sure", hitMs: 75, enterConf: 0.7 },
  { name: "texture on after 1 frame if 60% sure", hitMs: 75, enterConf: 0.6 },
  { name: "no loudness gate", hitMs: 75, gate: null },
  { name: "louder gate (+0.6)", hitMs: 75, gate: 0.6 },
  { name: "not trained around taps", hitMs: 75, around: false },
  { name: "trained around taps, touch windows too", hitMs: 75, around: "all" },
  { name: "texture waits for the hit decision, then 250 ms hold", hitMs: 75, around: false, holdMs: 250 },
  { name: "neither gate nor around-tap training (the first Phase 2 build)", hitMs: 75, gate: null, around: false },
  { name: "hit 50 ms (faster)", hitMs: 50 },
  { name: "hit 100 ms (slower)", hitMs: 100 },
  { name: "texture off after 1 frame", hitMs: 75, exit: 1 },
  { name: "texture off after 3 frames", hitMs: 75, exit: 3 },
  { name: "no echo filter", hitMs: 75, echoMs: 0 },
  { name: "plus motion features (phone motion on)", hitMs: 75, groups: ["mic", "accel", "tex"] },
  { name: "plus motion features, but no motion readings live", hitMs: 75, groups: ["mic", "accel", "tex"], dropMotion: true },
];

// Replay one recording through a trained engine. Returns every hit, skipped onset and texture state change.
function replay(s, models, opts) {
  const { meta, audio } = s, sr = meta.sr, eng = new E.Engine(sr, models, opts);
  const motion = opts.dropMotion ? [] : meta.motion || [], hits = [], frames = [];
  let mi = 0;
  eng.onHit = (ev) => hits.push({ kind: ev.kind, peak: ev.peak, lagMs: ev.lagMs, vel: ev.vel });
  eng.onFrame = (ev) => frames.push({ end: ev.end, state: ev.state, label: ev.label });
  for (let i = 0; i < audio.length; i += 256) {
    while (mi < motion.length && motion[mi][0] <= i) { const [smp, x, y, z] = motion[mi++]; eng.addMotion(smp, x, y, z); }
    eng.process(audio.subarray(i, i + 256), 0);
  }
  return { hits, frames };
}

// When the touch's sound actually started: first 10 ms block after "now" louder than 6x the quiet "get ready" level.
function soundStart(hp, sr, p) {
  const blk = Math.round(sr * 0.01), rms = (a) => { let e = 0; for (let i = a; i < a + blk; i++) e += hp[i] * hp[i]; return Math.sqrt(e / blk); };
  const pre = [];
  for (let i = p.ready + Math.round(sr * 0.3); i + blk < p.now; i += blk) pre.push(rms(i));
  pre.sort((a, b) => a - b);
  const floor = pre.length ? pre[Math.floor(pre.length / 2)] : 1e-4;
  for (let i = p.now; i + blk < p.end; i += blk) if (rms(i) > 6 * floor + 1e-5) return i;
  return null;
}

function score(s, run) {
  const { meta } = s, sr = meta.sr, hp = F.highpass(s.audio, sr), after = Math.round(sr * ((meta.timing || {}).after || 300) / 1000);
  const react = Math.round((F.REACT_MS * sr) / 1000);
  const out = { hit: {}, tex: {}, quiet: { prompts: 0, seconds: 0, falseHits: 0, falseTexSeconds: 0 }, lags: [], texDelays: [],
    still: { seconds: 0, texSeconds: 0 } }; // still: tap, flick and quiet prompts, from "now" to the end: nobody scratches or rubs
  for (const k of ["tap", "flick"]) out.hit[k] = { prompts: 0, right: 0, wrong: 0, missed: 0, extra: 0 };
  for (const k of ["scratch", "rub"]) out.tex[k] = { prompts: 0, framesRight: 0, framesOther: 0, framesOff: 0, frames: 0, falseHits: 0, delays: [] };
  const hop = Math.round(sr * 0.05);
  for (const p of meta.prompts) {
    if (p.kind !== "scratch" && p.kind !== "rub") {
      const fr = run.frames.filter((x) => x.end > p.now && x.end <= p.end + after);
      out.still.seconds += (fr.length * hop) / sr; out.still.texSeconds += (fr.filter((x) => x.state).length * hop) / sr;
    }
    if (F.HIT(p.kind)) {
      const h = run.hits.filter((x) => x.peak >= p.now && x.peak <= p.end + after), r = out.hit[p.kind];
      r.prompts++;
      if (!h.length) r.missed++;
      else if (h[0].kind === p.kind) r.right++;
      else r.wrong++;
      r.extra += Math.max(0, h.length - 1);
      h.forEach((x) => out.lags.push(x.lagMs));
    } else if (p.kind === "quiet") {
      const q = out.quiet, fr = run.frames.filter((x) => x.end > p.now + react && x.end <= p.end);
      q.prompts++; q.seconds += (p.end - p.now - react) / sr;
      q.falseHits += run.hits.filter((x) => x.peak >= p.now + react && x.peak <= p.end).length;
      q.falseTexSeconds += (fr.filter((x) => x.state).length * hop) / sr;
    } else {
      const r = out.tex[p.kind], fr = run.frames.filter((x) => x.end > p.now + react && x.end <= p.end);
      r.prompts++; r.frames += fr.length;
      r.framesRight += fr.filter((x) => x.state === p.kind).length;
      r.framesOther += fr.filter((x) => x.state && x.state !== p.kind).length;
      r.framesOff += fr.filter((x) => !x.state).length;
      r.falseHits += run.hits.filter((x) => x.peak >= p.now + react && x.peak <= p.end).length;
      const st = soundStart(hp, sr, p), on = run.frames.find((x) => x.end > p.now && x.state === p.kind);
      if (st != null && on) { const d = ((on.end - st) / sr) * 1000; r.delays.push(d); out.texDelays.push(d); }
    }
  }
  return out;
}

function merge(a, b) {
  if (!a) return JSON.parse(JSON.stringify(b));
  for (const k of ["tap", "flick"]) for (const f of Object.keys(b.hit[k])) a.hit[k][f] += b.hit[k][f];
  for (const k of ["scratch", "rub"]) for (const f of Object.keys(b.tex[k])) a.tex[k][f] = f === "delays" ? a.tex[k][f].concat(b.tex[k][f]) : a.tex[k][f] + b.tex[k][f];
  for (const f of Object.keys(b.quiet)) a.quiet[f] += b.quiet[f];
  for (const f of Object.keys(b.still)) a.still[f] += b.still[f];
  a.lags = a.lags.concat(b.lags); a.texDelays = a.texDelays.concat(b.texDelays);
  return a;
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (x) => (x == null || isNaN(x) ? "–" : `${Math.round(100 * x)}%`);

function summarise(t) {
  const hitRight = (k) => t.hit[k].right / Math.max(1, t.hit[k].prompts);
  const texRight = (k) => t.tex[k].framesRight / Math.max(1, t.tex[k].frames);
  const quietRight = 1 - t.quiet.falseTexSeconds / Math.max(1e-9, t.quiet.seconds);
  return { tap: hitRight("tap"), flick: hitRight("flick"), scratch: texRight("scratch"), rub: texRight("rub"), quiet: quietRight,
    balanced: (hitRight("tap") + hitRight("flick") + texRight("scratch") + texRight("rub") + quietRight) / 5,
    extraHits: t.hit.tap.extra + t.hit.flick.extra, falseHitsTex: t.tex.scratch.falseHits + t.tex.rub.falseHits, falseHitsQuiet: t.quiet.falseHits,
    hitLagMs: med(t.lags), texDelayMs: med(t.texDelays), stillTex: t.still.texSeconds / Math.max(1e-9, t.still.seconds) };
}

function simulate({ data, out, quick = false }) {
  const sessions = loadSessions(data);
  if (sessions.length < 2) throw new Error("Need at least two recordings to train on one and test on another.");
  const cache = {}; // examples per session per hit window
  const exs = (s, hitMs, around = E.DEFAULTS.around) => { const k = `${s.id}/${hitMs}/${around}`; return (cache[k] = cache[k] || E.sessionExamples(s.meta, s.audio, { hitMs, around })); };
  const report = { when: new Date().toISOString(), sessions: sessions.map((s) => s.id), variants: [] };
  for (const v of quick ? VARIANTS.slice(0, 1) : VARIANTS) {
    let tot = null;
    const pairs = [];
    for (const A of sessions) for (const B of sessions) {
      if (A === B) continue;
      const models = E.trainModels(exs(A, v.hitMs, v.around), { hitMs: v.hitMs, ...(v.groups ? { groups: v.groups } : {}) });
      const sc = score(B, replay(B, models, v));
      pairs.push({ train: A.id, test: B.id, ...summarise(sc) });
      tot = merge(tot, sc);
    }
    report.variants.push({ ...v, ...summarise(tot), totals: tot, pairs });
    console.log(`${v.name}: ${pct(report.variants.at(-1).balanced)}`);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "phase2-sim.json"), JSON.stringify(report, null, 1));
  const L = ["# Paper Pad · Phase 2 live-pipeline replay", "",
    `Generated ${report.when.slice(0, 16).replace("T", " ")} by \`node tools/simulate.js\`. Trained on one recording, then a **different** recording is replayed through the phone's live engine (\`static/engine.js\`) and what it would have played is scored against the prompts.`, "",
    "- **tap / flick**: the prompt got exactly the right sound first (extra sounds counted separately).",
    "- **scratch / rub**: share of 50 ms frames, from 300 ms after \"now\", where that sound was playing.",
    "- **quiet**: share of the time nothing was playing.",
    "- **hit delay**: from the touch's peak to the decision on the phone (network and laptop audio come on top).",
    "- **texture delay**: from the first loud 10 ms of the scratch or rub to the sound switching on, on the phone.", "",
    "- **false texture**: share of the time during tap, flick and keep-still prompts (including just after each tap) that a scratch or rub sound was playing.", "",
    "| setting | balanced | tap | flick | scratch | rub | quiet | false texture | extra hit sounds | false hits in scratch/rub | false hits in quiet | hit delay | texture delay |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of report.variants)
    L.push(`| ${r.name} | **${pct(r.balanced)}** | ${pct(r.tap)} | ${pct(r.flick)} | ${pct(r.scratch)} | ${pct(r.rub)} | ${pct(r.quiet)} | ${pct(r.stillTex)} | ${r.extraHits} | ${r.falseHitsTex} | ${r.falseHitsQuiet} | ${r.hitLagMs == null ? "–" : Math.round(r.hitLagMs) + " ms"} | ${r.texDelayMs == null ? "–" : Math.round(r.texDelayMs) + " ms"} |`);
  const d = report.variants[0].totals;
  L.push("", `Default setting in detail: taps ${d.hit.tap.right} right / ${d.hit.tap.wrong} wrong sound / ${d.hit.tap.missed} missed of ${d.hit.tap.prompts}; flicks ${d.hit.flick.right} / ${d.hit.flick.wrong} / ${d.hit.flick.missed} of ${d.hit.flick.prompts}. Scratch frames playing rub instead: ${d.tex.scratch.framesOther}; rub frames playing scratch: ${d.tex.rub.framesOther}.`);
  fs.writeFileSync(path.join(out, "phase2-sim.md"), L.join("\n") + "\n");
  return report;
}

module.exports = { simulate, replay, score };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const here = path.join(__dirname, ".."), out = arg("--out", path.join(here, "results"));
  simulate({ data: arg("--data", path.join(here, "data")), out, quick: process.argv.includes("--quick") });
  console.log("\n" + fs.readFileSync(path.join(out, "phase2-sim.md"), "utf8"));
}
