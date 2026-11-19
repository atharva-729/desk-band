// Paper Pad training worker: builds the hit and texture models from the prompted recordings saved on the laptop,
// in the background so the phone page stays responsive. The features of each recording are worked out once from its
// raw audio (same code as the offline analysis) and cached on the laptop (data/features/, no audio), so later starts
// are quick. Corrections made while playing (data/fixes.jsonl) are added on top.
// Messages in:  {cmd: "train", opts}.  Out: {type: "progress", msg} | {type: "models", models, ...} | {type: "error", msg}.
/* global importScripts, PaperEngine */
importScripts("core.js", "paper.js", "engine.js");
const E = self.PaperEngine;
const memo = {}; // feature cache key -> examples, kept for retraining after a fix

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function recordingExamples(s, o, i, n) {
  const key = `${s.id}-v${E.FEAT_VERSION}-${o.hitMs}-${o.texMs}`;
  if (memo[key]) return memo[key];
  const r = await fetch(`/train/features?key=${key}`, { cache: "no-store" });
  if (r.ok) {
    const j = await r.json();
    return (memo[key] = { hit: j.hit.map(E.expand), tex: j.tex.map(E.expand) });
  }
  postMessage({ type: "progress", msg: `Reading recording ${i + 1} of ${n} (first time only, a few seconds)…` });
  const meta = await getJSON(`/rec/meta?id=${s.id}`);
  const buf = await (await fetch(`/rec/pcm?id=${s.id}`, { cache: "no-store" })).arrayBuffer();
  const i16 = new Int16Array(buf, 0, buf.byteLength >> 1), audio = new Float32Array(i16.length);
  for (let k = 0; k < i16.length; k++) audio[k] = i16[k] / 32767;
  const ex = E.sessionExamples(meta, audio, o);
  fetch(`/train/features?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: s.id, version: E.FEAT_VERSION, hitMs: o.hitMs, texMs: o.texMs, hit: ex.hit.map(E.compact), tex: ex.tex.map(E.compact) }) }).catch(() => {});
  return (memo[key] = ex);
}

onmessage = async (ev) => {
  if (!ev.data || ev.data.cmd !== "train") return;
  const o = { ...E.DEFAULTS, ...(ev.data.opts || {}) };
  try {
    const t0 = Date.now();
    const list = (await getJSON("/rec/list")).filter((s) => s.prompts > 0);
    if (!list.length) return postMessage({ type: "models", models: null, recordings: 0, fixes: 0 });
    const hit = [], tex = [];
    for (let i = 0; i < list.length; i++) {
      const ex = await recordingExamples(list[i], o, i, list.length);
      hit.push(...ex.hit); tex.push(...ex.tex);
    }
    let fixes = 0;
    for (const fx of await getJSON("/train/fixes")) {
      if (fx.path === "hit" && fx.hitMs !== o.hitMs) continue; // made with another hit window
      for (const c of fx.examples || []) (fx.path === "hit" ? hit : tex).push({ ...E.expand({ ...c, l: fx.label }), fix: true });
      fixes++;
    }
    postMessage({ type: "progress", msg: "Learning…" });
    const M = E.trainModels({ hit, tex }, o);
    postMessage({ type: "models", models: E.packModels(M), recordings: list.length, ids: list.map((s) => s.id), fixes, ms: Date.now() - t0 });
  } catch (e) {
    postMessage({ type: "error", msg: e.message });
  }
};
