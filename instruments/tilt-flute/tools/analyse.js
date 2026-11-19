// Phase 1 analysis of prompted test runs saved by the phone (data/sessions/session-*.json).
// Prints tilt jitter, flicker, breath detection and rates, and writes report.html with the plots.
// With two or more runs, breath thresholds are also tuned on one run and tested on the other (never on the same run).
// Run: node tools/analyse.js data/sessions/session-A.json data/sessions/session-B.json [--out <dir>]
const fs = require("fs"), path = require("path");
const C = require("../static/flute-core.js");

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outDir = oi >= 0 ? args.splice(oi, 2)[1] : path.join(__dirname, "..", "data", "report");
const files = args;
if (!files.length) { console.error("usage: node tools/analyse.js <session.json> [...] [--out dir]"); process.exit(1); }

const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, p) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const rateHz = (ts) => (ts.length > 1 ? 1000 / med(ts.slice(1).map((t, i) => t - ts[i])) : NaN);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–"), f0 = (v) => (Number.isFinite(v) ? v.toFixed(0) : "–");
const inWin = (t, p) => t >= p.tRecStart && t <= p.tRecEnd;
const labelAt = (t, prompts) => { for (const p of prompts) if (inWin(t, p)) return p; return null; };
const BLOW = ["blow-soft", "blow-hard"], NOT = ["talk", "silence"];

// ---------- tilt ----------
function tiltSeries(d, smoothMs) {
  const cal = C.calibrate(d.cal.gLow, d.cal.gHigh), sm = new C.VecSmoother(smoothMs);
  return d.mot.map(([t, x, y, z]) => ({ t, ...C.tiltAngles(sm.push([x, y, z], t), cal) }));
}
function tiltStats(d) {
  const span = C.calibrate(d.cal.gLow, d.cal.gHigh).span, width = span / d.steps;
  const holds = d.prompts.filter((p) => p.kind === "hold");
  const res = { span, width, smooth: {}, flicker: {}, onTarget: null, betaSd: null };
  for (const ms of [0, 40, 100]) {
    const s = tiltSeries(d, ms);
    res.smooth[ms] = holds.map((p) => sd(s.filter((r) => inWin(r.t, p)).map((r) => r.pos))).filter(Number.isFinite);
  }
  const s40 = tiltSeries(d, d.smoothMs ?? 40);
  for (const h of [0, 1.5, 2.5, 4]) {
    const st = new C.Stepper(d.steps, span, h); let changes = 0, last = null, lastP = null;
    for (const r of s40) {
      const step = st.update(r.pos), p = labelAt(r.t, holds);
      if (p && p === lastP && step !== last) changes++;
      last = step; lastP = p;
    }
    res.flicker[h] = changes;
  }
  const st = new C.Stepper(d.steps, span, d.hyst ?? 2.5); let hit = 0, n = 0;
  for (const r of s40) { const step = st.update(r.pos), p = labelAt(r.t, holds); if (p) { n++; if (step === p.step) hit++; } }
  res.onTarget = n ? hit / n : NaN;
  // the phone's own angle (beta) in the same windows, for comparison
  res.betaSd = holds.map((p) => d.ori.filter((r) => inWin(r[0], p)).map((r) => r[2])).filter((a) => a.length > 5).map(sd);
  return { ...res, series: s40 };
}

// ---------- breath ----------
function replay(d, opts) {
  const det = new C.BreathDetector(opts);
  return d.aud.map(([t, rms, band, flat, period]) => ({ t, band, flat, period, ...det.push({ t, rms, band, flat, period }) }));
}
function breathRates(d, opts) {
  const out = {};
  for (const r of replay(d, opts)) {
    const p = labelAt(r.t, d.prompts); if (!p) continue;
    const k = p.kind === "hold" ? "hold" : p.label;
    (out[k] = out[k] || { n: 0, on: 0 }).n++; if (r.on) out[k].on++;
  }
  const rate = (keys) => { let n = 0, on = 0; for (const k of keys) if (out[k]) { n += out[k].n; on += out[k].on; } return n ? on / n : NaN; };
  return { per: out, blow: rate(BLOW), talk: rate(["talk"]), silence: rate(["silence"]), hold: rate(["hold"]) };
}
function featureTable(d) {
  const rows = replay(d, {}), by = {};
  for (const r of rows) {
    const p = labelAt(r.t, d.prompts); if (!p) continue;
    const k = p.kind === "hold" ? "hold" : p.label;
    (by[k] = by[k] || { above: [], flat: [], period: [] });
    by[k].above.push(r.band - r.floor); by[k].flat.push(r.flat); by[k].period.push(r.period);
  }
  return by;
}
// Delay inside the detector: from the first loud frame of a blow to breath "on" and to half its level.
// Separately: prompt shown -> breath on, which includes the player's reaction time.
function breathDelays(d) {
  const rows = replay(d, {}), algo = [], half = [], react = [];
  for (const p of d.prompts.filter((q) => BLOW.includes(q.label))) {
    const w = rows.filter((r) => r.t >= p.tShow && r.t <= p.tRecEnd);
    const loud = w.find((r) => r.loud); if (!loud) continue;
    const on = w.find((r) => r.on && r.t >= loud.t);
    if (on) { algo.push(on.t - loud.t); react.push(on.t - p.tShow); }
    const target = med(w.filter((r) => inWin(r.t, p)).map((r) => r.level));
    const h = w.find((r) => r.t >= loud.t && r.level >= 0.5 * target);
    if (h && target > 0) half.push(h.t - loud.t);
  }
  return { algo, half, react };
}
// Thresholds chosen on one run: most blow frames caught while talk stays under 5% and silence under 1%
function tune(d) {
  let best = null;
  for (const margin of [6, 9, 12, 15, 18, 21])
    for (const flatMin of [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3])
      for (const periodMax of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]) {
        const o = { margin, flatMin, periodMax }, r = breathRates(d, o);
        if (!(r.talk < 0.05) || !(r.silence < 0.01)) continue;
        if (!best || r.blow > best.r.blow || (r.blow === best.r.blow && r.talk < best.r.talk)) best = { o, r };
      }
  return best;
}

