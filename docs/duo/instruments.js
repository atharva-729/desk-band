// Desk Band Duo: the 8 instruments, each with TWO sounds: one for a tap on the table, one for a tap on the laptop.
// Uses the synth voices, chords and song from ../band/sounds.js. Unlike the band, where you tap decides the sound,
// not where the tap lands on the beat, so the player is in control.
// play(b, t, v, S, V, out, M, zone) -> label. zone: "table" | "laptop".
(function (root) {
  "use strict";
  const { PENTA, inRange, noteName } = root.BandMusic;
  const pc = (m) => ((m % 12) + 12) % 12;

  // a melody you steer: the table steps down, the laptop steps up; on the beat it settles on a note of the chord
  function walk(S, notes, b, dir, v, M) {
    const n = notes.length;
    if (S.i == null) S.i = n >> 1;
    S.i += dir * (v > 0.85 ? 2 : 1);
    if (S.i < 0) S.i = 1; if (S.i >= n) S.i = n - 2;
    if (b % 1 === 0) {
      const ch = M.chord(b).pcs, ok = (k) => k >= 0 && k < n && ch.includes(pc(notes[k]));
      for (let d = 0; d < n; d++) { if (ok(S.i + dir * d)) { S.i += dir * d; break; } if (ok(S.i - dir * d)) { S.i -= dir * d; break; } }
    }
    return notes[S.i];
  }

  const ROLES = [
    { key: "drums", name: "Drums", color: "#ff8a5a", grid: 0.5, gain: 1, table: "kick", laptop: "snare",
      how: "Table = kick drum, laptop = snare. Hard on the laptop adds a crash.",
      play(b, t, v, S, V, o, M, z) {
        if (z === "table") { V.kick(o, t, v); V.hat(o, t, v * 0.4); return "kick"; }
        V.snare(o, t, v); if (v > 0.85) { V.crash(o, t, v * 0.8); return "snare + crash"; } return "snare";
      } },
    { key: "synth", name: "Synth lead", color: "#5aa8ff", grid: 0.5, gain: 1, table: "tune goes down", laptop: "tune goes up",
      how: "You steer the tune: table = the next note down, laptop = the next note up.",
      play(b, t, v, S, V, o, M, z) {
        const m = walk(S, inRange(PENTA, 67, 84), b, z === "laptop" ? 1 : -1, v, M);
        V.lead(o, t, m, v, 0.45 * M.beatSec); return (z === "laptop" ? "↑ " : "↓ ") + noteName(m);
      } },
    { key: "bass", name: "Bass", color: "#3dd6a3", grid: 0.5, gain: 1, table: "root", laptop: "fifth",
      how: "Table = the chord's low root note, laptop = its fifth (hard = an octave up).",
      play(b, t, v, S, V, o, M, z) {
        const ch = M.chord(b), r = 36 + ch.root, m = z === "table" ? r : r + (v > 0.85 ? 12 : 7);
        V.bass(o, t, m, Math.max(0.5, v), 0.72 * M.beatSec); return noteName(m);
      } },
    { key: "piano", name: "Piano chords", color: "#ffc23d", grid: 0.5, gain: 1, table: "low chord", laptop: "high stab",
      how: "Table = a deep, ringing chord; laptop = a short, bright chord stab.",
      play(b, t, v, S, V, o, M, z) {
        const ch = M.chord(b);
        if (z === "table") {
          inRange(ch.pcs, 52, 64).slice(0, 3).forEach((m, i) => V.keys(o, t + i * 0.012, m, 0.55 + 0.45 * v, 1.6));
          V.keys(o, t, 36 + ch.root, 0.45 * v, 1.6); return ch.name + " low";
        }
        inRange(ch.pcs, 67, 79).slice(0, 3).forEach((m, i) => V.keys(o, t + i * 0.008, m, 0.5 + 0.4 * v, 0.28));
        return ch.name + " stab";
      } },
    { key: "marimba", name: "Marimba", color: "#6be0ff", grid: 0.5, gain: 1, table: "down", laptop: "up",
      how: "You steer it: table = the next marimba note down, laptop = up.",
      play(b, t, v, S, V, o, M, z) {
        const m = walk(S, inRange(PENTA, 69, 91), b, z === "laptop" ? 1 : -1, v, M);
        V.mallet(o, t, m, v); return (z === "laptop" ? "↑ " : "↓ ") + noteName(m);
      } },
    { key: "shakers", name: "Shakers & claps", color: "#b8e05a", grid: 0.5, gain: 2.2, table: "clap", laptop: "shaker",
      how: "Table = clap, laptop = shaker. Hard on the laptop = tambourine.",
      play(b, t, v, S, V, o, M, z) {
        if (z === "table") { V.clap(o, t, v); return "clap"; }
        if (v > 0.85) { V.tambourine(o, t, v); return "tambourine"; }
        V.shaker(o, t, v); return "shaker";
      } },
    { key: "desi", name: "Dhol & tabla", color: "#ff6b9a", grid: 0.5, gain: 1, table: "dhol", laptop: "tabla",
      how: "Table = the deep dhol, laptop = the tabla (hard = a dhol slap).",
      play(b, t, v, S, V, o, M, z) {
        if (z === "table") { V.dholLow(o, t, v); return "dhol"; }
        if (v > 0.85) { V.dholSlap(o, t, v); return "dhol slap"; }
        S.k = ((S.k ?? 0) + 1) % 2; if (S.k) { V.tablaNa(o, t, v); return "tabla na"; } V.tablaTin(o, t, v); return "tabla tin";
      } },
    { key: "arp", name: "Arpeggiator", color: "#ff9fe0", grid: 1, gain: 1, table: "low run", laptop: "high run",
      how: "A tap starts a rippling run of the chord for 2 beats: table = low and falling, laptop = high and rising.",
      play(b, t, v, S, V, o, M, z) { S.until = Math.max(S.until || 0, b + 2); S.v = v; S.z = z; return z === "laptop" ? "high run" : "low run"; },
      tick(b, t, S, V, o, M) {   // every 16th note while a tap keeps it alive
        if (!(S.until > b)) return null;
        const hi = S.z === "laptop", notes = inRange(M.chord(b).pcs, hi ? 67 : 52, hi ? 86 : 71), n = notes.length;
        const k = Math.round(b * 4) % n, m = notes[hi ? k : n - 1 - k];
        V.pluck(o, t, m, S.v || 0.6); return noteName(m);
      } },
  ];

  root.DuoMusic = { ROLES };
})(typeof window !== "undefined" ? window : globalThis);
