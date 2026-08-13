'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { snapshot, PROJECTS_DIR } = require('./parser');
const claude = require('./quota');
const codex = require('./codex');
const gemini = require('./gemini');
const fx = require('./fx');
const { statusSummary } = require('./statusbar');
const { watchCacheChanges } = require('./refresh-sync');

let status;
let panel;
let watcher;
let debounce;
let poll;
let codexWatcher;
let codexDebounce;
let geminiWatcher;
let geminiDebounce;
let cacheWatcher;
let focused = true;

const usd = n => '$' + (n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString());
const num = n =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' :
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' :
  n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

function until(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const meter = pct => {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

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
  return {
    close() {
      closed = true;
      clearInterval(retry);
      try { inner?.close(); } catch {}
    },
    dispose() { this.close(); },
  };
}

async function render({ forceClaude = false, forceCodex = false, forceGemini = false } = {}) {
  const [q] = await Promise.all([
    claude.quota({ force: forceClaude }).catch(() => null),
    forceCodex ? codex.refresh({ force: true }).catch(() => null) : Promise.resolve(),
    forceGemini ? gemini.refresh({ force: true }).catch(() => null) : Promise.resolve(),
  ]);
  let data;
  try {
    data = snapshot();
  } catch (err) {
    status.text = '$(warning) usage';
    status.tooltip = 'Claude Usage Meter could not read transcripts: ' + err.message;
    return;
  }

  data.codex = codex.read();
  data.gemini = gemini.read();
  // Display-only rate for the webview's ₹/$ toggle. Refreshed on its own slow
  // heartbeat below, never awaited here — the panel must render without it.
  data.fx = fx.read(gemini.planConfig().forexMarkupPercent);

  const cfg = vscode.workspace.getConfiguration('claudeUsage');
  if (cfg.get('statusBar.show', true)) status.show(); else status.hide();
  const metric = cfg.get('statusBar.metric', 'quota');
  const b = data.block;
  const t = data.today;
  const summary = statusSummary(metric, data, q, data.codex, data.gemini, Date.now(), {
    displayMode: cfg.get('statusBar.displayMode', 'compact'),
    warningThreshold: cfg.get('statusBar.warningThreshold', 80),
    errorThreshold: cfg.get('statusBar.errorThreshold', 95),
    bars: cfg.get('statusBar.bars', true),
  });
  status.text = `${summary.warn ? '$(flame)' : '$(pulse)'} ${summary.label}`;
  status.backgroundColor = summary.severity === 'error'
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : summary.severity === 'warning'
      ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown('**Mātrā · Claude + Codex + Gemini**\n\n');
  md.appendMarkdown('### Claude\n\n');

  if (q) {
    if (q.plan) md.appendMarkdown(`Plan — **${q.plan}**\n\n`);
    const alias = cfg.get('accounts.claudeAlias', '');
    if (alias || q.account) md.appendMarkdown(`Account — **${alias || q.account}**\n\n`);
    for (const l of q.limits) {
      md.appendMarkdown(
        `\`${meter(l.percent)}\` **${l.percent}%** — ${l.label}` +
        (l.resetsAt ? ` · resets in ${until(l.resetsAt)}` : '') + '\n\n'
      );
    }
    md.appendMarkdown('---\n\n');
  } else {
    md.appendMarkdown('_Live quota unavailable — showing local estimate only._\n\n');
    if (b) md.appendMarkdown(`5-hour window *(estimated)* — ${usd(b.cost)} · ${num(b.tokens)} tokens\n\n`);
  }

  md.appendMarkdown(`Last 24h — ${t ? usd(t.cost) : '$0'}\n\n`);
  md.appendMarkdown(`All time — ${usd(data.totals.cost)} over ${data.totals.turns} turns\n\n`);
  md.appendMarkdown('---\n\n### Codex\n\n');

  const x = data.codex;
  if (x?.quota) {
    if (x.quota.plan) md.appendMarkdown(`Plan — **${x.quota.plan}**\n\n`);
    const alias = cfg.get('accounts.codexAlias', '');
    if (alias || x.quota.account) md.appendMarkdown(`Account — **${alias || x.quota.account}**\n\n`);
    for (const l of x.quota.limits || []) {
      md.appendMarkdown(
        `\`${meter(l.percent)}\` **${l.percent}%** — ${l.label}` +
        (l.resetsAt ? ` · resets in ${until(l.resetsAt)}` : '') + '\n\n'
      );
    }
  } else {
    md.appendMarkdown('_Codex quota unavailable._\n\n');
  }

  if (x?.available) {
    const xToday = summary.codexToday;
    md.appendMarkdown(`Today — ${xToday ? usd(xToday.cost) : '$0'} · ${xToday ? num(xToday.tokens) : '0'} tokens\n\n`);
    md.appendMarkdown(`All time — ${usd(x.totals.cost)} · ${num(x.totals.tokens)} tokens over ${x.sessions.length} sessions\n\n`);
    if (x.stale) md.appendMarkdown(`_Codex data is stale${x.staleReason ? ` — ${x.staleReason}` : ''}._\n\n`);
  } else {
    md.appendMarkdown(`_Codex history unavailable${x?.staleReason ? ` — ${x.staleReason}` : ''}._\n\n`);
  }

  md.appendMarkdown('---\n\n### Gemini\n\n');
  const g = data.gemini;
  if (g?.quota) {
    if (g.quota.plan) md.appendMarkdown(`Plan — **${g.quota.plan}**\n\n`);
    for (const l of g.quota.limits || []) {
      // estimatedValue only appears when geminiPriceUsd is declared in plan.json —
      // a linear spread of a price he typed, never a measured cost. "declared est."
      // matches the same wording the dashboard uses for this figure.
      const v = l.estimatedValue;
      const est = v ? ` · ≈ ${v.currency === 'INR' ? '₹' : '$'}${v.remaining.toFixed(2)} left (declared est.)` : '';
      md.appendMarkdown(
        `\`${meter(l.percent)}\` **${l.percent}%** — ${l.label}` +
        (l.resetsAt ? ` · resets in ${until(l.resetsAt)}` : '') + est + '\n\n'
      );
    }
  } else {
    md.appendMarkdown('_Gemini quota unavailable._\n\n');
  }

  if (g?.available) {
    const gToday = summary.geminiToday;
    const tCost = gToday && gToday.cost != null ? usd(gToday.cost) : '$0';
    const tTok = gToday && gToday.tokens != null ? num(gToday.tokens) : '0';
    md.appendMarkdown(`Today — ${tCost} · ${tTok} tokens\n\n`);
    const aCost = g.totals.cost != null ? usd(g.totals.cost) : '$0';
    const aTok = g.totals.tokens != null ? num(g.totals.tokens) : '—';
    md.appendMarkdown(`All time — ${aCost} · ${aTok} tokens over ${g.sessions.length} sessions\n\n`);
    if (g.stale) md.appendMarkdown(`_Gemini data is stale${g.staleReason ? ` — ${g.staleReason}` : ''}._\n\n`);
  } else {
    md.appendMarkdown(`_Gemini history unavailable${g?.staleReason ? ` — ${g.staleReason}` : ''}._\n\n`);
  }

  md.appendMarkdown('*Costs are equivalent API cost — burn proxies, not subscription bills.*\n\n');
  md.appendMarkdown('Click to open the dashboard.');
  status.tooltip = md;

  if (panel) panel.webview.postMessage({ ...data, quota: q });
}

function openPanel(context) {
  if (panel) return panel.reveal(vscode.ViewColumn.Beside);

  panel = vscode.window.createWebviewPanel(
    'claudeUsage', 'Mātrā Usage', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = fs.readFileSync(
    path.join(context.extensionPath, 'media', 'dashboard.html'), 'utf8'
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(m => {
    if (m === 'ready') render();
    if (m === 'refreshClaude') render({ forceClaude: true });
    if (m === 'refreshCodex') render({ forceCodex: true });
    if (m === 'refreshGemini') render({ forceGemini: true });
    if (m === 'refreshAll') render({ forceClaude: true, forceCodex: true, forceGemini: true });
  },
    null, context.subscriptions);
}

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'claudeUsage.open';
  status.text = '$(pulse) usage…';
  status.tooltip = 'Reading Claude + Codex + Gemini usage…';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsage.open', () => openPanel(context)),
    vscode.commands.registerCommand('claudeUsage.refresh', () => render({ forceClaude: true, forceCodex: true, forceGemini: true })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeUsage')) render();
    })
  );

  render();
  codex.refresh().then(() => render()).catch(() => {});
  gemini.refresh().then(() => render()).catch(() => {});
  // Upstream publishes the rate once a day, so this is a heartbeat, not a poll.
  fx.refresh().then(() => render()).catch(() => {});
  const fxPoll = setInterval(() => fx.refresh().then(() => render()).catch(() => {}), fx.TTL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(fxPoll) });

  try {
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_e, file) => {
      if (!file || !file.endsWith('.jsonl')) return;
      clearTimeout(debounce);
      debounce = setTimeout(render, 400);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    const timer = setInterval(render, 15000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  focused = vscode.window.state.focused;
  context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
    focused = state.focused;
    if (focused) render();
  }));

  poll = setInterval(() => { if (focused) render(); }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  const codexPoll = setInterval(() => {
    if (focused) codex.refresh().then(() => render()).catch(() => {});
  }, codex.TTL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(codexPoll) });

  const geminiPoll = setInterval(() => {
    if (focused) gemini.refresh().then(() => render()).catch(() => {});
  }, gemini.TTL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(geminiPoll) });

  codexWatcher = resilientWatch(codex.CODEX_DIR, file => file.endsWith('.jsonl'), () => {
      clearTimeout(codexDebounce);
      codexDebounce = setTimeout(() => codex.refresh({ force: true }).then(() => render()).catch(() => {}), 3_000);
  });
  context.subscriptions.push(codexWatcher);

  geminiWatcher = resilientWatch(gemini.CONVERSATIONS_DIR, gemini.isConversationFile, () => {
      clearTimeout(geminiDebounce);
      geminiDebounce = setTimeout(() => gemini.refresh({ force: true }).then(() => render()).catch(() => {}), 3_000);
  });
  context.subscriptions.push(geminiWatcher);

  cacheWatcher = watchCacheChanges(
    [claude.CACHE_FILE, codex.CACHE_FILE, gemini.CACHE_FILE],
    () => render()
  );
  context.subscriptions.push(cacheWatcher);
}

function deactivate() {
  clearTimeout(debounce);
  clearInterval(poll);
  clearTimeout(codexDebounce);
  clearTimeout(geminiDebounce);
  if (watcher) watcher.close();
  if (codexWatcher) codexWatcher.close();
  if (geminiWatcher) geminiWatcher.close();
  if (cacheWatcher) cacheWatcher.dispose();
}

module.exports = { activate, deactivate };