// ---------- plots (plain SVG) ----------
const COLORS = { "blow-soft": "#ffb38a", "blow-hard": "#ff6b3d", talk: "#c38bff", silence: "#8b90a3", hold: "#5aa8ff" };
function plot(d, series, { key, lo, hi, title, lines = [], extra = null, shadeKinds }) {
  const W = 1100, H = 220, L = 46, R = 10, T = 22, B = 24, t0 = d.t0, t1 = d.tEnd;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="plot"><text x="${L}" y="14" class="t">${title}</text>`;
  for (const p of d.prompts) {
    if (shadeKinds && !shadeKinds.includes(p.kind)) continue;
    const c = COLORS[p.kind === "hold" ? "hold" : p.label];
    s += `<rect x="${X(p.tRecStart)}" y="${T}" width="${X(p.tRecEnd) - X(p.tRecStart)}" height="${H - T - B}" fill="${c}" opacity=".18"/>`;
    s += `<text x="${(X(p.tRecStart) + X(p.tRecEnd)) / 2}" y="${H - 8}" class="l" text-anchor="middle">${p.kind === "hold" ? p.step + 1 : p.label.replace("blow-", "")}</text>`;
  }
  for (const v of lines) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="g"/>`;
  for (const v of [lo, hi]) s += `<text x="${L - 6}" y="${Y(v) + 4}" class="a" text-anchor="end">${v}</text>`;
  const path = (pts, cls) => `<path class="${cls}" d="${pts.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1)).join("")}"/>`;
  s += path(series.map((r) => ({ t: r.t, v: r[key] })), "s1");
  if (extra) s += path(extra.series, "s2");
  return s + "</svg>";
}

// ---------- run ----------
const sessions = files.map((f) => ({ name: path.basename(f), d: JSON.parse(fs.readFileSync(f, "utf8")) }));
let html = `<!doctype html><meta charset="utf-8"><title>Tilt Flute Phase 1</title><style>
body{font:14px/1.5 system-ui,sans-serif;background:#0e0f13;color:#eef0f6;margin:20px;max-width:1140px}
h2{margin-top:32px}.plot{width:100%;background:#15171e;border-radius:10px;margin:6px 0}
.t{fill:#eef0f6;font-size:13px}.l,.a{fill:#8b90a3;font-size:10px}.g{stroke:#2a2d38}.s1{fill:none;stroke:#5aa8ff;stroke-width:1.5}
.s2{fill:none;stroke:#3dd6a3;stroke-width:1}pre{background:#15171e;padding:12px;border-radius:10px;white-space:pre-wrap}</style>
<h1>Tilt Flute · Phase 1 signal test</h1>`;
let text = "";
const say = (s = "") => { console.log(s); text += s + "\n"; };

