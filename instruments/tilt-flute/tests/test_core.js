// Offline test of static/flute-core.js with synthetic signals. Run: node tests/test_core.js
const C = require("../static/flute-core.js");
let failed = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- tilt from gravity ----------
{
  const D = Math.PI / 180;
  // Phone held sideways like a flute: long axis (y) horizontal, screen facing the player, so gravity lies along -x.
  // Turning the screen up/away rotates gravity in the x-z plane; raising the far end tilts it towards y.
  const turn = (deg, lift = 0) => [-Math.cos(deg * D) * Math.cos(lift * D), Math.sin(lift * D), Math.sin(deg * D) * Math.cos(lift * D)];
  const cal = C.calibrate(turn(-10), turn(50));
  check(near(cal.span, 60, 0.01), `span of the calibrated range is 60° (got ${cal.span.toFixed(2)})`);
  let worst = 0;
  for (let a = -10; a <= 50; a += 5) worst = Math.max(worst, Math.abs(C.tiltAngles(turn(a), cal).pos - (a + 10)));
  check(worst < 0.01, "position along the note axis follows the turn exactly");
  const lifted = C.tiltAngles(turn(20, 15), cal);
  check(near(lifted.off, 15, 0.5) && near(lifted.pos, 30, 0.5),
    `lifting the far end shows up as 'off' (${lifted.off.toFixed(1)}°), not as a note change (pos ${lifted.pos.toFixed(1)}°)`);
  // the phone's own beta flips by 180° when rolled near its side; gravity angles must stay continuous
  let jump = 0, prev = null;
  for (let a = 60; a <= 120; a += 1) { const p = C.tiltAngles(turn(a), C.calibrate(turn(60), turn(120))).pos; if (prev !== null) jump = Math.max(jump, Math.abs(p - prev)); prev = p; }
  check(jump < 1.01, "no jumps when the phone turns through its side (largest step " + jump.toFixed(2) + "°)");
  // gravity scale or sign convention doesn't matter (iOS reports the opposite sign to the spec)
  const flipped = C.calibrate(turn(-10).map((v) => -9.81 * v), turn(50).map((v) => -9.81 * v));
  check(near(C.tiltAngles(turn(20).map((v) => -9.81 * v), flipped).pos, 30, 0.01), "works with flipped and scaled gravity");
}

// ---------- steps with hysteresis ----------
{
  const flicker = (hyst) => {
    const s = new C.Stepper(8, 80, hyst); let changes = 0, last = null;
    for (let i = 0; i < 400; i++) { const st = s.update(30 + 1.2 * Math.sin(i / 3)); if (last !== null && st !== last) changes++; last = st; }
    return changes;
  };
  check(flicker(0) > 20, `without hysteresis, wobbling ±1.2° on a boundary flickers (${flicker(0)} changes)`);
  check(flicker(2.5) === 0, "with 2.5° hysteresis it doesn't flicker");
  const s = new C.Stepper(8, 80, 2.5); s.update(5);
  check(s.update(25) === 2 && s.update(75) === 7 && s.update(-20) === 0, "a real move still changes the note, clamped to the ends");
}

