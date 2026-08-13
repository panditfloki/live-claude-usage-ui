'use strict';
// Standalone dev server — same parser as the extension, served over HTTP.
// Useful for iterating on the dashboard without reloading the IDE.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { snapshot, PROJECTS_DIR } = require('./parser');
const claude = require('./quota');
const codex = require('./codex');
const gemini = require('./gemini');
const fx = require('./fx');
const { watchCacheChanges } = require('./refresh-sync');

const PORT = Number(process.env.PORT || 4317);
const clients = new Set();
let codexPending;
let geminiPending;

// Same payload the extension posts to its webview, so both front-ends can share
// one render() — local transcript data plus real quotas for Claude, Codex, and Gemini.
async function payload({ forceClaude = false, forceCodex = false, forceGemini = false } = {}) {
  const [q] = await Promise.all([
    claude.quota({ force: forceClaude }).catch(() => null),
    forceCodex ? codex.refresh({ force: true }).catch(() => null) : Promise.resolve(),
    forceGemini ? gemini.refresh({ force: true }).catch(() => null) : Promise.resolve(),
  ]);
  const data = snapshot();
  data.quota = q;
  data.codex = codex.read();
  data.gemini = gemini.read();
  // Display-only. Every stored figure stays in its source currency; this rate is
  // what lets the header's ₹/$ toggle convert at render time. Never awaited on
  // the critical path — a missing rate just means the toggle falls back to USD.
  data.fx = fx.read(gemini.planConfig().forexMarkupPercent);
  return data;
}

async function push() {
  try {
    const frame = `data: ${JSON.stringify(await payload())}\n\n`;
    for (const res of clients) res.write(frame);
  } catch {}
}

function resilientWatch(dir, accepts, onChange) {
  let inner;
  let closed = false;
  const attach = () => {
    if (closed || inner || !fs.existsSync(dir)) return;
    try {
      inner = fs.watch(dir, { recursive: true }, (_event, file) => {
        if (file && accepts(String(file))) onChange(String(file));
      });
      inner.on('error', () => {
        try { inner.close(); } catch {}
        inner = undefined;
      });
    } catch { inner = undefined; }
  };
  attach();
  const retry = setInterval(attach, 15_000);
  retry.unref?.();
  return { close() { closed = true; clearInterval(retry); try { inner?.close(); } catch {} } };
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

// Codex and Gemini aggregation shell out or scan in background.
codex.refresh().then(push).catch(() => {});
setInterval(() => codex.refresh().then(push).catch(() => {}), codex.TTL_MS).unref?.();

gemini.refresh().then(push).catch(() => {});
setInterval(() => gemini.refresh().then(push).catch(() => {}), gemini.TTL_MS).unref?.();

// The FX rate is published once a day upstream, so this is a slow heartbeat, not
// a poll. Failures are swallowed: the last good rate keeps serving, and if there
// has never been one the dashboard simply stays in dollars.
fx.refresh().then(push).catch(() => {});
setInterval(() => fx.refresh().then(push).catch(() => {}), fx.TTL_MS).unref?.();

resilientWatch(codex.CODEX_DIR, file => file.endsWith('.jsonl'), () => {
    clearTimeout(codexPending);
    codexPending = setTimeout(() => codex.refresh({ force: true }).then(push).catch(() => {}), 3_000);
});

resilientWatch(gemini.CONVERSATIONS_DIR, gemini.isConversationFile, () => {
    clearTimeout(geminiPending);
    geminiPending = setTimeout(() => gemini.refresh({ force: true }).then(push).catch(() => {}), 3_000);
});

watchCacheChanges([claude.CACHE_FILE, codex.CACHE_FILE, gemini.CACHE_FILE], push);

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
  if (req.method === 'POST' && req.url === '/api/claude/refresh') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await payload({ forceClaude: true })));
  }
  if (req.method === 'POST' && req.url === '/api/gemini/refresh') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await payload({ forceGemini: true })));
  }
  if (req.method === 'POST' && req.url === '/api/refresh') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await payload({ forceClaude: true, forceCodex: true, forceGemini: true })));
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate'
  });
  // Same file the extension panel loads — one dashboard, two hosts.
  res.end(fs.readFileSync(path.join(__dirname, 'media', 'dashboard.html')));
}).listen(PORT, () => {
  console.log(`Claude + Codex + Gemini usage dashboard → http://localhost:${PORT}`);
});