for (const { name, d } of sessions) {
  const hasTilt = !!d.cal && d.prompts.some((p) => p.kind === "hold");
  const ti = hasTilt ? tiltStats(d) : null, br = breathRates(d, {}), ft = featureTable(d), dl = breathDelays(d);
  say(`\n=== ${name} ${d.complete ? "" : "(stopped early)"} · ${d.prompts.length} prompts · mic: ${d.mic} @ ${d.sampleRate} Hz`);
  if (d.events && d.events.length) say(`events: ${d.events.map(([t, w]) => `${f1((t - d.t0) / 1000)} s ${w}`).join(" · ")}${d.redone ? ` (${d.redone} prompt(s) redone)` : ""}`);
  if (!d.aud.length) say("NO MIC DATA in this run: the mic was silent the whole time");
  say(`rates: orientation ${f0(rateHz(d.ori.map((r) => r[0])))} /s, motion ${f0(rateHz(d.mot.map((r) => r[0])))} /s, mic frames ${f0(rateHz(d.aud.map((r) => r[0])))} /s`);
  if (hasTilt) {
  say(`range ${f1(ti.span)}°, note width ${f1(ti.width)}° (go/no-go: jitter under ${f1(ti.width / 3)}°)`);
  for (const ms of [0, 40, 100])
    say(`  tilt jitter while holding, smoothing ${String(ms).padStart(3)} ms: median ${f1(med(ti.smooth[ms]))}°, worst ${f1(Math.max(...ti.smooth[ms]))}°`);
  say(`  phone's own angle (beta) in the same windows: median ${f1(med(ti.betaSd))}°, worst ${f1(Math.max(...ti.betaSd))}°`);
  say(`  note changes while holding (flicker), by hysteresis: ${Object.entries(ti.flicker).sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}° → ${n}`).join(", ")}`);
  say(`  time on the prompted note while holding: ${f0(100 * ti.onTarget)}%`);
  } else say("sound-only run (no tilt prompts)");
  say(`breath (default thresholds ${JSON.stringify(C.BREATH_DEFAULTS)}):`);
  say(`  detected in ${f0(100 * br.blow)}% of blow frames (soft ${f0(100 * br.per["blow-soft"]?.on / br.per["blow-soft"]?.n)}%, hard ${f0(100 * br.per["blow-hard"]?.on / br.per["blow-hard"]?.n)}%)`);
  say(`  false triggers: talking ${f1(100 * br.talk)}%, silence ${f1(100 * br.silence)}%, holding notes ${f1(100 * br.hold)}%`);
  say(`  features by prompt (median [10%–90%]):`);
  for (const [k, v] of Object.entries(ft))
    say(`    ${k.padEnd(10)} above floor ${f0(med(v.above))} dB [${f0(pct(v.above, .1))}–${f0(pct(v.above, .9))}] · flatness ${med(v.flat).toFixed(3)} [${pct(v.flat, .1).toFixed(3)}–${pct(v.flat, .9).toFixed(3)}] · periodicity ${med(v.period).toFixed(2)} [${pct(v.period, .1).toFixed(2)}–${pct(v.period, .9).toFixed(2)}]`);
  say(`  delay inside the detector: first loud frame → breath on ${f0(med(dl.algo))} ms (worst ${f0(Math.max(...dl.algo))}), → half level ${f0(med(dl.half))} ms`);
  say(`  prompt shown → breath on (includes your reaction): ${f0(med(dl.react))} ms`);

  html += `<h2>${name}</h2>`;
  if (hasTilt) html += plot(d, ti.series, { key: "pos", lo: Math.floor(Math.min(0, ...ti.series.map((r) => r.pos)) / 10) * 10, hi: Math.ceil(Math.max(ti.span, ...ti.series.map((r) => r.pos)) / 10) * 10,
    title: `Tilt along the note axis (°), with note boundaries; shaded = "hold note k" windows`,
    lines: Array.from({ length: d.steps + 1 }, (_, k) => +(k * ti.width).toFixed(2)), shadeKinds: ["hold"] });
  const rp = replay(d, {});
  html += plot(d, rp.map((r) => ({ t: r.t, v: r.level })), { key: "v", lo: 0, hi: 1,
    title: "Breath level (blue) and breath on/off (green), against prompts", shadeKinds: ["blow", "talk", "silence"],
    extra: { series: rp.map((r) => ({ t: r.t, v: r.on ? 0.97 : 0.02 })) } });
  html += plot(d, rp.map((r) => ({ t: r.t, v: r.band })), { key: "v", lo: -90, hi: 0,
    title: "Mic 50–1000 Hz (dB, blue) and noise floor (green)", shadeKinds: ["blow", "talk", "silence"],
    extra: { series: rp.map((r) => ({ t: r.t, v: r.floor })) } });
}

if (sessions.length >= 2) {
  say(`\n=== breath thresholds tuned on one run, tested on another`);
  for (let i = 0; i < sessions.length; i++) {
    const j = (i + 1) % sessions.length, best = tune(sessions[i].d);
    if (!best) { say(`  tuned on ${sessions[i].name}: no setting keeps talking under 5% and silence under 1%`); continue; }
    const r = breathRates(sessions[j].d, best.o);
    say(`  tuned on ${sessions[i].name} ${JSON.stringify(best.o)} (there: blow ${f0(100 * best.r.blow)}%, talk ${f1(100 * best.r.talk)}%)`);
    say(`    tested on ${sessions[j].name}: blow ${f0(100 * r.blow)}%, talk ${f1(100 * r.talk)}%, silence ${f1(100 * r.silence)}%, holding ${f1(100 * r.hold)}%`);
  }
}
html += `<h2>Numbers</h2><pre>${text.replace(/</g, "&lt;")}</pre>`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "report.html"), html);
console.log(`\nreport: ${path.join(outDir, "report.html")}`);
