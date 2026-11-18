// Shared pad config for the phone and stage pages: up to 8 pads, how many are in use, and their names.
// The chosen count + names live on the laptop (GET/POST /pads → data/training/pads.json).
(function (root) {
  "use strict";
  const ALL = [
    { id: 1, color: "#ff6b5a", name: "Top left" },
    { id: 2, color: "#ffc23d", name: "Top right" },
    { id: 3, color: "#3dd6a3", name: "Bottom right" },
    { id: 4, color: "#5aa8ff", name: "Bottom left" },
    { id: 5, color: "#c084fc", name: "Laptop lid" },
    { id: 6, color: "#ff8fd1", name: "Monitor" },
    { id: 7, color: "#a3e05a", name: "Book" },
    { id: 8, color: "#e8e3d6", name: "Table edge" },
  ];
  const COUNTS = [4, 5, 6, 8];
  const DEFAULT = { count: 4, names: Object.fromEntries(ALL.map((p) => [p.id, p.name])) };

  function normalize(cfg) {
    const out = { count: DEFAULT.count, names: { ...DEFAULT.names } };
    if (cfg && COUNTS.includes(+cfg.count)) out.count = +cfg.count;
    if (cfg && cfg.names) for (const p of ALL) {
      const n = cfg.names[p.id];
      if (typeof n === "string" && n.trim()) out.names[p.id] = n.trim().slice(0, 24);
    }
    return out;
  }
  // The pads in use, ids 1..count, with their colour and (custom) name
  const active = (cfg) => ALL.slice(0, cfg.count).map((p) => ({ ...p, name: cfg.names[p.id] || p.name }));

  // Grid layouts as CSS grid-template-areas. Pads 1–4 keep the table layout (1 2 / 4 3) with the phone in the
  // middle; extra pads (often other objects: laptop lid, monitor) are added after them.
  //   wide (laptop stage): extra columns to the right.   tall (phone): extra rows below.
  const WIDE = {
    4: ["p1 p2", "p4 p3"],
    5: ["p1 p2 p5", "p4 p3 p5"],
    6: ["p1 p2 p5", "p4 p3 p6"],
    8: ["p1 p2 p5 p7", "p4 p3 p6 p8"],
  };
  const TALL = {
    4: ["p1 p2", "p4 p3"],
    5: ["p1 p2", "p4 p3", "p5 p5"],
    6: ["p1 p2", "p4 p3", "p5 p6"],
    8: ["p1 p2", "p4 p3", "p5 p6", "p7 p8"],
  };
  function layout(count, shape) {
    const rows = (shape === "wide" ? WIDE : TALL)[count];
    return { areas: rows.map((r) => `"${r}"`).join(" "), cols: rows[0].split(" ").length, rows: rows.length };
  }

  const api = { ALL, COUNTS, DEFAULT, normalize, active, layout };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeskPads = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
