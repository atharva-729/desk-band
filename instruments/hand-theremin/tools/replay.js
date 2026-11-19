// Replay a saved phone session through the sonar maths (static/sonar.js) and draw the whole run.
// Run: node tools/replay.js data/sessions/<id> [--learn-from <s>] [--png-max-width <px>]
//   <id> with or without .jsonl/.pcm. The phone saves both when "Save this session" is ticked.
//   --learn-from s  re-learn the background at s seconds as well (to test "what if the table had been measured then").
// Writes, next to the session (data/ is gitignored):
//   <id>-replay.png   top: changes vs the empty table (what the laptop map shows), with the hand estimate in green;
//                     bottom: everything heard. Orange strip = measuring the table, magenta line = Re-measure tapped,
//                     red tick = audio gap, white ticks every 5 s.
//   <id>-replay.json  per-second timeline (also printed).
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { Sonar, LUT } = require("../static/sonar.js");

const args = process.argv.slice(2);
if (!args[0]) { console.error("usage: node tools/replay.js data/sessions/<id> [--learn-from <s>]"); process.exit(2); }
const base = args[0].replace(/\.(jsonl|pcm)$/, "");
const opt = (name, dflt) => { const i = args.indexOf(name); return i > 0 ? +args[i + 1] : dflt; };
const learnFrom = opt("--learn-from", null), maxW = opt("--png-max-width", 2400);

