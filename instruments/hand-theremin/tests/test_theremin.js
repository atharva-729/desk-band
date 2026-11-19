// Offline check of height -> note (static/theremin.js). Run: node tests/test_theremin.js
const { Mapper, midiName, EASY } = require("../static/theremin.js");

let failed = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
const FRAME = 1000 / 47;

// feed a height for n frames, return the last result
function hold(m, cm, n, t0) {
  let r, t = t0;
  for (let i = 0; i < n; i++, t += FRAME) r = m.update(typeof cm === "function" ? cm(i) : cm, t);
  return { r, t };
}

{ // easy mode: 8 zones from low to high, low = lowest note
  const m = new Mapper({ low: 5, high: 35 });
  let t = 0;
  const notes = [];
  for (let k = 0; k < 8; k++) { const cm = 5 + (k + 0.5) * 30 / 8; const h = hold(m, cm, 30, t); t = h.t; notes.push(h.r.note); }
  check(notes.join() === "0,1,2,3,4,5,6,7", `each zone plays its own note, low to high (${notes.join()})`);
  check(midiName(EASY[0]) === "C4" && midiName(EASY[7]) === "E5", "easy scale is C4 .. E5 pentatonic");
  const below = hold(m, 1, 30, t); t = below.t;
  const above = hold(m, 50, 30, t); t = above.t;
  check(below.r.note === 0 && above.r.note === 7, "below low = lowest note, above high = highest");
}

{ // hysteresis: wobbling across a boundary doesn't flicker
  const m = new Mapper({ low: 5, high: 35 });
  const edge = 5 + 3 * 30 / 8;  // boundary between notes 2 and 3
  let t = hold(m, edge - 1, 30, 0).t, changes = 0, last = null;
  for (let i = 0; i < 200; i++, t += FRAME) {
    const r = m.update(edge + 0.8 * Math.sin(i / 3), t);
    if (last != null && r.note !== last) changes++;
    last = r.note;
  }
  check(changes <= 1, `±0.8 cm wobble on a note boundary: ${changes} note change(s) in 4 s`);
}

{ // dropouts: under 400 ms hold the note, longer ones release; a one-frame jump is ignored
  const m = new Mapper({ low: 5, high: 35 });
  let { t } = hold(m, 20, 30, 0);
  const n0 = m.update(20, t).note;
  let r;
  for (let i = 0; i < 8; i++) { t += FRAME; r = m.update(null, t); }     // ~170 ms of nothing
  check(r.gate && r.note === n0, "170 ms dropout: note keeps sounding");
  for (let i = 0; i < 10; i++) { t += FRAME; r = m.update(null, t); }    // now ~380 ms
  check(r.gate, "380 ms dropout: still sounding");
  for (let i = 0; i < 10; i++) { t += FRAME; r = m.update(null, t); }    // now ~590 ms
  check(!r.gate, "590 ms of nothing: note stops");
  ({ t } = hold(m, 20, 10, t));
  t += FRAME; r = m.update(34, t);                                       // one wrong frame
  t += FRAME; r = m.update(20, t);
  check(r.note === n0, "a single wrong reading doesn't change the note");
  ({ t } = hold(m, null, 20, t));
  r = hold(m, 32, 3, t).r;
  check(r.gate && r.note === 7, "coming back after a gap jumps straight to the new note (no glide from the old height)");
}

{ // glide mode: continuous, C3..C5, smooth
  const m = new Mapper({ low: 5, high: 35, mode: "glide" });
  const a = hold(m, 5, 20, 0), b = hold(m, 35, 40, a.t), c = hold(m, 20, 40, b.t);
  check(Math.abs(a.r.midi - 48) < 0.1 && Math.abs(b.r.midi - 72) < 0.1 && Math.abs(c.r.midi - 60) < 0.2,
    `glide: 5 cm = C3, 35 cm = C5, 20 cm = C4 (${a.r.midi.toFixed(1)}, ${b.r.midi.toFixed(1)}, ${c.r.midi.toFixed(1)})`);
  // lag of the smoothing: step 10 -> 30 cm, time until the smoothed height is 90% of the way
  for (const [mode, limit] of [["glide", 160], ["easy", 100]]) {
    const m2 = new Mapper({ low: 5, high: 35, mode });
    let t = hold(m2, 10, 30, 0).t, k = 0;
    while (k < 50) { const r = m2.update(30, t); t += FRAME; k++; if ((r.cm - 10) / 20 >= 0.9) break; }
    console.log(`INFO smoothing lag (${mode}): a 10 -> 30 cm step is 90% done after ${k} frames (${Math.round(k * FRAME)} ms)`);
    check(k * FRAME <= limit, `${mode}: smoothing adds at most ${limit} ms to a big jump`);
  }
}

{ // calibration: reversed range works, too-close range refused
  const m = new Mapper();
  check(!m.setRange(10, 11), "range under 2 cm is refused");
  check(m.setRange(30, 8), "low above high is allowed (lowest note at the top)");
  const r = hold(m, 29, 30, 0).r;
  check(r.note === 0, "with low = 30 cm, 29 cm plays the lowest note");
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