// ---------- breath detector ----------
const SR = 48000;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
const r = rng(7);
const gen = {
  room: (n) => Float32Array.from({ length: n }, () => r() * 0.0005),
  breath: (n) => { let y = 0; return Float32Array.from({ length: n }, () => (y += 0.12 * (r() * 0.5 - y))); }, // low-passed hiss
  voice: (n) => { let ph = 0; return Float32Array.from({ length: n }, (_, i) => { // pitch with 5 Hz vibrato, phase built up sample by sample
    ph += (2 * Math.PI * 140 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * i / SR))) / SR;
    let v = 0; for (let h = 1; h <= 20; h++) v += Math.sin(ph * h) / h; return 0.08 * v + r() * 0.0005;
  }); },
  flute: (n) => Float32Array.from({ length: n }, (_, i) => {
    const t = i / SR; return 0.1 * (Math.sin(2 * Math.PI * 523 * t) + 0.2 * Math.sin(2 * Math.PI * 1046 * t) + 0.1 * Math.sin(2 * Math.PI * 1569 * t)) + r() * 0.0005;
  }),
};
{
  const feats = new C.AudioFeatures(SR), det = new C.BreathDetector();
  const seq = [["room", 1.0], ["breath", 1.0], ["room", 0.5], ["voice", 1.0], ["room", 0.5], ["flute", 1.0], ["room", 0.5], ["breath", 1.0]];
  let t = 0; const out = {};
  const t0 = process.hrtime.bigint(); let frames = 0;
  for (const [kind, sec] of seq) {
    const x = gen[kind](Math.round(sec * SR));
    const segStart = t;
    const stats = (out[kind] = out[kind] || { n: 0, on: 0, flat: [], period: [], above: [] });
    for (let i = 0; i < x.length; i += 256) {
      t += (256 / SR) * 1000;
      feats.push(x.subarray(i, i + 256), t, (f) => {
        frames++;
        const d = det.push(f);
        if (f.t < segStart + 80) return; // skip frames that still overlap the previous sound (frame + 3-of-5 vote)
        stats.n++; stats.on += d.on ? 1 : 0; stats.flat.push(f.flat); stats.period.push(f.period); stats.above.push(f.band - d.floor);
      });
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  for (const [k, s] of Object.entries(out))
    console.log(`  ${k.padEnd(6)} breath ${(100 * s.on / s.n).toFixed(0).padStart(3)}% of frames · flatness ${med(s.flat).toFixed(3)} · periodicity ${med(s.period).toFixed(2)} · ${med(s.above).toFixed(0)} dB above floor`);
  check(out.breath.on / out.breath.n > 0.95, "breath (hiss) is detected");
  check(out.voice.on / out.voice.n < 0.05, "voice is not breath");
  check(out.flute.on / out.flute.n < 0.05, "a flute tone (e.g. from the laptop speaker) is not breath");
  check(out.room.on === 0, "room noise is not breath");
  check(ms / frames < 5, `features are cheap enough for a phone (${(ms / frames).toFixed(2)} ms per frame in Node, frames every ${(C.HOP / SR * 1000).toFixed(1)} ms)`);
}

{ // level follows the breath: on after the 3-of-5 vote (3 frames), fast attack (~10 ms), gentle release (~80 ms)
  const det = new C.BreathDetector(); let t = 0;
  for (let i = 0; i < 50; i++) det.push({ t: (t += 10.7), band: -70, flat: 0.5, period: 0.2 });
  const up = []; for (let i = 0; i < 8; i++) up.push(det.push({ t: (t += 10.7), band: -30, flat: 0.5, period: 0.2 }).level);
  const down = []; for (let i = 0; i < 25; i++) down.push(det.push({ t: (t += 10.7), band: -70, flat: 0.5, period: 0.2 }).level);
  check(up[1] === 0 && up[3] > 0.6 * up[7], `breath turns on at the 3rd loud frame, about 32 ms (${up.map((v) => v.toFixed(2)).join(" ")})`);
  check(down[4] > 0.3 * up[7] && down[24] < 0.15 * up[7], "level fades over about 80 ms after the vote ends, not instantly");
}

{ // noise floor: ignores the mic's first silent frames, follows the room, and isn't lifted by a long blow
  const det = new C.BreathDetector(); let t = 0, d;
  for (let i = 0; i < 20; i++) d = det.push({ t: (t += 10.7), band: -160, flat: 0.5, period: 0.2 });
  check(d.floor === null && !d.on, "digital silence at start doesn't set a floor");
  for (let i = 0; i < 300; i++) d = det.push({ t: (t += 10.7), band: -70 + (i % 5), flat: 0.5, period: 0.2 });
  check(near(d.floor, -70, 0.01), `floor is the room's level (${d.floor})`);
  for (let i = 0; i < 560; i++) d = det.push({ t: (t += 10.7), band: -35, flat: 0.4, period: 0.2 }); // 6 s blow
  check(near(d.floor, -70, 0.01) && d.on, "a 6 s blow keeps the floor and stays detected");
  for (let i = 0; i < 1400; i++) d = det.push({ t: (t += 10.7), band: -55, flat: 0.5, period: 0.2 }); // room got noisier
  check(near(d.floor, -55, 0.01), "floor follows a noisier room within about 10 s");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
