// Pentatonic kit check, at 4, 5, 6 and 8 pads: every key x mode x style x voice, every pad.
// Checks pad labels and explainer cards, the frequencies the synth actually starts, the MIDI notes sent, and page errors.
// Starts its own server on spare ports (no real training touched). Run:  node tools/browser-tests/pentatonic.js [screenshot-dir]
const os = require("os"), path = require("path");
const { launch, startServer, wait } = require("./cdp.js");
const OUT = process.argv[2] || os.tmpdir();

// Expected notes, worked out independently of stage.html
const ROOT = { C: 72, D: 74, E: 76, G: 67, A: 69 }, STEPS = { major: [0, 2, 4, 7, 9], minor: [0, 3, 5, 7, 10] };
const SH = "C C# D D# E F F# G G# A A# B".split(" "), FL = "C Db D Eb E F Gb G Ab A Bb B".split(" ");
const expect = (pads, key, mode, style) => Array.from({ length: pads }, (_, k) => {
  const r = ROOT[key] + 12 * Math.floor(k / 5) + STEPS[mode][k % 5];
  return { label: (mode === "minor" ? FL : SH)[r % 12] + "'".repeat(Math.floor(k / 5)) + (style === "power" ? " power" : ""),
           notes: style === "power" ? [r - 12, r - 5, r] : [r] };
});
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Runs before the page: log every oscillator's frequency at start(), count noise bursts, and fake a MIDI output.
const PROBE = `(() => {
  window.__osc = []; window.__midi = []; window.__noise = 0;
  const bs = AudioBufferSourceNode.prototype.start; // noise-based sounds (hats, shakers) use buffer sources
  AudioBufferSourceNode.prototype.start = function (...a) { window.__noise++; return bs.apply(this, a); };
  const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, "value");
  const mk = BaseAudioContext.prototype.createOscillator;
  BaseAudioContext.prototype.createOscillator = function () {
    const o = mk.call(this), fp = o.frequency, sv = fp.setValueAtTime.bind(fp);
    o.__f = 440;
    fp.setValueAtTime = (v, t) => { o.__f = v; return sv(v, t); };
    Object.defineProperty(fp, "value", { get() { return desc.get.call(fp); }, set(v) { o.__f = v; desc.set.call(fp, v); } });
    const st = o.start.bind(o); o.start = (...a) => { window.__osc.push(o.__f); return st(...a); };
    return o;
  };
  navigator.requestMIDIAccess = async () => ({ outputs: new Map([["x", { name: "Test port", send: (m) => window.__midi.push(m) }]]) });
})();`;

