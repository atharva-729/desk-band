// Hand Theremin sonar maths. Shared by the phone page, the stage page and the Node tests (tests/test_sonar.js).
// No dependencies. In a browser it defines window.Sonar; in Node, require() returns the same object.
//
// The idea: the speaker plays one short chirp (18 -> 21 kHz) every P samples, forever. The mic hears the
// chirp straight from the speaker (the "direct path", by far the loudest) and, a little later, its echoes.
// Every P samples we cross-correlate what the mic heard with the chirp. That gives an echo profile:
// echo strength for every delay. Delay after the direct path, in samples, x 3.57 mm (at 48 kHz) = distance.
// We measure the profile once with no hand (the "background": table, body, direct path) and then show only
// what changed. A hand is the thing that changes.
(function (root) {
  "use strict";
  const SPEED = 343; // speed of sound, m/s, at about 20 °C
  const HEARD_DB = 25; // the direct path must stand this far above the typical lag to count as "chirp heard"

  const DEFAULTS = {
    period: 1024,     // samples between chirps (21 ms at 48 kHz, so about 47 echo profiles a second)
    f0: 18000,        // chirp start, Hz
    f1: 21000,        // chirp end, Hz
    chirpMs: 10,      // chirp length
    fadeMs: 2.5,      // fade in and fade out on every chirp, so it doesn't click
    maxCm: 60,        // how far up the echo map goes
    minCm: 5,         // closer than this the direct path swamps everything, so the hand search starts here
    learnFrames: 48,  // about 1 s of "no hand" to learn the background
    presentRatio: 6,  // hand present when the strongest change is this many times the typical change
  };

  // In-place radix-2 FFT. n must be a power of two.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Linear chirp f0 -> f1 with a raised-cosine fade at both ends (a Tukey window).
  function makeChirp(fs, f0, f1, ms, fadeMs) {
    const n = Math.round(fs * ms / 1000), fade = Math.max(1, Math.round(fs * fadeMs / 1000));
    const dur = n / fs, k = (f1 - f0) / dur, x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      let w = 1;
      if (i < fade) w = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
      else if (i >= n - fade) w = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / fade);
      x[i] = w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return x;
  }

  const db = (v) => 20 * Math.log10(v + 1e-12);
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  }

  function Sonar(fs, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const P = o.period;
    this.o = o; this.fs = fs; this.P = P;
    this.chirp = makeChirp(fs, o.f0, o.f1, o.chirpMs, o.fadeMs);
    if (this.chirp.length >= P) throw new Error("chirp longer than the period");

    // Matched filter: conj(spectrum of the chirp), only inside the chirp's band, positive frequencies only (x2).
    // Keeping only positive frequencies makes the output complex, so its size is the echo envelope and its
    // angle is the echo phase (which background subtraction uses).
    const re = new Float64Array(P), im = new Float64Array(P);
    re.set(this.chirp);
    fft(re, im, false);
    let energy = 0;
    for (const v of this.chirp) energy += v * v;
    this.Hr = new Float64Array(P); this.Hi = new Float64Array(P);
    const kLo = Math.max(1, Math.floor((o.f0 - 500) / fs * P)), kHi = Math.min(P / 2 - 1, Math.ceil((o.f1 + 500) / fs * P));
    for (let k = kLo; k <= kHi; k++) { this.Hr[k] = 2 * re[k] / energy; this.Hi[k] = -2 * im[k] / energy; }

    this.cmPerRow = SPEED / fs / 2 * 100;  // one sample of extra delay = this much hand distance
    this.rows = Math.ceil(o.maxCm / this.cmPerRow) + 1;
    this.minRow = Math.round(o.minCm / this.cmPerRow);

    this.buf = new Float32Array(P); this.fill = 0;
    this.pr = new Float64Array(P); this.pi = new Float64Array(P);
    this.bgr = new Float64Array(P); this.bgi = new Float64Array(P);
    this.sumr = new Float64Array(P); this.sumi = new Float64Array(P);
    this.direct = -1;           // where the direct path sits in the profile, locked while learning
    this.learnLeft = o.learnFrames;
    this.relearns = 0; this.frames = 0;
    this.gaps = 0; this.dirty = 0;   // audio gaps patched by skip(), and frames still to ignore after one
    this.noiseDb = null; this.present = false; this.peakAbs = 0;
    this.change = new Float32Array(this.rows);
    this.colChange = new Uint8Array(this.rows);  // what the echo map draws: change vs the empty table
    this.colRaw = new Uint8Array(this.rows);     // everything the mic hears, before subtraction
  }

  Sonar.prototype.relearn = function () {
    this.learnLeft = this.o.learnFrames;
    this.sumr.fill(0); this.sumi.fill(0);
    this.present = false; this.relearns++;
  };

  // The phone dropped (or repeated) n samples. Everything after would sit at the wrong place in the period and
  // no longer line up with the background, so pad with silence to get back in step. The frames that contain the
  // gap are garbage: ignore them. (No re-learning needed, so a hand in view doesn't get baked into the table.)
  Sonar.prototype.skip = function (n) {
    const k = ((Math.round(n) % this.P) + this.P) % this.P;
    if (!k) return;
    this.gaps++;
    this.dirty = 2;
    this.push(new Float32Array(k));
  };

  // Feed mic samples (any block size). Calls onFrame(result) once per chirp period.
  Sonar.prototype.push = function (x, onFrame) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i], a = v < 0 ? -v : v;
      if (a > this.peakAbs) this.peakAbs = a;
      this.buf[this.fill++] = v;
      if (this.fill === this.P) {
        this.fill = 0;
        const r = this.frame();
        if (onFrame) onFrame(r);
      }
    }
  };

  Sonar.prototype.frame = function () {
    const P = this.P, re = this.pr, im = this.pi, o = this.o, rows = this.rows;
    for (let i = 0; i < P; i++) { re[i] = this.buf[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < P; k++) {
      const a = re[k], b = im[k], c = this.Hr[k], d = this.Hi[k];
      re[k] = a * c - b * d; im[k] = a * d + b * c;
    }
    fft(re, im, true);
    this.frames++;
    const micPeak = this.peakAbs; this.peakAbs = 0;

    // The strongest echo is the direct path. "Chirp heard" = how far it stands above the typical lag.
    let best = 0, bestM = -1;
    const mags = new Float64Array(P);
    for (let i = 0; i < P; i++) {
      const m = Math.hypot(re[i], im[i]);
      mags[i] = m;
      if (m > bestM) { bestM = m; best = i; }
    }
    const floor = median(mags);
    // Once learnt, judge "chirp heard" at the direct path itself: a hand or book right over the speaker can echo
    // louder than the speaker's own sound, and the strongest lag is then the hand, not the direct path.
    const D = this.direct, dHere = this.learnLeft > 0 || D < 0 ? bestM : mags[D];
    const res = { learning: this.learnLeft > 0, directDb: db(dHere), snrDb: db(dHere) - db(floor),
      micPeak, clip: micPeak >= 0.99, handCm: null, present: this.present, ratio: 0, relearns: this.relearns,
      best, direct: D, gaps: this.gaps, glitch: false, peakCm: null };

    if (this.dirty > 0) {               // a frame with an audio gap in it: keep the last picture, learn nothing
      this.dirty--;
      res.glitch = true;
      res.handCm = this.lastHand;
      return res;
    }

    if (this.learnLeft > 0) {
      for (let i = 0; i < P; i++) { this.sumr[i] += re[i]; this.sumi[i] += im[i]; }
      for (let i = 0; i < rows; i++) {
        this.colRaw[i] = clamp255((db(mags[(best + i) % P] / (bestM || 1e-12)) + 60) / 60 * 255);
        this.colChange[i] = 0;
      }
      res.present = false;
      if (--this.learnLeft === 0) {
        let dm = -1;
        for (let i = 0; i < P; i++) {
          this.bgr[i] = this.sumr[i] / o.learnFrames; this.bgi[i] = this.sumi[i] / o.learnFrames;
          const m = Math.hypot(this.bgr[i], this.bgi[i]);
          if (m > dm) { dm = m; this.direct = i; }
        }
        this.noiseDb = null;
      }
      return res;
    }

    // No automatic re-learning here. (Phase 0 re-learnt whenever the strongest echo moved off the direct path,
    // but a hand or book over the speaker does exactly that, so it re-learnt with the hand in view.)
    const dm = Math.hypot(this.bgr[D], this.bgi[D]) || 1e-12;
    let peak = 0, peakI = -1;
    for (let i = 0; i < rows; i++) {
      const j = (D + i) % P;
      const cm = Math.hypot(re[j] - this.bgr[j], im[j] - this.bgi[j]);
      this.change[i] = cm;
      this.colRaw[i] = clamp255((db(mags[j] / dm) + 60) / 60 * 255);
      if (i >= this.minRow && cm > peak) { peak = cm; peakI = i; }
    }
    const noise = median(this.change.subarray(this.minRow)) || 1e-12;
    const ratio = peak / noise;
    this.present = this.present ? ratio > o.presentRatio * 0.6 : ratio > o.presentRatio;  // hysteresis

    // Peak position between samples: fit a parabola through the peak and its two neighbours.
    let pos = peakI;
    if (peakI > this.minRow && peakI < rows - 1) {
      const a = this.change[peakI - 1], b = this.change[peakI], c = this.change[peakI + 1], den = a - 2 * b + c;
      if (den < 0) pos += 0.5 * (a - c) / den;
    }

    // Brightness: change in dB above its own (smoothed) noise floor; 0..30 dB -> 0..255.
    const nDb = db(noise / dm);
    this.noiseDb = this.noiseDb == null ? nDb : this.noiseDb * 0.95 + nDb * 0.05;
    for (let i = 0; i < rows; i++) this.colChange[i] = clamp255((db(this.change[i] / dm) - this.noiseDb - 3) / 30 * 255);

    res.ratio = ratio;
    res.present = this.present;
    res.peakCm = pos * this.cmPerRow;
    res.handCm = this.present ? res.peakCm : null;
    this.lastHand = res.handCm;
    return res;
  };

  // A pretend mic, for tests and for ?sim on the phone page: the direct path, a body echo at 45 cm,
  // optional hand echo, a little noise. Echo delays are whole samples. start = where the first chirp lands.
  function Simulator(sonar, { start = 137, direct = 0.3, body = 0.02, hand = 0.004, noise = 0.001, seed = 1 } = {}) {
    const P = sonar.P, cp = new Float32Array(P);
    cp.set(sonar.chirp);
    let n = 0, s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const bodyLag = Math.round(45 / sonar.cmPerRow);
    return {
      // handCm null = no hand. shift = drop or repeat samples (as a phone glitch would).
      next(len, handCm, shift = 0) {
        n += shift;
        const out = new Float32Array(len), hl = handCm == null ? -1 : Math.round(handCm / sonar.cmPerRow);
        const at = (lag) => cp[(((n - start - lag) % P) + P) % P];
        for (let i = 0; i < len; i++, n++) {
          let v = direct * at(0) + body * at(bodyLag) + noise * gauss();
          if (hl >= 0) v += hand * at(hl);
          out[i] = v;
        }
        return out;
      },
    };
  }

  // ---- drawing (browser only) ------------------------------------------------------------------------
  const STOPS = [[0, 11, 12, 16], [0.35, 29, 43, 107], [0.65, 90, 168, 255], [0.85, 255, 224, 122], [1, 255, 255, 255]];
  const LUT = (() => {
    const t = new Uint8Array(256 * 3);
    for (let v = 0; v < 256; v++) {
      const x = v / 255;
      let k = 1;
      while (k < STOPS.length - 1 && STOPS[k][0] < x) k++;
      const [x0, r0, g0, b0] = STOPS[k - 1], [x1, r1, g1, b1] = STOPS[k], f = (x - x0) / (x1 - x0);
      t[v * 3] = r0 + (r1 - r0) * f; t[v * 3 + 1] = g0 + (g1 - g0) * f; t[v * 3 + 2] = b0 + (b1 - b0) * f;
    }
    return t;
  })();

  // Scrolling echo map: time left -> right (newest on the right), distance bottom (0 cm) -> top.
  function EchoMap(canvas, rows, cmPerRow, cols) {
    this.cv = canvas; this.g = canvas.getContext("2d");
    this.rows = rows; this.cmPerRow = cmPerRow; this.cols = cols || 380;
    this.off = document.createElement("canvas");
    this.off.width = this.cols; this.off.height = rows;
    this.og = this.off.getContext("2d");
    this.img = this.og.createImageData(this.cols, rows);
    this.ring = [];
  }
  // entry = { change: Uint8Array, raw: Uint8Array, hand: cm | null }
  EchoMap.prototype.push = function (entry) {
    this.ring.push(entry);
    if (this.ring.length > this.cols) this.ring.shift();
  };
  // mode "change" (background removed, hand estimate drawn as a green dash) or "raw" (everything heard)
  EchoMap.prototype.draw = function (mode) {
    const showHand = mode === "change";
    const cv = this.cv, g = this.g, d = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
    g.setTransform(d, 0, 0, d, 0, 0);
    const rows = this.rows, cols = this.cols, px = this.img.data, skip = cols - this.ring.length;
    px.fill(0);
    for (let c = 0; c < this.ring.length; c++) {
      const col = this.ring[c][mode] || this.ring[c].change;
      for (let r = 0; r < rows; r++) {
        const v = col[r] || 0, p = ((rows - 1 - r) * cols + c + skip) * 4;
        px[p] = LUT[v * 3]; px[p + 1] = LUT[v * 3 + 1]; px[p + 2] = LUT[v * 3 + 2]; px[p + 3] = 255;
      }
    }
    this.og.putImageData(this.img, 0, 0);
    const L = 38; // room for the cm labels
    g.fillStyle = "#0b0c10"; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.off, L, 0, W - L, H);
    const maxCm = (rows - 1) * this.cmPerRow, y = (cm) => H - cm / maxCm * H;
    g.font = "11px -apple-system, system-ui, sans-serif"; g.textBaseline = "middle";
    for (let cm = 10; cm <= maxCm - 4; cm += 10) {
      g.strokeStyle = "rgba(255,255,255,0.14)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, y(cm)); g.lineTo(W, y(cm)); g.stroke();
      g.fillStyle = "#8b90a3"; g.fillText(cm + " cm", 2, y(cm));
    }
    g.fillStyle = "#8b90a3"; g.fillText("phone", 2, H - 7);
    if (showHand) {
      const xs = (W - L) / cols;
      g.fillStyle = "#3dd6a3";
      for (let c = 0; c < this.ring.length; c++) {
        const h = this.ring[c].hand;
        if (h != null) g.fillRect(L + (c + skip) * xs, y(h) - 1, Math.max(1.5, xs), 2);
      }
    }
  };

  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };

  const api = { Sonar, Simulator, EchoMap, makeChirp, fft, toB64, fromB64, DEFAULTS, SPEED, HEARD_DB, LUT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Sonar = api;
})(typeof window !== "undefined" ? window : globalThis);
