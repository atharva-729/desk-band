// Offline sanity test for static/core.js — synthetic knocks, no phone needed.
// Run: node tests/test_core.js
const C = require("../static/core.js");
const sr = 48000, freqs = { 1: 600, 2: 1500, 3: 3200, 4: 5500 }; // each "spot" rings differently
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function session(order, perZone) {
  const labels = [], sig = new Float32Array(sr * (order.length * perZone * 0.4 + 1));
  for (let i = 0; i < sig.length; i++) sig[i] = (rnd() - 0.5) * 0.0004; // room noise
  let t = 0.5;
  for (const z of order) for (let k = 0; k < perZone; k++) {
    const s0 = Math.round(t * sr), f = freqs[z] * (0.95 + 0.1 * rnd()), amp = 0.05 + 0.2 * rnd();
    for (let i = 0; i < sr * 0.08; i++) sig[s0 + i] += amp * Math.exp(-i / (sr * 0.012)) * Math.sin((2 * Math.PI * f * i) / sr);
    labels.push({ t: s0 / sr, zone: z }); t += 0.4;
  }
  return { sig, labels };
}
function extract({ sig, labels }) {
  const det = new C.Detector(sr), rows = [];
  for (let i = 0; i < sig.length; i += 1024) {
    const ch = sig.subarray(i, i + 1024);
    det.process(ch, ((i + ch.length) / sr) * 1000, (h) => {
      const t = h.peakIdx / sr, lab = labels.find((l) => Math.abs(l.t - t) < 0.05);
      if (lab) rows.push({ zone: lab.zone, f: C.audioFeatures(h.seg, sr).concat(C.accelFeatures([], h.wallMs)) });
    });
  }
  return rows;
}
const train = extract(session([3, 1, 4, 2], 12)), test = extract(session([2, 4, 1, 3], 12));
const m = new C.Model().fit(train.map((r) => r.f), train.map((r) => r.zone));
const acc = test.filter((r) => m.predict(r.f).zone === r.zone).length / test.length;
console.log(`detected ${train.length}/48 train, ${test.length}/48 test taps; accuracy ${(acc * 100).toFixed(0)}%`);
if (train.length < 46 || test.length < 46 || acc < 0.9) { console.error("FAIL"); process.exit(1); }
console.log("PASS");

// Rapid-fire: 20 knocks 120 ms apart (≈8 notes/sec) must all be caught, with no doubles.
{
  const n = 20, gap = 0.12, sig = new Float32Array(sr * (n * gap + 1));
  for (let i = 0; i < sig.length; i++) sig[i] = (rnd() - 0.5) * 0.0004;
  for (let k = 0; k < n; k++) {
    const s0 = Math.round((0.5 + k * gap) * sr), f = freqs[1 + (k % 4)];
    for (let i = 0; i < sr * 0.08; i++) sig[s0 + i] += 0.15 * Math.exp(-i / (sr * 0.012)) * Math.sin((2 * Math.PI * f * i) / sr);
  }
  const det = new C.Detector(sr); let got = 0;
  for (let i = 0; i < sig.length; i += 256) det.process(sig.subarray(i, i + 256), 0, () => got++);
  console.log(`rapid-fire: caught ${got}/${n} knocks at ${Math.round(1 / gap)} per second`);
  if (got !== n) { console.error("FAIL rapid-fire"); process.exit(1); }
  console.log("PASS rapid-fire");
}
