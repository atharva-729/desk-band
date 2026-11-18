// Read the phone's session log (data/training/log-<date>.jsonl) and say what went wrong.
// Run: node tools/analysis/read_log.js data/training/log-2026-11-18.jsonl [session-id]
// Per session: which mic was used, ignored double knocks, how loud each pad was, whether the training labels line up
// with the knocks (a label shift shows up as the model fitting better with labels moved by one), check rounds
// (the honest number) and what play mode heard.
const fs = require("fs"), path = require("path");
const C = require(path.join(__dirname, "..", "..", "static", "core.js"));
const [file, only] = process.argv.slice(2);
if (!file) { console.error("usage: node tools/analysis/read_log.js <log.jsonl> [session]"); process.exit(2); }
const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// one block per page session and pad count (switching pad count starts a separate model)
const key = (e) => `${e.session} · ${e.pads} pads`;
const sessions = [...new Set(events.map(key))].filter((s) => !only || s.startsWith(only));
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// k-fold accuracy of a fresh model on these (features, labels)
function cv(X, Y, k = 5) {
  if (new Set(Y).size < 2 || X.length < 2 * k) return NaN;
  const idx = X.map((_, i) => i).sort(() => rnd() - 0.5);
  let ok = 0;
  for (let f = 0; f < k; f++) {
    const te = idx.filter((_, i) => i % k === f), tr = idx.filter((_, i) => i % k !== f);
    const m = new C.Model().fit(tr.map((i) => X[i]), tr.map((i) => Y[i]), { iters: 300 });
    for (const i of te) ok += m.predict(X[i]).zone === Y[i];
  }
  return ok / X.length;
}
const pct = (x) => (isNaN(x) ? "–" : `${Math.round(100 * x)}%`);

for (const s of sessions) {
  const ev = events.filter((e) => key(e) === s);
  const train = ev.filter((e) => e.kind === "train" && !e.topup), checks = ev.filter((e) => e.kind === "check");
  const play = ev.filter((e) => e.kind === "play"), doubles = ev.filter((e) => e.kind === "double");
  const mic = ev.filter((e) => e.kind === "mic");
  console.log(`\n=== session ${s} · Response ${ev[0].resp} ms · ${ev.length} events`);
  for (const m of mic) console.log(`mic: ${m.label}${m.headset ? "   <-- HEADSET MIC: knocks heard through the air, not the table" : ""}`);
  if (doubles.length) console.log(`ignored double knocks: ${doubles.length} (gaps ${doubles.map((d) => d.gapMs + "ms").join(", ")})`);
  for (const r of ev.filter((e) => e.kind === "reset")) console.log(`reset: ${r.deleted} taps deleted at ${new Date(r.t).toLocaleTimeString()}`);

  if (train.length) {
    const labels = [...new Set(train.map((e) => e.label))].sort((a, b) => a - b);
    console.log(`teaching: ${train.length} prompted knocks`);
    console.log("  loudness (x threshold), median per pad: " + labels.map((l) => `${l}: ${median(train.filter((e) => e.label === l).map((e) => e.amp)).toFixed(1)}`).join("  "));
    // Alignment: if a double/missed knock shifted the labels, the model fits much better with labels moved by one.
    const X = train.map((e) => e.f), Y = train.map((e) => e.label);
    const asIs = cv(X, Y), later = cv(X.slice(1), Y.slice(0, -1)), earlier = cv(X.slice(0, -1), Y.slice(1));
    console.log(`  label alignment (5-fold fit on the teaching knocks): as recorded ${pct(asIs)} · labels one knock later ${pct(later)} · one earlier ${pct(earlier)}`);
    if (Math.max(later, earlier) > asIs + 0.15) console.log("  <-- LABELS LOOK SHIFTED: a knock was double-counted or missed during teaching");
    else if (asIs < 0.6) console.log("  <-- the pads don't sound different enough here (or knocks vary a lot): spread them out or use different objects");
  }
  if (checks.length) {
    const ok = checks.filter((c) => c.label === c.got).length;
    console.log(`check round(s): ${ok} of ${checks.length} right (prompted, separate from teaching: the honest number)`);
    const labels = [...new Set(checks.map((c) => c.label))].sort((a, b) => a - b);
    for (const l of labels) {
      const row = checks.filter((c) => c.label === l);
      console.log(`  pad ${l}: heard as ${row.map((c) => c.got).join(" ")}`);
    }
  }
  if (play.length) {
    const byPad = {};
    for (const p of play) byPad[p.got] = (byPad[p.got] || 0) + 1;
    console.log(`play: ${play.length} knocks, predicted ${Object.entries(byPad).map(([k, v]) => `${k}×${v}`).join(" ")}, median confidence ${pct(median(play.map((p) => p.prob)))}`);
    const fixes = ev.filter((e) => e.kind === "correct");
    if (fixes.length) console.log(`  corrections: ${fixes.map((c) => `${c.was}→${c.label}`).join(", ")}`);
  }
}
