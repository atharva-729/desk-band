// Shared by e2e.js and load.js: serve docs/play on localhost, fake flute sensors, a fake "blowing" mic.
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..", "docs", "play");

function serve(port) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/+/, "") || "index.html";
    const full = path.join(ROOT, rel);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// Runs inside the flute phone: a phone held sideways. window.__turn (degrees) is how far it's tilted.
const FAKE_SENSORS = `
  window.__turn = 0;
  setInterval(() => {
    const t = performance.now() / 1000, r = Math.PI / 180;
    const turn = (window.__turn + 0.6 * Math.sin(t * 3)) * r, lift = 3 * Math.sin(t * 1.3) * r;
    const g = [-9.81 * Math.cos(turn) * Math.cos(lift), 9.81 * Math.sin(lift), 9.81 * Math.sin(turn) * Math.cos(lift)];
    window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: g[0], y: g[1], z: g[2] } }));
  }, 1000 / 60);`;

// Fake mic, looping: 1 s of a quiet room, then 1 s of "blowing" (loud low-passed noise). Written to a temp folder.
function noiseWav(file) {
  const sr = 48000, n = sr * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const v = i < sr ? (Math.random() * 2 - 1) * 0.0005 : (y += 0.12 * ((Math.random() * 2 - 1) * 0.5 - y));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { serve, FAKE_SENSORS, noiseWav, ROOT };
