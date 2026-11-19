// Paper Pad features: what a short window of paper sound looks like.
// Runs in the phone browser (as PaperFeat) and in Node (offline analysis, tests). Uses core.js for the FFT and the
// Desk Band band-energy and motion features. No dependencies.
(function (root) {
  "use strict";
  const C = typeof module !== "undefined" && module.exports ? require("./core.js") : root.PaperCore;

  const WIN_MS = 150;    // texture window (scratch, rub, quiet)
  const HOP_MS = 50;     // texture windows are classified this often
  const HIST_MS = 500;   // how much of the past the "rhythm" features look at
  const PRE_MS = 5;      // hit windows start this long before the onset peak

  // Average power spectrum over 1024-sample Hann frames, hop 512.
  const NF = 1024;
  const HANN = Float64Array.from({ length: NF }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NF - 1)));
  function spectrum(seg) {
    const pow = new Float64Array(NF / 2);
    let frames = 0;
    for (let s = 0; s + NF <= Math.max(seg.length, NF); s += NF / 2) {
      const re = new Float64Array(NF), im = new Float64Array(NF);
      for (let i = 0; i < NF; i++) re[i] = (seg[s + i] || 0) * HANN[i];
      C.fft(re, im);
      for (let k = 0; k < NF / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
      if (s + NF >= seg.length) break;
    }
    for (let k = 0; k < NF / 2; k++) pow[k] /= frames;
    return pow;
  }

  // Spectral shape between 150 Hz and 7.9 kHz: where the energy sits and how noise-like it is.
  function shape(pow, sr) {
    const lo = Math.ceil((150 * NF) / sr), hi = Math.floor((7900 * NF) / sr);
    let tot = 0, wsum = 0, logsum = 0, hiE = 0;
    for (let k = lo; k <= hi; k++) {
      const f = (k * sr) / NF, p = pow[k] + 1e-14;
      tot += p; wsum += p * f; logsum += Math.log(p);
      if (f >= 2000) hiE += p;
    }
    const n = hi - lo + 1, centroid = wsum / tot;
    const flatness = Math.exp(logsum / n) / (tot / n); // 1 = white noise, near 0 = tonal
    let acc = 0, roll = 7900;
    for (let k = lo; k <= hi; k++) { acc += pow[k] + 1e-14; if (acc >= 0.85 * tot) { roll = (k * sr) / NF; break; } }
    return [Math.log(centroid), flatness, Math.log(roll), Math.log((hiE + 1e-14) / (tot - hiE + 1e-14))];
  }

  function zcr(seg) {
    let z = 0;
    for (let i = 1; i < seg.length; i++) if ((seg[i] >= 0) !== (seg[i - 1] >= 0)) z++;
    return z / Math.max(1, seg.length - 1);
  }

  // Loudness outline in 5 ms frames (RMS).
  function envelope(seg, sr) {
    const fl = Math.max(1, Math.round(sr * 0.005)), out = [];
    for (let s = 0; s + fl <= seg.length; s += fl) {
      let e = 0;
      for (let i = s; i < s + fl; i++) e += seg[i] * seg[i];
      out.push(Math.sqrt(e / fl));
    }
    return out.length ? out : [0];
  }
  function envStats(env) {
    const n = env.length, mean = env.reduce((a, b) => a + b, 0) / n + 1e-9;
    const sd = Math.sqrt(env.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
    const max = Math.max(...env);
    return { logMean: Math.log(mean), cv: sd / mean, crest: max / mean };
  }
  // How rhythmic the loudness is: best autocorrelation for periods of 40–400 ms (rubbing goes back and forth).
  function modulation(env) {
    const n = env.length, mean = env.reduce((a, b) => a + b, 0) / n;
    const x = env.map((v) => v - mean), e0 = x.reduce((a, v) => a + v * v, 0) + 1e-18;
    let best = 0;
    for (let lag = 8; lag <= Math.min(80, n - 4); lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      best = Math.max(best, s / e0);
    }
    return best;
  }

  // The "texture" features: spectral shape, zero crossings, loudness shape now and over the last half second.
  function texture(win, hist, sr) {
    const pow = spectrum(win), sh = shape(pow, sr);
    const ew = envStats(envelope(win, sr));
    const eh = hist && hist.length >= sr * 0.05 ? envelope(hist, sr) : envelope(win, sr);
    const sh2 = envStats(eh);
    return sh.concat([zcr(win), ew.cv, Math.log(ew.crest), sh2.logMean, sh2.cv, modulation(eh), ew.logMean - sh2.logMean]);
  }

  // One example = a window of (high-passed) audio. Feature groups are kept separate so the analysis can compare them.
  // motion: [{t (ms on the audio clock), x, y, z}], tMs: window start on the same clock.
  function windowFeatures(win, hist, sr, motion, tMs) {
    const mic = C.audioFeatures(win, sr);                                 // 19: Desk Band band energies + level
    const accel = C.accelFeatures(motion || [], tMs + PRE_MS, 40, 80);    // 7: Desk Band jolt direction + size
    const tex = texture(win, hist, sr);                                   // 11: Paper Pad texture features
    return { mic, accel, tex };
  }

  // The same 150 Hz one-pole high-pass the onset detector uses, over a whole recording.
  function highpass(x, sr) {
    const rc = 1 / (2 * Math.PI * 150), dt = 1 / sr, a = rc / (rc + dt), y = new Float32Array(x.length);
    let px = 0, py = 0;
    for (let i = 0; i < x.length; i++) { py = a * (py + x[i] - px); px = x[i]; y[i] = py; }
    return y;
  }

  const api = { WIN_MS, HOP_MS, HIST_MS, PRE_MS, spectrum, shape, zcr, envelope, envStats, modulation, texture, windowFeatures, highpass };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PaperFeat = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
