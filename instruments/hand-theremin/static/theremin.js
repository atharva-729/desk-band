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
    const o = Object.assign({ low: 5, high: 35, mode: "easy", notes: EASY, glide: GLIDE,
      holdMs: 400, tauMs: 40,  // hold: 250 ms cut the note 4 times on a real 15-36 cm book lift, 400 ms once
      tauEasyMs: 15, hyst: 0.25 }, opts || {});
    // Glide smooths more (a wobbly height is a wobbly pitch); easy mode has the note hysteresis, so it smooths less.
    this.o = o;
    this.win = [];          // last 3 heights, for a median (kills one-frame jumps)
    this.cm = null;         // smoothed height
    this.lastSeen = -1e9;   // time of the last real height
    this.zone = -1;         // current note in easy mode
    this.t = null;
  }

  Mapper.prototype.setRange = function (low, high) {
    if (Math.abs(high - low) < 2) return false;   // too close together to play
    this.o.low = low; this.o.high = high;
    this.zone = -1;
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

    // Low and high can be either way round: "low" is where the lowest note is.
    const span = o.high - o.low;
    const pos = Math.min(1, Math.max(0, (this.cm - o.low) / span));
    if (o.mode === "glide") {
      const midi = o.glide[0] + pos * (o.glide[1] - o.glide[0]);
      return { gate: true, cm: this.cm, pos, midi, note: -1, name: midiName(midi) };
    }
    const N = o.notes.length, x = pos * N;
    let z = this.zone;
    if (z < 0 || x < z - o.hyst || x > z + 1 + o.hyst) z = Math.min(N - 1, Math.floor(x));  // hysteresis: no flicker on a boundary
    this.zone = z;
    return { gate: true, cm: this.cm, pos, midi: o.notes[z], note: z, name: midiName(o.notes[z]) };
  };

  const api = { Mapper, midiName, midiHz, EASY, GLIDE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Theremin = api;
})(typeof window !== "undefined" ? window : globalThis);
