'use strict';
// Standalone dev server — same parser as the extension, served over HTTP.
// Useful for iterating on the dashboard without reloading the IDE.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { snapshot, PROJECTS_DIR } = require('./parser');
const { quota } = require('./quota');
const codex = require('./codex');

const PORT = Number(process.env.PORT || 4317);
const clients = new Set();
let codexPending;

// Same payload the extension posts to its webview, so both front-ends can share
// one render() — local transcript data plus the real (soft-failing) quota.
async function payload({ forceCodex = false } = {}) {
  if (forceCodex) await codex.refresh({ force: true });
  const data = snapshot();
  data.quota = await quota().catch(() => null);
  data.codex = codex.read();
  return data;
}

async function push() {
  const frame = `data: ${JSON.stringify(await payload())}\n\n`;
  for (const res of clients) res.write(frame);
}

// Coalesce the burst of writes a single assistant turn produces.
let pending;
fs.watch(PROJECTS_DIR, { recursive: true }, (_e, file) => {
  if (!file || !file.endsWith('.jsonl')) return;
  clearTimeout(pending);
  pending = setTimeout(push, 400);
});

// The reset countdown keeps moving even when nothing is being written.
setInterval(push, 60_000).unref?.();

// Codex aggregation shells out to ccusage only in the background. Ordinary
// payloads read the shared five-minute cache and never block on a subprocess.
codex.refresh().then(push).catch(() => {});
setInterval(() => codex.refresh().then(push).catch(() => {}), codex.TTL_MS).unref?.();

// Codex writes several JSONL rows during one turn. Wait for the burst to settle,
// then rebuild once — near-live without shelling out for every streaming row.
try {
  fs.watch(codex.CODEX_DIR, { recursive: true }, (_e, file) => {
    if (!file || !file.endsWith('.jsonl')) return;
    clearTimeout(codexPending);
    codexPending = setTimeout(() => codex.refresh({ force: true }).then(push).catch(() => {}), 3_000);
  });
} catch {}

http.createServer(async (req, res) => {
  if (req.url === '/api/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await payload()));
  }
  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(await payload())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/codex/refresh') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await payload({ forceCodex: true })));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // Same file the extension panel loads — one dashboard, two hosts.
  res.end(fs.readFileSync(path.join(__dirname, 'media', 'dashboard.html')));
}).listen(PORT, () => {
  console.log(`Claude usage dashboard → http://localhost:${PORT}`);
});
