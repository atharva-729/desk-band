// Paper Pad live engine: the whole "which touch is this" pipeline, from raw mic samples to events.
// The same code runs on the phone (live) and in Node (tools/simulate.js replays recordings through it), so the
// offline numbers are for exactly what the phone does. Also holds trainModels(), used by the phone's training worker
// and by the simulator. No dependencies.
//
// Features: Desk Band band energies + the Paper Pad texture features. The motion features are left out on purpose: the
// offline replay scores the same without them, and with them the models break whenever motion readings don't arrive
// (motion permission refused, or a browser without a motion sensor): 'keep still' then plays scratch a third of the time.
//
//  hits (tap, flick):      the onset detector finds a sharp sound -> classify a short window from just before its peak
//                          (75 ms by default) with the hit model -> tap / flick fire at once; anything else is ignored.
//                          A quieter sound within 200 ms of a hit is the hit's echo and is ignored too.
//  textures (scratch, rub): every 50 ms, classify the last 150 ms with the texture model. A texture switches on after
//                          one frame the model is at least 80% sure of, or 2 frames in a row that agree, and only when
//                          louder than the "keep still" recordings (the loudness gate); it switches off
//                          after 2 frames that don't (so short gaps between strokes don't cut it). Its level (rub) and
//                          speed (scratch) come from loudness and brightness.
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const C = node ? require("./core.js") : root.PaperCore;
  const F = node ? require("./paper.js") : root.PaperFeat;
  const CLASSES = F.CLASSES;
  const FEAT_VERSION = 2; // bump when the features change, so cached feature files are rebuilt
  const DEFAULTS = { groups: ["mic", "tex"], hitMs: 75, texMs: 150, hopMs: 50, enter: 2, enterConf: 0.8, exit: 2, around: "quiet", gate: 0.3, holdMs: 0, echoMs: 200, echoRatio: 0.5, fixWeight: 2, iters: 500 };
  const vec = (f, groups = DEFAULTS.groups) => groups.flatMap((g) => f[g]);
  const loud = (f) => f.tex[7] + f.tex[10]; // log RMS of the window
  const bright = (f) => f.tex[0];          // log spectral centroid
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const norm = (v, r) => (r && r[1] > r[0] ? clamp01((v - r[0]) / (r[1] - r[0])) : 0.5);
  function pctl(a, q) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  }

  // ---------- training ----------
  // One recording -> labelled examples for both models (hit windows and texture windows).
  function sessionExamples(meta, audio, opts = {}) {
    const o = { ...DEFAULTS, ...opts }, hp = F.highpass(audio, meta.sr), ons = F.onsets(audio, meta.sr);
    return { hit: F.examples(meta, audio, o.hitMs, { hp, ons, around: o.around }).ex, tex: F.examples(meta, audio, o.texMs, { hp, ons, around: o.around }).ex };
  }
  // Small, rounded form for caching on the laptop (features only, never audio).
  const r4 = (a) => a.map((v) => +v.toFixed(4));
  const compact = (e) => ({ l: e.label, s: e.src, a: e.amp == null ? undefined : +e.amp.toFixed(2), m: r4(e.f.mic), c: r4(e.f.accel), t: r4(e.f.tex) });
  const expand = (c) => ({ label: c.l, src: c.s, amp: c.a, f: { mic: c.m, accel: c.c, tex: c.t } });

  // hit / tex: lists of examples {label, f, src, amp?, fix?}. Classes are balanced (each class counts the same in total);
  // corrections made while playing ("fix") count double.
  function trainModels({ hit, tex }, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const fit = (exs) => {
      const count = {};
      for (const e of exs) count[e.label] = (count[e.label] || 0) + 1;
      return new C.Model().fit(exs.map((e) => vec(e.f, o.groups)), exs.map((e) => e.label),
        { iters: o.iters, weights: exs.map((e) => (e.fix ? o.fixWeight : 1) / count[e.label]) });
    };
    const ranges = {};
    for (const k of ["scratch", "rub"]) {
      const w = tex.filter((e) => e.label === k && !e.fix), L = w.map((e) => loud(e.f)), B = w.map((e) => bright(e.f));
      ranges[k] = { loud: [pctl(L, 0.1), pctl(L, 0.9)], bright: [pctl(B, 0.1), pctl(B, 0.9)] };
    }
    // Loudness gate: scratch / rub can only switch on above the loudest 5% of the prompted "keep still" windows (+ gate).
    const still = tex.filter((e) => e.label === "quiet" && e.src === "slide").map((e) => loud(e.f));
    ranges.quiet = { loud95: still.length ? pctl(still, 0.95) : -Infinity };
    for (const k of ["tap", "flick"]) {
      const A = hit.filter((e) => e.label === k && e.src === "hit" && e.amp).map((e) => Math.log(e.amp));
      ranges[k] = { amp: [pctl(A, 0.1), pctl(A, 0.9)] };
    }
    const counts = (exs) => Object.fromEntries(CLASSES.map((c) => [c, exs.filter((e) => e.label === c).length]));
    return { hit: fit(hit), tex: fit(tex), ranges, groups: o.groups, hitMs: o.hitMs, texMs: o.texMs, counts: { hit: counts(hit), tex: counts(tex) } };
  }
  const packModel = (m) => ({ classes: m.classes, mu: m.mu, sd: m.sd, W: m.W, b: m.b });
  const packModels = (M) => ({ ...M, hit: packModel(M.hit), tex: packModel(M.tex) });
  const unpackModels = (P) => ({ ...P, hit: Object.assign(new C.Model(), P.hit), tex: Object.assign(new C.Model(), P.tex) });

  // ---------- live ----------
  class Engine {
    // models: from trainModels() (or unpackModels()). Callbacks: onHit(ev), onFrame(ev), onState(ev), onSkip(ev), onOnset(o).
    constructor(sr, models, opts = {}) {
      const o = (this.o = { ...DEFAULTS, ...opts, hitMs: models.hitMs || DEFAULTS.hitMs, texMs: models.texMs || DEFAULTS.texMs });
      this.sr = sr; this.m = models;
      this.det = new C.Detector(sr, { thrMult: 5, postMs: 45 });
      const s = (ms) => Math.round((ms * sr) / 1000);
      this.Wh = s(o.hitMs); this.Wt = s(o.texMs); this.H = s(F.HIST_MS); this.pre = s(F.PRE_MS); this.hop = s(o.hopMs);
      this.echo = s(o.echoMs);
      this.nextFrame = this.Wt + this.H;
      this.pending = []; this.motion = []; this.recent = [];
      this.state = null; this.lastHit = null; this.nowMs = 0;
      this.onHit = this.onFrame = this.onState = this.onSkip = this.onOnset = null;
    }
    get total() { return this.det.total; }
    ms(idx) { return (idx / this.sr) * 1000; }
    // A motion reading, stamped with the audio sample it arrived at.
    addMotion(idx, x, y, z) {
      const t = this.ms(idx);
      this.motion.push({ t, x, y, z });
      while (this.motion.length && this.motion[0].t < t - 1500) this.motion.shift();
    }
    _win(start, len) {
      const out = new Float32Array(Math.max(0, len));
      for (let i = 0; i < out.length; i++) out[i] = this.det._get(start + i);
      return out;
    }
    _feat(start, len, end) {
      const hs = Math.max(0, start - this.H);
      return F.windowFeatures(this._win(start, len), this._win(hs, start - hs), this.sr, this.motion, this.ms(start), this.ms(end));
    }
    _predict(model, f) {
      const p = model.predict(vec(f, this.m.groups || DEFAULTS.groups));
      return { label: p.zone, p: p.prob, probs: CLASSES.map((c) => { const i = model.classes.indexOf(c); return i < 0 ? 0 : p.probs[i]; }) };
    }
    // chunk: raw mic samples. nowMs: the caller's clock (performance.now() on the phone), used only for muting.
    process(chunk, nowMs = 0) {
      this.nowMs = nowMs;
      this.det.process(chunk, nowMs, (h) => {
        const o = { peak: h.peakIdx, amp: h.peakAmp / h.thr };
        this.pending.push(o);
        if (this.onOnset) this.onOnset(o);
      });
      const T = this.det.total;
      while (this.pending.length && T >= this.pending[0].peak - this.pre + this.Wh) this._hit(this.pending.shift(), T);
      while (T >= this.nextFrame) { this._frame(this.nextFrame, T); this.nextFrame += this.hop; }
    }
    _hit(o, T) {
      const start = o.peak - this.pre, f = this._feat(start, this.Wh, T), pr = this._predict(this.m.hit, f);
      const echo = !!this.lastHit && o.peak - this.lastHit.peak < this.echo && o.amp < this.o.echoRatio * this.lastHit.amp;
      const r = (this.m.ranges || {})[pr.label];
      const vel = r ? 0.3 + 0.7 * norm(Math.log(o.amp), r.amp) : 0.7;
      const ev = { kind: pr.label, conf: pr.p, probs: pr.probs, amp: o.amp, vel, peak: o.peak, lagMs: this.ms(T - o.peak), f, echo };
      if (F.HIT(pr.label) && !echo) { this.lastHit = o; if (this.onHit) this.onHit(ev); }
      else if (this.onSkip) this.onSkip(ev);
    }
    _frame(end, T) {
      const start = end - this.Wt, f = this._feat(start, this.Wt, T), pr = this._predict(this.m.tex, f);
      const muted = this.nowMs < this.det.muteUntilMs; // a tap on the phone's own screen
      const gate = this.o.gate == null || !this.m.ranges || !this.m.ranges.quiet ? -Infinity : this.m.ranges.quiet.loud95 + this.o.gate;
      const cand = !muted && (pr.label === "scratch" || pr.label === "rub") && loud(f) >= gate ? pr.label : null;
      // A tap sounds like the start of a scratch to the texture model. So a texture doesn't switch ON while a sharp sound is
      // still being decided by the hit path, nor for holdMs after one turned out to be a tap or flick (its ringing tail).
      const deciding = this.det.pending.length > 0 || this.pending.length > 0;
      const ringing = !!this.lastHit && end - this.lastHit.peak < (this.o.holdMs * this.sr) / 1000;
      const mayStart = !(this.o.holdMs && (deciding || ringing));
      this.recent.push(cand);
      if (this.recent.length > 8) this.recent.shift();
      const last = (n) => this.recent.slice(-n);
      let st = this.state;
      const sure = cand && this.o.enterConf != null && pr.p >= this.o.enterConf; // one confident frame is enough
      if (cand && cand !== st && (st || mayStart) && (sure || (this.recent.length >= this.o.enter && last(this.o.enter).every((c) => c === cand)))) st = cand;
      else if (st && this.recent.length >= this.o.exit && last(this.o.exit).every((c) => c !== st)) st = null;
      const r = (this.m.ranges || {})[st || cand || "rub"] || {};
      const level = norm(loud(f), r.loud);
      const speed = (st || cand) === "scratch" ? clamp01(0.6 * level + 0.4 * norm(bright(f), r.bright)) : level;
      const ev = { end, label: pr.label, conf: pr.p, probs: pr.probs, state: st, level, speed, bands: f.mic.slice(0, 18).map((v) => v + f.mic[18]), f };
      if (st !== this.state) {
        const prev = this.state;
        this.state = st;
        if (this.onState) this.onState({ state: st, prev, end, level, speed });
      }
      if (this.onFrame) this.onFrame(ev);
    }
  }

  const api = { Engine, trainModels, sessionExamples, compact, expand, packModels, unpackModels, DEFAULTS, FEAT_VERSION, CLASSES, vec };
  if (node) module.exports = api;
  else root.PaperEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
