// Tiny Chrome/Edge driver over the DevTools protocol. No dependencies: Node 22+ has fetch and WebSocket built in.
// Copied from Desk Band's tools/browser-tests. Used by the browser tests in this folder (Playwright is not needed).
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const CANDIDATES = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(extraArgs = []) {
  const exe = CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Edge found; set CHROME=<path>");
  const port = 9300 + Math.floor(Math.random() * 500);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "pp-chrome-"));
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run",
    "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", ...extraArgs, "about:blank"], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await (await fetch(base + "/json/version")).json(); break; } catch { await wait(200); } }
  const pages = [];
  return {
    // Open a page (its own window), with an optional script that runs before the page's own scripts
    async page(url, { width = 1366, height = 860, mobile = false, init = null, dpr = 1 } = {}) {
      const t = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
      const p = await connect(t.webSocketDebuggerUrl);
      await p.send("Runtime.enable"); await p.send("Page.enable");
      await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
      if (init) await p.send("Page.addScriptToEvaluateOnNewDocument", { source: init });
      await p.goto(url);
      pages.push(p);
      return p;
    },
    close() { pages.forEach((p) => p.ws.close()); proc.kill(); },
  };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const waiting = new Map(), errors = [], loaded = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Page.loadEventFired") loaded.splice(0).forEach((r) => r());
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const p = {
    ws, send, errors,
    async goto(url) { const l = new Promise((r) => loaded.push(r)); await send("Page.navigate", { url }); await Promise.race([l, wait(8000)]); await wait(200); },
    async reload() { const l = new Promise((r) => loaded.push(r)); await send("Page.reload"); await Promise.race([l, wait(8000)]); await wait(200); },
    async js(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    click: (sel) => p.js(`document.querySelector(${JSON.stringify(sel)}).click()`),
    text: (sel) => p.js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`),
    select: (sel, v) => p.js(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event("change")); })()`),
    key: (k) => p.js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(String(k))} }))`),
    async until(expr, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.js(expr)) return true; await wait(100); } return false; },
    async shot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(data, "base64")); console.log("screenshot:", file);
    },
  };
  return p;
}

// Start our own server on spare ports with a throwaway data folder, so tests never touch real training
async function startServer({ http = 8101, https = 8544 } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pp-data-"));
  const root = path.join(__dirname, "..");
  const py = process.platform === "win32" ? "python" : "python3";
  const proc = spawn(py, [path.join(root, "server.py")], { cwd: root, stdio: "ignore",
    env: { ...process.env, PAPERPAD_DATA: data, PAPERPAD_HTTP_PORT: String(http), PAPERPAD_HTTPS_PORT: String(https) } });
  for (let i = 0; i < 50; i++) { try { await (await fetch(`http://localhost:${http}/info`)).json(); break; } catch { await wait(200); } }
  return { stage: `http://localhost:${http}/`, phone: `https://localhost:${https}/`, data, stop: () => proc.kill() };
}

module.exports = { launch, startServer, wait };