(async () => {
  const srv = await startServer({ http: 8101, https: 8544 });
  const browser = await launch();
  let fails = 0, combos = 0;
  const fail = (m) => { fails++; if (fails < 40) console.log("FAIL", m); };
  try {
    const p = await browser.page(srv.stage, { init: PROBE });
    await p.click("#go"); await wait(200);
    const setPads = (count) => fetch(srv.stage + "pads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count, names: {} }) });

    for (const PADS of [4, 5, 6, 8]) {
      await setPads(PADS);
      if (!(await p.until(`document.querySelectorAll(".pad").length === ${PADS}`, 4000))) { fail(`stage did not switch to ${PADS} pads`); continue; }
      // Other kits must still play every pad, and the options row only shows for Pentatonic
      for (const k of ["drums", "desi", "marimba", "chords", "melody", "custom"]) {
        await p.select("#kit", k);
        if (!(await p.js(`document.getElementById("pentaOpts").classList.contains("hidden")`))) fail(`options row visible on ${k}`);
        for (let n = 1; n <= PADS; n++) {
          await p.js(`window.__osc.length = 0; window.__noise = 0`); await p.key(n);
          if (!(await p.js(`window.__osc.length + window.__noise`))) fail(`${PADS} pads: kit ${k} pad ${n} made no sound`);
        }
      }
      await p.select("#kit", "pentatonic");
      if (await p.js(`document.getElementById("pentaOpts").classList.contains("hidden")`)) fail("options row hidden on pentatonic");
      for (const key of Object.keys(ROOT)) for (const mode of ["major", "minor"]) for (const style of ["notes", "power"]) for (const voice of ["marimba", "keys", "pluck"]) {
        combos++;
        await p.select("#pKey", key); await p.select("#pMode", mode); await p.select("#pStyle", style); await p.select("#pVoice", voice);
        const exp = expect(PADS, key, mode, style), tag = `${PADS}p ${key} ${mode} ${style} ${voice}`;
        const byPad = Object.fromEntries((await p.js(`[...document.querySelectorAll(".pad")].map((e) => [e.querySelector(".num").textContent, e.querySelector(".snd").textContent])`)));
        exp.forEach((e, k) => { if (byPad[k + 1] !== e.label) fail(`${tag}: pad ${k + 1} label "${byPad[k + 1]}" != "${e.label}"`); });
        const cards = await p.js(`[...document.querySelectorAll("#fps .fp .nm")].map((e) => e.textContent)`);
        if (cards.length !== PADS) fail(`${tag}: ${cards.length} explainer cards`);
        exp.forEach((e, k) => { if (cards[k] !== e.label) fail(`${tag}: explainer card ${k + 1} "${cards[k]}" != "${e.label}"`); });
        for (let n = 1; n <= PADS; n++) {
          await p.js(`window.__osc.length = 0`); await p.key(n);
          const got = await p.js(`window.__osc.slice()`);
          for (const note of exp[n - 1].notes) if (!got.some((f) => Math.abs(f - mtof(note)) < 0.05)) fail(`${tag} pad ${n}: no oscillator at ${mtof(note).toFixed(2)} Hz (got ${got.map((f) => f.toFixed(1)).join(",")})`);
        }
      }
      // MIDI path, every key x mode x style
      await p.click("#midi"); await wait(50);
      if (!(await p.text("#midi")).includes("Test port")) fail("MIDI out did not turn on");
      for (const key of Object.keys(ROOT)) for (const mode of ["major", "minor"]) for (const style of ["notes", "power"]) {
        await p.select("#pKey", key); await p.select("#pMode", mode); await p.select("#pStyle", style);
        const exp = expect(PADS, key, mode, style);
        for (let n = 1; n <= PADS; n++) {
          await p.js(`window.__midi.length = 0`); await p.key(n);
          const ons = (await p.js(`window.__midi.map((m) => [...m])`)).filter((m) => m[0] === 0x90).map((m) => m[1]);
          if (JSON.stringify(ons) !== JSON.stringify(exp[n - 1].notes)) fail(`MIDI ${PADS}p ${key} ${mode} ${style} pad ${n}: sent ${ons} expected ${exp[n - 1].notes}`);
        }
      }
      await p.click("#midi");
      if (PADS === 5) {
        await p.select("#pKey", "C"); await p.select("#pMode", "major"); await p.select("#pStyle", "notes"); await p.select("#pVoice", "marimba");
        for (const n of [1, 2, 3, 4, 5, 4, 3]) { await p.key(n); await wait(90); }
        await p.shot(path.join(OUT, "pentatonic-5-pads.png"));
      }
    }

    // Settings survive a reload
    await p.select("#pKey", "A"); await p.select("#pMode", "minor"); await p.select("#pStyle", "power"); await p.select("#pVoice", "pluck");
    await p.reload();
    const kept = await p.js(`["pKey","pMode","pStyle","pVoice"].map((id) => document.getElementById(id).value).join(" ")`);
    if (kept !== "A minor power pluck") fail("settings not kept after reload: " + kept);
    await p.js(`localStorage.removeItem("deskband.pentatonic.v1")`);

    if (p.errors.length) { fails += p.errors.length; console.log("page errors:", p.errors); }
    console.log(`${combos} pad-count/key/mode/style/voice combinations, every pad, plus MIDI and the other 6 kits: ${fails ? fails + " FAILURES" : "all OK, no page errors"}`);
  } catch (e) { fails++; console.error(e); }
  finally { browser.close(); srv.stop(); }
  process.exit(fails ? 1 : 0);
})();
