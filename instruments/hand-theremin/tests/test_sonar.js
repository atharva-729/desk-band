// Offline check of the sonar maths in static/sonar.js, on a simulated mic (no phone, no browser).
// Run: node tests/test_sonar.js
// This proves the maths finds an echo where we put it. It says nothing yet about a real hand on a real phone:
// that is the Phase 1 ruler test.
const { Sonar, Simulator } = require("../static/sonar.js");

let failed = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };

function run(fs, { handAmp = 0.004, start = 137, block = 1024 } = {}) {
  const s = new Sonar(fs), sim = Simulator(s, { start, hand: handAmp });
  const frames = [];
  const feed = (nFrames, handCm, shift = 0) => {
    const out = [];
    let left = nFrames * s.P, first = true;
    while (left > 0) {
      const n = Math.min(block, left);
      s.push(sim.next(n, handCm, first ? shift : 0), (r) => out.push(r));
      first = false; left -= n;
    }
    frames.push(...out);
    return out;
  };
  return { s, sim, feed, frames };
}

// 1. Chirp shape: fades to silence at both ends (no clicks) and stays inside the period
{
  const s = new Sonar(48000);
  const c = s.chirp;
  check(Math.abs(c[0]) < 1e-6 && Math.abs(c[c.length - 1]) < 0.01, "chirp starts and ends at silence");
  check(c.length === 480 && s.P === 1024, `10 ms chirp in a 1024-sample period (${c.length} samples)`);
  check(Math.abs(s.cmPerRow - 0.357) < 0.001, `one sample = ${(s.cmPerRow * 10).toFixed(2)} mm of hand distance at 48 kHz`);
}

// 2. Learns the empty table, then finds a hand at each height
for (const fs of [48000, 44100]) {
  for (const block of [1024, 4096, 300]) {
    const { s, feed } = run(fs, { block, start: 517 });
    const learn = feed(60, null);
    check(learn.slice(0, 47).every((r) => r.learning) && !learn[59].learning, `${fs} Hz, block ${block}: learns the background in about 1 s`);
    const quiet = feed(40, null);
    check(quiet.every((r) => !r.present), `${fs} Hz, block ${block}: no hand -> nothing detected`);
    const errs = [];
    for (const cm of [2.5, 3, 4, 5, 10, 15, 20, 30, 45, 55]) {
      const r = feed(20, cm).slice(3);
      const det = r.filter((x) => x.present);
      const err = det.length ? Math.max(...det.map((x) => Math.abs(x.handCm - cm))) : Infinity;
      errs.push(`${cm}cm:${det.length}/${r.length} ±${err.toFixed(2)}`);
      check(det.length === r.length && err < 1, `${fs} Hz, block ${block}: hand at ${cm} cm found (worst error ${err.toFixed(2)} cm)`);
    }
    const after = feed(10, null).slice(2);
    check(after.every((r) => !r.present), `${fs} Hz, block ${block}: hand away -> silence again`);
  }
}

// 3. How faint can the hand echo be? Report only: the real echo level is a Phase 1 question.
{
  const rows = [];
  for (const dbBelow of [30, 40, 50, 55, 60, 65]) {
    const amp = 0.3 * Math.pow(10, -dbBelow / 20);
    const { feed } = run(48000, { handAmp: amp });
    feed(60, null);
    const r = feed(30, 20).slice(3);
    const det = r.filter((x) => x.present && Math.abs(x.handCm - 20) < 1).length;
    rows.push(`${dbBelow} dB below the direct path: ${det}/${r.length}`);
  }
  console.log("INFO hand echo at 20 cm, mic noise 50 dB below the direct path:\n     " + rows.join("\n     "));
}

// 4. Dropped samples (a phone glitch): the page sees the gap on the audio clock and calls skip(), which pads
//    back into step. No re-learning, so a hand in view isn't baked into the "empty table".
{
  const { s, sim, feed } = run(48000);
  feed(60, null);
  feed(10, 20);
  sim.next(0, null, 37);  // the phone loses 37 samples while the hand is at 20 cm...
  s.skip(37);             // ...and the page notices
  const r = feed(40, 20);
  const ok = r.filter((x) => !x.glitch);
  check(s.relearns === 0 && s.gaps === 1, `gap patched without re-learning (re-learns ${s.relearns}, gaps ${s.gaps})`);
  check(r.filter((x) => x.glitch).length <= 2, "at most 2 frames ignored around the gap");
  check(ok.length >= 38 && ok.every((x) => x.present && Math.abs(x.handCm - 20) < 1), "hand at 20 cm still found right after the gap");
  const after = feed(20, null).slice(3);
  check(after.every((x) => !x.present), "hand away after the gap -> silence (background still lines up)");

  const u = run(48000);   // the same gap NOT patched, to show why it matters
  u.feed(60, null);
  u.sim.next(0, null, 37);
  const bad = u.feed(20, null).slice(3).filter((x) => x.present).length;
  console.log(`INFO same gap left unpatched: ${bad}/17 empty-table frames show a false hand`);
}

// 4b. Regression for the first iPhone run: a hand or book right over the speaker echoes LOUDER than the speaker's
//     own sound. Phase 0 took that as "the audio slipped" and re-learnt with the hand in view.
{
  const { s, feed } = run(48000, { handAmp: 0.6 });  // echo twice as loud as the direct path (0.3)
  feed(60, null);
  const errs = [];
  for (const cm of [6, 10, 15, 10, 6]) {
    const r = feed(100, cm).slice(3);               // about 2 s each, 10 s in all
    errs.push(r.every((x) => x.present && Math.abs(x.handCm - cm) < 1));
  }
  check(s.relearns === 0, `loud echo held for 10 s -> no re-learning (${s.relearns})`);
  check(errs.every(Boolean), "and the loud echo is tracked at 6, 10, 15 cm the whole time");
  const away = feed(20, null).slice(3);
  check(away.every((x) => !x.present), "loud echo removed -> silence");
  const heard = feed(1, null)[0];
  check(heard.snrDb > 30, `"chirp heard" is judged at the direct path, not at the loudest echo (${heard.snrDb.toFixed(0)} dB)`);
}

// 5. Chirp-heard numbers make sense
{
  const { feed } = run(48000);
  const r = feed(60, null);
  const last = r[r.length - 1];
  check(last.snrDb > 30 && Math.abs(last.directDb - 20 * Math.log10(0.3)) < 1,
    `direct path heard at ${last.directDb.toFixed(1)} dB, ${last.snrDb.toFixed(0)} dB above the floor`);
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
