// Desk Band core: tap detection, features and a tiny classifier.
// Runs in the phone browser and in Node (for offline tests). No dependencies.
(function (root) {
  "use strict";

  // ---------- FFT (in-place radix-2) ----------
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

  // ---------- Audio features: spectral shape of the knock ----------
  const NFFT = 4096;
  function bandEdges(nBands = 18, lo = 150, hi = 7900) {
    const e = [];
    for (let i = 0; i <= nBands; i++) e.push(lo * Math.pow(hi / lo, i / nBands));
    return e;
  }
  const EDGES = bandEdges();

  function audioFeatures(seg, sr) {
    const n = Math.min(seg.length, NFFT);
    const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
      re[i] = seg[i] * w;
    }
    fft(re, im);
    const bands = new Array(EDGES.length - 1).fill(0);
    for (let k = 1; k < NFFT / 2; k++) {
      const f = (k * sr) / NFFT;
      if (f < EDGES[0] || f >= EDGES[EDGES.length - 1]) continue;
      let b = 0;
      while (f >= EDGES[b + 1]) b++;
      bands[b] += re[k] * re[k] + im[k] * im[k];
    }
    const lb = bands.map((v) => Math.log(v + 1e-12));
    const mean = lb.reduce((a, b) => a + b, 0) / lb.length;
    return lb.map((v) => v - mean).concat([mean]);
  }

  // ---------- Motion features: which way the phone got jolted ----------
  function accelFeatures(samples, tPeak, beforeMs = 40, afterMs = 80) {
    const w = samples.filter((s) => s.t >= tPeak - beforeMs && s.t <= tPeak + afterMs);
    if (w.length < 2) return [0, 0, 0, 0, 0, 0, 0];
    const ax = ["x", "y", "z"];
    const rms = ax.map((k) => Math.sqrt(w.reduce((a, s) => a + s[k] * s[k], 0) / w.length));
    const norm = Math.hypot(rms[0], rms[1], rms[2]) || 1e-9;
    const pk = ax.map((k) => w.reduce((best, s) => (Math.abs(s[k]) > Math.abs(best) ? s[k] : best), 0));
    const pmax = Math.max(Math.abs(pk[0]), Math.abs(pk[1]), Math.abs(pk[2])) || 1e-9;
    return rms.map((v) => v / norm).concat(pk.map((v) => v / pmax), [Math.log(norm)]);
  }

  // ---------- Onset detector over a live (or recorded) audio stream ----------
  class Detector {
    constructor(sr, opts = {}) {
      this.sr = sr;
      this.ring = new Float32Array(Math.round(sr * 2));
      this.total = 0;
      this.thrMult = opts.thrMult ?? 5;
      this.absMin = opts.absMin ?? 0.0005;
      this.refractory = Math.round((opts.refractoryMs ?? 90) * sr / 1000);
      this.pre = Math.round(sr * 0.005);
      this.post = Math.round(sr * (opts.postMs ?? 45) / 1000);
      this.search = Math.round(sr * (opts.searchMs ?? 12) / 1000);
      this.frame = 64;
      this.noise = 0.001;
      this.level = 0;
      this.pending = []; // several knocks can be "being listened to" at once
      this.lastOnset = -1e12;
      this.muteUntilMs = 0;
      // one-pole high-pass at ~150 Hz to drop rumble and hum
      const rc = 1 / (2 * Math.PI * 150), dt = 1 / sr;
      this.hpA = rc / (rc + dt);
      this.px = 0; this.py = 0;
      this._fmax = 0; this._fcount = 0;
    }
    threshold() { return Math.max(this.noise * this.thrMult, this.absMin); }
    _get(i) { return this.ring[i % this.ring.length]; }
    process(chunk, nowMs, onHit) {
      const len = this.ring.length;
      for (let i = 0; i < chunk.length; i++) {
        const x = chunk[i];
        const y = this.hpA * (this.py + x - this.px);
        this.px = x; this.py = y;
        this.ring[this.total % len] = y;
        this.total++;
        const a = Math.abs(y);
        if (a > this._fmax) this._fmax = a;
        if (++this._fcount === this.frame) {
          this._onFrame(this._fmax, this.total - this.frame, nowMs);
          this._fmax = 0; this._fcount = 0;
        }
      }
      while (this.pending.length && this.total >= this.pending[0].start + this.search + this.post + 1) {
        const p = this.pending.shift();
        let peakIdx = p.start, peakAmp = 0;
        for (let i = p.start; i < p.start + this.search; i++) {
          const a = Math.abs(this._get(i));
          if (a > peakAmp) { peakAmp = a; peakIdx = i; }
        }
        const seg = new Float32Array(this.pre + this.post);
        for (let i = 0; i < seg.length; i++) seg[i] = this._get(peakIdx - this.pre + i);
        const wallMs = nowMs - ((this.total - peakIdx) / this.sr) * 1000;
        onHit({ peakIdx, peakAmp, seg, wallMs, thr: p.thr, delayMs: nowMs - wallMs });
      }
    }
    _onFrame(m, startIdx, nowMs) {
      this.level = m;
      const thr = this.threshold();
      const muted = nowMs < this.muteUntilMs;
      const rising = m > 1.8 * (this._prevM || 0); // a new knock jumps up; a ringing tail doesn't
      this._prevM = m;
      if (!muted && rising && m > thr && startIdx - this.lastOnset > this.refractory) {
        this.pending.push({ start: startIdx, thr });
        this.lastOnset = startIdx;
      } else if (m < thr) {
        this.noise = this.noise * 0.995 + m * 0.005; // learn the room's noise floor
      }
    }
  }

  // ---------- Multinomial logistic regression (small, plain) ----------
  class Model {
    fit(X, Y, { l2 = 0.05, iters = 600, lr = 0.2 } = {}) {
      this.classes = [...new Set(Y)].sort((a, b) => a - b);
      const K = this.classes.length, D = X[0].length, N = X.length;
      this.mu = new Array(D).fill(0); this.sd = new Array(D).fill(0);
      for (const x of X) x.forEach((v, j) => (this.mu[j] += v / N));
      for (const x of X) x.forEach((v, j) => (this.sd[j] += (v - this.mu[j]) ** 2 / N));
      this.sd = this.sd.map((v) => Math.sqrt(v) + 1e-6);
      const Z = X.map((x) => this._z(x));
      const yi = Y.map((y) => this.classes.indexOf(y));
      this.W = Array.from({ length: D }, () => new Array(K).fill(0));
      this.b = new Array(K).fill(0);
      for (let it = 0; it < iters; it++) {
        const gW = Array.from({ length: D }, () => new Array(K).fill(0));
        const gb = new Array(K).fill(0);
        for (let n = 0; n < N; n++) {
          const p = this._softmax(Z[n]);
          for (let k = 0; k < K; k++) {
            const g = (p[k] - (yi[n] === k ? 1 : 0)) / N;
            gb[k] += g;
            for (let d = 0; d < D; d++) gW[d][k] += Z[n][d] * g;
          }
        }
        for (let d = 0; d < D; d++)
          for (let k = 0; k < K; k++) this.W[d][k] -= lr * (gW[d][k] + (l2 * this.W[d][k]) / N);
        for (let k = 0; k < K; k++) this.b[k] -= lr * gb[k];
      }
      return this;
    }
    _z(x) { return x.map((v, j) => (v - this.mu[j]) / this.sd[j]); }
    _softmax(z) {
      const s = this.b.map((b, k) => b + z.reduce((a, v, d) => a + v * this.W[d][k], 0));
      const m = Math.max(...s);
      const e = s.map((v) => Math.exp(v - m));
      const t = e.reduce((a, b) => a + b, 0);
      return e.map((v) => v / t);
    }
    predict(x) {
      const p = this._softmax(this._z(x));
      let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
      return { zone: this.classes[best], prob: p[best], probs: p };
    }
  }

  const api = { fft, audioFeatures, accelFeatures, Detector, Model };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeskCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