const rows = fs.readFileSync(base + ".jsonl", "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const meta = rows.find((r) => r.type === "meta");
if (!meta) throw new Error("no meta line in " + base + ".jsonl");
const live = rows.filter((r) => r.f != null);
const events = rows.filter((r) => r.ev).sort((a, b) => a.at - b.at);
const buf = fs.readFileSync(base + ".pcm");
const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
const fs_ = meta.fs, s = new Sonar(fs_, meta.opts);
console.log(`session ${meta.sid}: ${(pcm.length / fs_).toFixed(1)} s of audio at ${fs_} Hz, ${live.length} live frames, mic "${meta.mic}"`);
console.log(`  ${meta.ua}`);

// Background re-learns happen where Re-measure was tapped (and at --learn-from); gaps mark frames to ignore.
const marks = events.filter((e) => e.ev === "remeasure" || e.ev === "gap").map((e) => ({ at: e.at, ev: e.ev }));
if (learnFrom != null) marks.push({ at: Math.round(learnFrom * fs_), ev: "remeasure" });
marks.sort((a, b) => a.at - b.at);

const out = []; // per frame: result + columns
let mi = 0, sampleAt = 0;
const onFrame = (r) => out.push({ ...r, at: sampleAt, change: s.colChange.slice(), raw: s.colRaw.slice() });
const B = 512, x = new Float32Array(B);
for (let i = 0; i < pcm.length;) {
  while (mi < marks.length && marks[mi].at <= i) {
    if (marks[mi].ev === "remeasure") s.relearn(); else s.dirty = 2;
    out.markAt = (out.markAt || []).concat({ frame: out.length, ev: marks[mi].ev });
    mi++;
  }
  const end = Math.min(pcm.length, i + B, mi < marks.length ? Math.max(marks[mi].at, i + 1) : Infinity);
  const n = end - i;
  for (let k = 0; k < n; k++) x[k] = pcm[i + k] / 32768;
  sampleAt = i;
  s.push(n === B ? x : x.subarray(0, n), onFrame);
  i = end;
}
const markAt = out.markAt || [];

// ---- per-second timeline ----
const perSec = Math.round(fs_ / s.P), tl = [];
const med = (a) => { const b = a.filter((v) => v != null).sort((p, q) => p - q); return b.length ? b[b.length >> 1] : null; };
for (let k = 0; k * perSec < out.length; k++) {
  const fr = out.slice(k * perSec, (k + 1) * perSec);
  const ok = fr.filter((r) => !r.learning && !r.glitch);
  const pres = ok.filter((r) => r.present);
  const loud = ok.filter((r) => r.best !== r.direct && Math.min(Math.abs(r.best - r.direct), s.P - Math.abs(r.best - r.direct)) > 2);
  const evs = markAt.filter((m) => m.frame >= k * perSec && m.frame < (k + 1) * perSec).map((m) => m.ev);
  tl.push({
    t: k, learning: fr.length - ok.length, snr: med(fr.map((r) => r.snrDb)), present: ok.length ? pres.length / ok.length : 0,
    handCm: med(pres.map((r) => r.handCm)), handSpread: pres.length > 2 ? Math.max(...pres.map((r) => r.handCm)) - Math.min(...pres.map((r) => r.handCm)) : null,
    ratio: med(ok.map((r) => r.ratio)), peakCm: med(ok.map((r) => r.peakCm)), louderThanSpeaker: loud.length,
    micDb: med(fr.map((r) => 20 * Math.log10(r.micPeak + 1e-9))), events: evs,
  });
}
const f1 = (v, d = 1) => (v == null ? "  –  " : v.toFixed(d).padStart(5));
console.log("\n   t  snr  mic  hand?  hand cm  spread  ratio  peak cm  louder-than-speaker  events");
for (const r of tl) {
  console.log(`${String(r.t).padStart(4)} ${f1(r.snr, 0)} ${f1(r.micDb, 0)} ${(Math.round(r.present * 100) + "%").padStart(5)}  ${f1(r.handCm)}   ${f1(r.handSpread)}  ${f1(r.ratio)}  ${f1(r.peakCm)}  ${String(r.louderThanSpeaker).padStart(6)}${r.learning ? "  (measuring table)" : ""} ${r.events.join(" ")}`);
}

// Does the replay agree with what the phone showed live? (It should, unless the upload lost audio.)
const liveH = new Map(live.map((r) => [r.f, r.h]));
let same = 0, comp = 0;
out.forEach((r, i) => {
  const h = liveH.get(i + 1);
  if (h === undefined || r.learning) return;
  comp++;
  if ((h == null && r.handCm == null) || (h != null && r.handCm != null && Math.abs(h - r.handCm) < 0.3)) same++;
});
const gaps = events.filter((e) => e.ev === "gap").length, remeasures = events.filter((e) => e.ev === "remeasure").length;
console.log(`\nreplay vs live phone: ${comp ? Math.round(same / comp * 100) : 0}% of ${comp} frames agree · ${remeasures} re-measure tap(s) · ${gaps} audio gap(s)`);

// ---- picture ----
const rowsN = s.rows, scaleY = 2, strip = 6, W0 = out.length, group = Math.max(1, Math.ceil(W0 / maxW)), W = Math.ceil(W0 / group);
const H = strip + rowsN * scaleY + 4 + rowsN * scaleY;
const img = Buffer.alloc(W * H * 3);
const put = (xx, yy, r, g, b) => { if (xx < 0 || yy < 0 || xx >= W || yy >= H) return; const p = (yy * W + xx) * 3; img[p] = r; img[p + 1] = g; img[p + 2] = b; };
const y0Change = strip, y0Raw = strip + rowsN * scaleY + 4;
for (let c = 0; c < W; c++) {
  const fr = out.slice(c * group, (c + 1) * group);
  for (let r = 0; r < rowsN; r++) {
    let vc = 0, vr = 0;
    for (const f of fr) { if (f.change[r] > vc) vc = f.change[r]; if (f.raw[r] > vr) vr = f.raw[r]; }
    for (let k = 0; k < scaleY; k++) {
      const yc = y0Change + (rowsN - 1 - r) * scaleY + k, yr = y0Raw + (rowsN - 1 - r) * scaleY + k;
      put(c, yc, LUT[vc * 3], LUT[vc * 3 + 1], LUT[vc * 3 + 2]);
      put(c, yr, LUT[vr * 3], LUT[vr * 3 + 1], LUT[vr * 3 + 2]);
    }
  }
  if (fr.some((f) => f.learning || f.glitch)) for (let k = 0; k < strip - 2; k++) put(c, k, 255, 150, 40);
  for (const f of fr) if (f.handCm != null) {
    const yy = y0Change + Math.round((rowsN - 1 - f.handCm / s.cmPerRow) * scaleY);
    put(c, yy, 61, 214, 163); put(c, yy + 1, 61, 214, 163);
  }
}
for (let cm = 10; cm < rowsN * s.cmPerRow; cm += 10) {         // faint gridlines every 10 cm
  const rr = Math.round(cm / s.cmPerRow);
  for (const y0 of [y0Change, y0Raw]) {
    const yy = y0 + (rowsN - 1 - rr) * scaleY;
    for (let c = 0; c < W; c += 3) put(c, yy, 110, 110, 120);
  }
}
for (let k = 0; k * perSec * 5 < W0; k++) for (let d = 0; d < 4; d++) put(Math.round(k * perSec * 5 / group), d, 255, 255, 255);
for (const m of markAt) {
  const c = Math.round(m.frame / group);
  if (m.ev === "remeasure") for (let yy = 0; yy < H; yy++) put(c, yy, 230, 60, 230);
  else for (let d = 0; d < strip; d++) put(c, d, 255, 60, 60);
}
const pngFile = base + "-replay.png";
fs.writeFileSync(pngFile, png(W, H, img));
fs.writeFileSync(base + "-replay.json", JSON.stringify({ meta, timeline: tl, agree: comp ? same / comp : null, remeasures, gaps }, null, 1));
console.log(`picture: ${pngFile}  (${W}x${H}, ${group > 1 ? group + " frames per pixel" : "1 frame per pixel"}, ${(s.cmPerRow * 10 / scaleY).toFixed(1)} mm per pixel row)`);

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
