// Desk Band Together: the music. Chord loops, the 8 instruments and their synthesised sounds.
// Every sound takes an exact AudioContext time, so the stage can place each knock on the beat grid.
// "Tap anywhere": a knock doesn't say WHICH sound; the instrument picks the right one for where on the beat the
// knock lands and which chord is playing, so nobody can play a wrong note or fall out of the groove.
(function (root) {
  "use strict";
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const noteName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const pc = (m) => ((m % 12) + 12) % 12;
  const inRange = (pcs, lo, hi) => { const o = []; for (let m = lo; m <= hi; m++) if (pcs.includes(pc(m))) o.push(m); return o; };

  const CHORDS = {
    C: { root: 0, pcs: [0, 4, 7] }, G: { root: 7, pcs: [7, 11, 2] }, Am: { root: 9, pcs: [9, 0, 4] },
    F: { root: 5, pcs: [5, 9, 0] }, Em: { root: 4, pcs: [4, 7, 11] }, Dm: { root: 2, pcs: [2, 5, 9] },
  };
  const PROGRESSIONS = [
    { id: "pop", name: "C · G · Am · F (pop)", chords: ["C", "G", "Am", "F"] },
    { id: "calm", name: "Am · F · C · G (calm)", chords: ["Am", "F", "C", "G"] },
    { id: "fifties", name: "C · Am · F · G (50s)", chords: ["C", "Am", "F", "G"] },
    { id: "one", name: "Just C (simplest)", chords: ["C"] },
  ];
  const PENTA = [0, 2, 4, 7, 9];   // C major pentatonic: fits every chord above

  // ---------- synth voices ----------
  function Voices(ctx, master) {
    let nb = null;
    const noise = () => {
      if (!nb) { nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
      const s = ctx.createBufferSource(); s.buffer = nb; return s;
    };
    const env = (g, t, peak, decay, attack = 0.003) => {
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    };
    const tone = (out, t, type, f0, f1, dur, v, peak = 1) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
      env(g, t, peak * v, dur); o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
    };
    const burst = (out, t, type, freq, q, dur, v, peak = 1) => {
      const s = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      env(g, t, peak * v, dur); s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + dur + 0.05);
    };
    const V = {
      // drums and percussion (from Desk Band's kits)
      kick: (o, t, v) => tone(o, t, "sine", 160, 42, 0.45, v, 1.1),
      snare: (o, t, v) => { burst(o, t, "highpass", 1400, 0.7, 0.22, v, 0.7); tone(o, t, "triangle", 220, 160, 0.12, v, 0.5); },
      hat: (o, t, v) => burst(o, t, "highpass", 7500, 0.8, 0.07, v, 0.5),
      crash: (o, t, v) => burst(o, t, "highpass", 5000, 0.5, 1.2, v, 0.5),
      clap: (o, t, v) => { [0, 0.012, 0.024].forEach((d) => burst(o, t + d, "bandpass", 1300, 1.2, 0.03, v, 0.8)); burst(o, t + 0.03, "bandpass", 1300, 1.2, 0.25, v, 0.5); },
      shaker: (o, t, v) => burst(o, t, "bandpass", 6000, 1.5, 0.12, v, 0.45),
      tambourine: (o, t, v) => [0, 0.025, 0.05, 0.08].forEach((d) => burst(o, t + d, "bandpass", 7500 + d * 20000, 4, 0.09, v, 0.5)),
      dholLow: (o, t, v) => { tone(o, t, "sine", 120, 70, 0.6, v, 1.1); burst(o, t, "lowpass", 400, 0.7, 0.08, v, 0.4); },
      dholSlap: (o, t, v) => { burst(o, t, "bandpass", 2200, 2, 0.09, v, 0.9); tone(o, t, "sine", 330, 260, 0.15, v, 0.4); },
      tablaNa: (o, t, v) => { tone(o, t, "sine", 620, 590, 0.5, v, 0.6); tone(o, t, "sine", 1240, 1180, 0.25, v, 0.25); burst(o, t, "bandpass", 3000, 3, 0.02, v, 0.4); },
      tablaTin: (o, t, v) => { tone(o, t, "sine", 880, 860, 0.4, v, 0.55); tone(o, t, "sine", 1760, 1720, 0.15, v, 0.2); burst(o, t, "bandpass", 4200, 3, 0.015, v, 0.35); },
      dholak: (o, t, v) => { tone(o, t, "sine", 190, 115, 0.35, v, 1.0); burst(o, t, "bandpass", 1500, 1.5, 0.05, v, 0.5); },
      // pitched
      mallet: (o, t, m, v) => { const f = mtof(m); tone(o, t, "sine", f, f, 0.9, v, 0.7); tone(o, t, "sine", f * 4, f * 4, 0.12, v, 0.15); },
      keys: (o, t, m, v, dur) => {
        const f = mtof(m);
        [[1, 0.5], [2, 0.14], [3, 0.05]].forEach(([h, a]) => {
          const x = ctx.createOscillator(), g = ctx.createGain();
          x.type = "sine"; x.frequency.value = f * h; env(g, t, a * v, dur / h); x.connect(g).connect(o); x.start(t); x.stop(t + dur + 0.05);
        });
      },
      bass: (o, t, m, v, dur) => {
        const f = mtof(m), x = ctx.createOscillator(), y = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
        x.type = "triangle"; y.type = "sine"; x.frequency.value = f; y.frequency.value = f;
        lp.type = "lowpass"; lp.frequency.setValueAtTime(500 + 900 * v, t); lp.frequency.exponentialRampToValueAtTime(220, t + dur);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7 * v, t + 0.008);
        g.gain.setValueAtTime(0.7 * v, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        x.connect(lp); y.connect(lp); lp.connect(g).connect(o); x.start(t); y.start(t); x.stop(t + dur + 0.05); y.stop(t + dur + 0.05);
      },
      lead: (o, t, m, v, dur) => {   // synth lead: saw + square an octave down, filter that opens with the knock
        const f = mtof(m), x = ctx.createOscillator(), y = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), gy = ctx.createGain();
        x.type = "sawtooth"; y.type = "square"; x.frequency.value = f; y.frequency.value = f / 2; gy.gain.value = 0.35;
        lp.type = "lowpass"; lp.Q.value = 4; lp.frequency.setValueAtTime(900 + 2600 * v, t); lp.frequency.exponentialRampToValueAtTime(700, t + dur);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.01);
        g.gain.setValueAtTime(0.16 * v, t + dur * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
        x.connect(lp); y.connect(gy).connect(lp); lp.connect(g).connect(o); x.start(t); y.start(t); x.stop(t + dur + 0.2); y.stop(t + dur + 0.2);
      },
      pluck: (o, t, m, v) => {
        const f = mtof(m), x = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
        x.type = "sawtooth"; x.frequency.value = f;
        lp.type = "lowpass"; lp.frequency.setValueAtTime(1200 + 2500 * v, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
        env(g, t, 0.13 * v + 0.03, 0.3); x.connect(lp).connect(g).connect(o); x.start(t); x.stop(t + 0.35);
      },
      riser: (o, t, dur) => {   // a whoosh that builds into the next section
        const s = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        f.type = "bandpass"; f.Q.value = 3; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(8000, t + dur);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.97); g.gain.linearRampToValueAtTime(0, t + dur);
        s.loop = true; s.connect(f).connect(g).connect(o); s.start(t); s.stop(t + dur + 0.05);
      },
      boom: (o, t, v) => tone(o, t, "sine", 90, 32, 1.6, v, 1.0),
      click: (o, t, accent) => {
        const x = ctx.createOscillator(), g = ctx.createGain();
        x.frequency.value = accent ? 1600 : 1000; env(g, t, accent ? 0.35 : 0.22, 0.05, 0.001);
        x.connect(g).connect(o); x.start(t); x.stop(t + 0.07);
      },
    };
    return V;
  }

  // ---------- the 8 instruments ----------
  // play(b, t, v, S, V, out, M) -> label. b: the beat the knock lands on (0 = first beat; 4 beats a bar), t: its time,
  // v: knock strength 0..1, S: this instrument's own memory, M: { chord(b), beatSec }.
  const step = (S, notes, b, v, M) => {   // a melody that wanders the pentatonic scale, landing on chord notes on the beat
    if (S.i == null) S.i = Math.floor(notes.length / 2);
    S.i += v > 0.8 ? 3 : [-2, -1, 1, 1, 2][Math.floor(Math.random() * 5)];
    if (S.i < 0) S.i = 1; if (S.i >= notes.length) S.i = notes.length - 2;
    if (b % 1 === 0) {   // on a beat: the nearest note that belongs to the chord
      const ch = M.chord(b).pcs, ok = (k) => k >= 0 && k < notes.length && ch.includes(pc(notes[k]));
      for (let d = 0; d < notes.length; d++) { if (ok(S.i + d)) { S.i += d; break; } if (ok(S.i - d)) { S.i -= d; break; } }
    }
    return notes[S.i];
  };
  const ROLES = [
    { key: "drums", name: "Drums", color: "#ff8a5a", grid: 0.5, gain: 1,
      how: "Kick on beats 1 and 3, snare on 2 and 4, hi-hat in between. Knock hard on beat 1 for a crash.",
      play(b, t, v, S, V, o) {
        const p = b % 4;
        if (p % 1) { V.hat(o, t, v); return "hi-hat"; }
        if (p === 1 || p === 3) { V.snare(o, t, v); return "snare"; }
        V.kick(o, t, v); V.hat(o, t, v * 0.5);
        if (p === 0 && v > 0.85) { V.crash(o, t, v * 0.8); return "kick + crash"; }
        return "kick";
      } },
    { key: "synth", name: "Synth lead", color: "#5aa8ff", grid: 0.5, gain: 1,
      how: "Each knock plays the next note of a tune that always fits. Knock hard to jump higher.",
      play(b, t, v, S, V, o, M) {
        const m = step(S, inRange(PENTA, 67, 84), b, v, M);
        V.lead(o, t, m, v, 0.45 * M.beatSec); return noteName(m);
      } },
    { key: "bass", name: "Bass", color: "#3dd6a3", grid: 0.5, gain: 1,
      how: "The chord's low note on beat 1, then its other bass notes (fifth, octave) as you keep knocking.",
      play(b, t, v, S, V, o, M) {
        const ch = M.chord(b), r = 36 + ((ch.root - 0 + 12) % 12), seq = [0, 7, 12, 7];
        S.n = b % 4 === 0 ? 0 : ((S.n ?? 0) + 1) % seq.length;
        const m = r + seq[S.n]; V.bass(o, t, m, Math.max(0.5, v), 0.9 * 0.5 * M.beatSec * 1.6); return noteName(m);
      } },
    { key: "piano", name: "Piano chords", color: "#ffc23d", grid: 0.5, gain: 1,
      how: "Each knock plays the chord that's playing: soft = a short stab, hard = a long ringing chord.",
      play(b, t, v, S, V, o, M) {
        const ch = M.chord(b), notes = inRange(ch.pcs, 60, 71).slice(0, 3), long = v > 0.6;
        notes.forEach((m, i) => V.keys(o, t + i * 0.012, m, 0.55 + 0.45 * v, long ? 1.6 : 0.3));
        V.keys(o, t, 48 + ch.root, 0.4 * v, long ? 1.6 : 0.3);
        return ch.name + (long ? "" : " stab");
      } },
    { key: "marimba", name: "Marimba", color: "#6be0ff", grid: 0.5, gain: 1,
      how: "Each knock plays the next marimba note, high and bright, always in the scale.",
      play(b, t, v, S, V, o, M) { const m = step(S, inRange(PENTA, 72, 88), b, v, M); V.mallet(o, t, m, v); return noteName(m); } },
    { key: "shakers", name: "Shakers & claps", color: "#b8e05a", grid: 0.5, gain: 2.2,
      how: "Claps on beats 2 and 4, shakers everywhere else. Knock hard for a tambourine.",
      play(b, t, v, S, V, o) {
        const p = b % 4;
        if (v > 0.85) { V.tambourine(o, t, v); return "tambourine"; }
        if (p === 1 || p === 3) { V.clap(o, t, v); return "clap"; }
        V.shaker(o, t, p % 1 ? v * 0.8 : v); return "shaker";
      } },
    { key: "desi", name: "Dhol & tabla", color: "#ff6b9a", grid: 0.5, gain: 1,
      how: "Dhol on the beats (deep on 1 and 3, slap on 2 and 4), tabla in between.",
      play(b, t, v, S, V, o) {
        const p = b % 4;
        if (p === 0) { V.dholLow(o, t, v); V.tablaNa(o, t, v * 0.5); return "dhol"; }
        if (p === 2) { V.dholLow(o, t, v); return "dhol"; }
        if (p === 1 || p === 3) { V.dholSlap(o, t, v); return "dhol slap"; }
        S.k = ((S.k ?? 0) + 1) % 2; if (S.k) { V.tablaTin(o, t, v); return "tabla"; } V.dholak(o, t, v); return "dholak";
      } },
    { key: "arp", name: "Arpeggiator", color: "#ff9fe0", grid: 1, gain: 1,
      how: "A knock starts a rippling run of the chord's notes for 2 beats. Keep knocking to keep it going.",
      play(b, t, v, S) { S.until = Math.max(S.until || 0, b + 2); S.v = v; return "arpeggio"; },
      tick(b, t, S, V, o, M) {   // every 16th note: plays while a knock keeps it alive
        if (!(S.until > b)) return null;
        const notes = inRange(M.chord(b).pcs, 60, 79), n = notes.length, k = Math.round(b * 4) % (2 * n - 2);
        const m = notes[k < n ? k : 2 * n - 2 - k]; V.pluck(o, t, m, S.v || 0.6); return noteName(m);
      } },
  ];

  // ---------- a song: sections with their own chords and levels (1 = normal, 0 = that instrument rests) ----------
  // lift: a whoosh in the bar before it, and a boom + crash on its first beat.
  const SONG = [
    { name: "Intro", bars: 4, chords: ["Am", "F", "C", "G"], tip: "Soft start: piano, marimba and arpeggiator only",
      lvl: { drums: 0, shakers: 0, desi: 0, bass: 0, synth: 0 } },
    { name: "Verse", bars: 8, chords: ["C", "G", "Am", "F"], tip: "Everyone in, not too loud",
      lvl: { drums: 0.7, shakers: 0.6, desi: 0.6, synth: 0.7 } },
    { name: "Build-up", bars: 4, chords: ["Dm", "Em", "F", "G"], tip: "Build up: knock faster and harder!",
      lvl: { drums: 0.9, marimba: 0.8 } },
    { name: "Chorus", bars: 8, chords: ["F", "G", "C", "Am"], tip: "Chorus: everybody, full power", lift: true,
      lvl: { drums: 1.1, synth: 1.15 } },
    { name: "Breakdown", bars: 4, chords: ["Am", "Em", "F", "G"], tip: "Breakdown: drums, shakers and synth rest",
      lvl: { drums: 0, shakers: 0, synth: 0, desi: 0.6 } },
    { name: "Last chorus", bars: 8, chords: ["F", "G", "C", "Am"], tip: "Last chorus: the biggest of all", lift: true,
      lvl: { drums: 1.15, synth: 1.2, shakers: 1.1 } },
    { name: "Outro", bars: 4, chords: ["F", "G", "C", "C"], tip: "Wind down: a big final chord at the end",
      lvl: { drums: 0.5, shakers: 0.4, desi: 0.4, synth: 0.6 } },
  ];

  const api = { ROLES, CHORDS, PROGRESSIONS, PENTA, SONG, Voices, mtof, noteName, inRange };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BandMusic = api;
})(typeof window !== "undefined" ? window : globalThis);
