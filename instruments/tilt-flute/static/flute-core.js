// Tilt Flute core: tilt from gravity, note steps with hysteresis, and a breath detector.
// Runs in the phone browser and in Node (tests and analysis). No dependencies.
(function (root) {
  "use strict";
  const DEG = 180 / Math.PI;

  // ---------- FFT (in-place radix-2, copied from Desk Band's core.js) ----------
  function fft(re, im) {
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
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // ---------- Tilt from gravity ----------
  // The phone's own tilt angle (beta) flips by 180° when the phone is rolled far onto its side, which is how a flute
  // is held. Gravity (accelerationIncludingGravity) has no such flip. Calibration records gravity at the lowest and
  // highest note; the note position is how far the current gravity has turned from "lowest" towards "highest".
  // Whatever motion the player used between the two becomes the note axis, so any way of holding the phone works.
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

  function calibrate(gLow, gHigh) {
    const a = unit(gLow), b = unit(gHigh);
    const span = Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * DEG;
    const n = unit(cross(a, b));          // axis the phone turned about
    const e2 = unit(cross(n, a));         // in the turning plane, pointing from low towards high
    return { low: a, high: b, n, e1: a, e2, span };
  }

  // -> { pos: degrees from the lowest note towards the highest (0..span inside the range),
  //      off: degrees out of that plane (the "other" rotation, kept for vibrato) }
  function tiltAngles(g, cal) {
    const u = unit(g);
    const off = Math.asin(Math.max(-1, Math.min(1, dot(u, cal.n)))) * DEG;
    const pos = Math.atan2(dot(u, cal.e2), dot(u, cal.e1)) * DEG;
    return { pos, off };
  }

  // One-pole low-pass for a gravity vector (hand jolts are in accelerationIncludingGravity too)
  class VecSmoother {
    constructor(tauMs) { this.tau = tauMs; this.v = null; this.t = null; }
    push(v, tMs) {
      if (!this.v || this.tau <= 0) { this.v = v.slice(); this.t = tMs; return this.v; }
      const k = 1 - Math.exp(-Math.max(0, tMs - this.t) / this.tau);
      for (let i = 0; i < 3; i++) this.v[i] += k * (v[i] - this.v[i]);
      this.t = tMs;
      return this.v;
    }
  }

  // ---------- Note steps with hysteresis ----------
  // The range 0..span is cut into `steps` equal zones. The note only changes once the angle is `hyst` degrees past
  // the edge of the current zone, so a hand resting on a boundary doesn't flicker between two notes.
  class Stepper {
    constructor(steps, span, hyst = 2.5) { this.steps = steps; this.span = span; this.hyst = hyst; this.cur = null; }
    raw(pos) { return Math.max(0, Math.min(this.steps - 1, Math.floor(pos / (this.span / this.steps)))); }
    update(pos) {
      const r = this.raw(pos);
      if (this.cur === null) return (this.cur = r);
      const w = this.span / this.steps, lo = this.cur * w, hi = lo + w;
      if (pos < lo - this.hyst || pos > hi + this.hyst) this.cur = r;
      return this.cur;
    }
  }

  // ---------- Microphone features ----------
  // Frames of 1024 samples every 512 (about 21 ms long, every 11 ms at 48 kHz). Per frame:
  //   rms     whole-frame level, dBFS
  //   band    level in 50-1000 Hz, where blowing on a mic is strongest, dB
  //   flat    spectral flatness over 100-4000 Hz: near 0 for tones (voice, flute), higher for hiss (breath)
  //   period  how strongly the frame repeats itself at a voice-like pitch (80-500 Hz): high for voice and tones
  const N = 1024, HOP = 512;
  class AudioFeatures {
    constructor(sampleRate) {
      this.sr = sampleRate;
      this.ring = new Float32Array(N); this.w = 0; this.fill = 0; this.since = 0; this.buf = new Float32Array(N);
      this.win = new Float32Array(N); let w2 = 0;
      for (let i = 0; i < N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); w2 += this.win[i] ** 2; }
      this.w2 = w2;
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      const bin = (hz) => Math.max(1, Math.round((hz * N) / sampleRate));
      this.band = [bin(50), bin(1000)]; this.flatBand = [bin(100), bin(4000)];
      this.hopMs = (HOP / sampleRate) * 1000;
    }
    // block: Float32Array of new samples; tMs: time of the block's last sample; onFrame(features)
    push(block, tMs, onFrame) {
      for (let i = 0; i < block.length; i++) {
        this.ring[this.w] = block[i]; this.w = (this.w + 1) % N;
        if (this.fill < N) this.fill++;
        if (this.fill === N && ++this.since >= HOP) {
          this.since = 0;
          this.buf.set(this.ring.subarray(this.w), 0); this.buf.set(this.ring.subarray(0, this.w), N - this.w); // oldest first
          const f = this.frame();
          f.t = tMs - ((block.length - 1 - i) / this.sr) * 1000;
          onFrame(f);
        }
      }
    }
    frame() {
      const x = this.buf, re = this.re, im = this.im;
      let ms = 0;
      for (let i = 0; i < N; i++) { ms += x[i] * x[i]; re[i] = x[i] * this.win[i]; im[i] = 0; }
      fft(re, im);
      const p = (k) => re[k] * re[k] + im[k] * im[k];
      let bandP = 0;
      for (let k = this.band[0]; k <= this.band[1]; k++) bandP += p(k);
      let lsum = 0, sum = 0, cnt = 0;
      for (let k = this.flatBand[0]; k <= this.flatBand[1]; k++) { const v = p(k) + 1e-20; lsum += Math.log(v); sum += v; cnt++; }
      return {
        rms: 10 * Math.log10(ms / N + 1e-12),
        band: 10 * Math.log10((2 * bandP) / (N * this.w2) + 1e-12),
        flat: Math.exp(lsum / cnt) / (sum / cnt),
        period: periodicity(x, this.sr),
      };
    }
  }

  // Highest normalised autocorrelation for pitches 80-500 Hz, on a 2x-decimated copy to keep it cheap
  function periodicity(x, sr) {
    const n = x.length >> 1, y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = 0.5 * (x[2 * i] + x[2 * i + 1]);
    const r = sr / 2, lo = Math.floor(r / 500), hi = Math.min(n - 64, Math.ceil(r / 80));
    let best = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i + lag < n; i++) { const a = y[i], b = y[i + lag]; xy += a * b; xx += a * a; yy += b * b; }
      const c = xy / Math.sqrt(xx * yy + 1e-20);
      if (c > best) best = c;
    }
    return best;
  }

  // ---------- Breath detector ----------
  // Breath = the 50-1000 Hz band is well above the room's noise floor AND the sound is hiss-like (flat, not periodic).
  // Output level 0..1 with a fast attack and a gentle release.
  const BREATH_DEFAULTS = { margin: 15, range: 30, flatMin: 0.1, periodMax: 0.6, attackMs: 10, releaseMs: 80 };
  class BreathDetector {
    constructor(opts = {}) {
      this.o = { ...BREATH_DEFAULTS, ...opts };
      this.floor = null; this.level = 0; this.on = false; this.t = null;
    }
    // f: features from AudioFeatures -> { on, level, floor, loud, hiss }
    push(f) {
      const o = this.o;
      if (this.floor === null) this.floor = f.band;
      const dt = this.t === null ? 0 : Math.max(0, f.t - this.t); this.t = f.t;
      const loud = f.band > this.floor + o.margin;
      const hiss = f.flat >= o.flatMin && f.period <= o.periodMax;
      this.on = loud && hiss;
      // noise floor: drops straight to quieter frames, creeps up slowly (about 5 s) so it follows a noisier room
      if (f.band < this.floor) this.floor = f.band;
      else if (!loud) this.floor += (f.band - this.floor) * (1 - Math.exp(-dt / 5000));
      const target = this.on ? Math.max(0.05, Math.min(1, (f.band - this.floor - o.margin) / o.range)) : 0;
      const tau = target > this.level ? o.attackMs : o.releaseMs;
      this.level += (target - this.level) * (dt ? 1 - Math.exp(-dt / tau) : 1);
      return { on: this.on, level: this.level, floor: this.floor, loud, hiss };
    }
  }

  const api = { fft, calibrate, tiltAngles, VecSmoother, Stepper, AudioFeatures, periodicity, BreathDetector,
    BREATH_DEFAULTS, FRAME: N, HOP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FluteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
