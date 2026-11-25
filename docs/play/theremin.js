// Height -> note, for the stage page and the Node tests (tests/test_theremin.js). No dependencies.
// The phone sends a height (cm) about 47 times a second, or null when nothing is above it.
// Mapper turns that into a smoothed position between the player's own "low" and "high" heights, then a note.
(function (root) {
  "use strict";
  const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const midiName = (m) => NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const EASY = [60, 62, 64, 67, 69, 72, 74, 76];  // C major pentatonic, C4..E5: no wrong notes
  const GLIDE = [48, 72];                         // theremin mode: C3..C5, continuous

  function Mapper(opts) {
    const o = Object.assign({ low: 2, high: 24, mode: "easy", notes: EASY, glide: GLIDE,
      holdMs: 400, tauMs: 40,  // hold: 250 ms cut the note 4 times on a real 15-36 cm book lift, 400 ms once
      tauEasyMs: 15, hyst: 0.25,
      minZoneCm: 3 }, opts || {});  // every note gets at least 3 cm (closer than that, noise alone changed notes)
    // Glide smooths more (a wobbly height is a wobbly pitch); easy mode has the note hysteresis, so it smooths less.
    this.o = o;
    this.win = [];          // last 3 heights, for a median (kills one-frame jumps)
    this.cm = null;         // smoothed height
    this.lastSeen = -1e9;   // time of the last real height
    this.zone = -1;         // current note in easy mode
    this.t = null;
    this.layout();
  }

  // Note zones from low to high. As many notes as fit at minZoneCm each (2-20 cm: 6 notes of 3 cm). If there's
  // room to spare, the zones start at minZoneCm near the phone and grow evenly (geometrically) further up.
  Mapper.prototype.layout = function () {
    const o = this.o, span = Math.abs(o.high - o.low);
    const N = Math.max(2, Math.min(o.notes.length, Math.floor(span / o.minZoneCm + 1e-9)));
    const w0 = Math.min(o.minZoneCm, span / N);
    let r = 1;
    if (w0 * N < span - 1e-9) {               // solve w0 * (1 + r + ... + r^(N-1)) = span for r > 1
      let lo = 1, hi = 3;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2, sum = w0 * (Math.pow(mid, N) - 1) / (mid - 1); if (sum > span) hi = mid; else lo = mid; }
      r = (lo + hi) / 2;
    }
    this.edges = [0];                          // distance from "low" to each zone edge, cm
    for (let k = 0; k < N; k++) this.edges.push(this.edges[k] + w0 * Math.pow(r, k));
    this.edges[N] = span;
    this.active = o.notes.slice(0, N);
  };

  Mapper.prototype.setRange = function (low, high) {
    if (Math.abs(high - low) < 2) return false;   // too close together to play
    this.o.low = low; this.o.high = high;
    this.zone = -1;
    this.layout();
    return true;
  };

  // cm: height or null; t: ms. Returns { gate, cm, pos 0..1, midi, note (easy: index), name }
  Mapper.prototype.update = function (cm, t) {
    const o = this.o;
    const dt = this.t == null ? 0 : Math.max(0, t - this.t);
    this.t = t;
    if (cm != null) {
      this.win.push(cm);
      if (this.win.length > 3) this.win.shift();
      const m = this.win.slice().sort((a, b) => a - b)[this.win.length >> 1];
      const fresh = t - this.lastSeen > o.holdMs;    // coming back after a gap: jump, don't glide from the old height
      const tau = o.mode === "glide" ? o.tauMs : o.tauEasyMs;
      this.cm = this.cm == null || fresh ? m : this.cm + (m - this.cm) * (1 - Math.exp(-dt / tau));
      this.lastSeen = t;
    }
    const gate = this.cm != null && t - this.lastSeen <= o.holdMs;  // short dropouts hold the note
    if (!gate) { this.win.length = 0; return { gate: false, cm: null, pos: null, midi: null, note: -1, name: "" }; }

    // Low and high can be either way round: "low" is where the lowest note is. pos runs 0..1 with each zone an
    // equal share, so glide mode is no more sensitive near the phone than easy mode.
    const E = this.edges, N = E.length - 1;
    const d = Math.min(E[N], Math.max(0, (this.cm - o.low) * Math.sign(o.high - o.low)));
    let k = 0;
    while (k < N - 1 && d >= E[k + 1]) k++;
    const pos = (k + (d - E[k]) / (E[k + 1] - E[k])) / N;
    if (o.mode === "glide") {
      const midi = o.glide[0] + pos * (o.glide[1] - o.glide[0]);
      return { gate: true, cm: this.cm, pos, midi, note: -1, name: midiName(midi) };
    }
    const notes = this.active, x = pos * N;
    let z = this.zone;
    if (z < 0 || x < z - o.hyst || x > z + 1 + o.hyst) z = Math.min(N - 1, Math.floor(x));  // hysteresis: no flicker on a boundary
    this.zone = z;
    return { gate: true, cm: this.cm, pos, midi: notes[z], note: z, name: midiName(notes[z]) };
  };

  // The synth: a theremin voice (sine, a little triangle, vibrato) or a marimba, through a 3.2 kHz low-pass and a
  // little reverb. ctx: an AudioContext to play into (the phone passes its sonar one; leave it out for a new one).
  // opts: out (node to play into, default the speakers), transpose (semitones), cutoff (low-pass, Hz),
  // triangle (how much of the brighter triangle wave). Phone speakers barely play below 500 Hz, so the phone
  // asks for an octave up and a brighter tone. Everything stays below about 10 kHz, far under the sonar's band.
  function Synth(ctx, opts) {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    const so = Object.assign({ out: ctx.destination, transpose: 0, cutoff: 3200, triangle: 0.18 }, opts || {});
    const master = ctx.createGain(); master.gain.value = 0.8; master.connect(so.out);
    // a little reverb: a convolver with 1.6 s of decaying noise
    const rev = ctx.createConvolver(), len = Math.round(ctx.sampleRate * 1.6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    rev.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.22; rev.connect(wet); wet.connect(master);
    const bus = ctx.createBiquadFilter(); bus.type = "lowpass"; bus.frequency.value = so.cutoff;
    bus.connect(master); bus.connect(rev);
    // theremin voice: sine plus a little triangle, with vibrato
    const vca = ctx.createGain(); vca.gain.value = 0; vca.connect(bus);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o1.type = "sine"; o2.type = "triangle"; g2.gain.value = so.triangle;
    o1.connect(vca); o2.connect(g2); g2.connect(vca);
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 5.5; depth.gain.value = 0; lfo.connect(depth); depth.connect(o1.frequency); depth.connect(o2.frequency);
    [o1, o2, lfo].forEach((o) => o.start());
    const s = { ctx, master, freq: 0, gain: 0, strikes: 0, running: ctx.state };
    let lastNote = -1;
    function strike(f) {        // marimba: a bar struck once, partials at 1x, 3.9x and 9.2x
      const t = ctx.currentTime, env = ctx.createGain();
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.5, t + 0.003); env.gain.setTargetAtTime(0, t + 0.003, 0.22);
      env.connect(bus);
      [[1, 1, 0.22], [3.9, 0.25, 0.06], [9.2, 0.08, 0.03]].forEach(([r, a, tau]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f * r; g.gain.setValueAtTime(a, t); g.gain.setTargetAtTime(0, t, tau);
        o.connect(g); g.connect(env); o.start(t); o.stop(t + 1.5);
      });
      s.strikes++;
    }
    s.set = (o, v, mode) => {
      const t = ctx.currentTime, f = o.gate ? midiHz(o.midi + so.transpose) : s.freq;
      const ther = v === "theremin" || mode === "glide";   // marimba only makes sense with separate notes
      if (o.gate && f) {
        o1.frequency.setTargetAtTime(f, t, mode === "glide" ? 0.012 : 0.02);
        o2.frequency.setTargetAtTime(f, t, mode === "glide" ? 0.012 : 0.02);
        depth.gain.setTargetAtTime(f * 0.007, t, 0.2);
      }
      const g = o.gate && ther ? 0.32 : 0;
      vca.gain.setTargetAtTime(g, t, g ? 0.03 : 0.12);   // fade in quickly, out gently
      if (!ther && o.gate && o.note !== lastNote) strike(f);
      lastNote = o.gate ? o.note : -1;
      s.freq = f; s.gain = g;
      s.running = ctx.state;
    };
    return s;
  }

  const api = { Mapper, Synth, midiName, midiHz, EASY, GLIDE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Theremin = api;
})(typeof window !== "undefined" ? window : globalThis);
