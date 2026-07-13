'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { snapshot, PROJECTS_DIR } = require('./parser');
const { quota } = require('./quota');

let status;
let panel;
let watcher;
let debounce;
let poll;

const usd = n => '$' + (n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString());
const num = n =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' :
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' :
  n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

// "145h 42m" is unreadable — show the two most significant units.
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

// Text bar for the tooltip — a webview isn't available there.
const meter = pct => {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

async function render() {
  let data;
  try {
    data = snapshot();
  } catch (err) {
    status.text = '$(warning) usage';
    status.tooltip = 'Claude Usage Meter could not read transcripts: ' + err.message;
    return;
  }

  // Soft dependency: null means the endpoint is gone, the token rotated, or
  // we're offline. Everything below must still work.
  const q = await quota().catch(() => null);

  const cfg = vscode.workspace.getConfiguration('claudeUsage');
  // A StatusBarItem is HIDDEN until show() is called — there is no `visible`
  // property on the real API. Assigning one silently does nothing.
  if (cfg.get('statusBar.show', true)) status.show(); else status.hide();
  const metric = cfg.get('statusBar.metric', 'quota');

  const session = q && q.limits.find(l => l.kind === 'session');
  const b = data.block;
  const t = data.today;

  let label;
  if (metric === 'quota' && session) {
    label = `${session.percent}%${session.resetsAt ? ' · ' + until(session.resetsAt) : ''}`;
  } else if (metric === 'total') {
    label = `${usd(data.totals.cost)} all time`;
  } else if (metric === 'today') {
    label = t ? `${usd(t.cost)} today` : '$0 today';
  } else if (metric === 'cost') {
    label = b ? `${usd(b.cost)} · ${b.turns} turns` : 'idle';
  } else {
    // Asked for quota but it's unavailable — fall back rather than show nothing.
    label = b ? `${usd(b.cost)} · est` : 'idle';
  }

  const warn = session && session.percent >= 80;
  status.text = `${warn ? '$(flame)' : '$(pulse)'} ${label}`;
  status.backgroundColor = warn
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;

  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown('**Claude usage**\n\n');

  if (q) {
    if (q.plan) md.appendMarkdown(`Plan — **${q.plan}**\n\n`);
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
  md.appendMarkdown('*Costs are equivalent API cost — a burn proxy, not a bill.*\n\n');
  md.appendMarkdown('Click to open the dashboard.');
  status.tooltip = md;

  if (panel) panel.webview.postMessage({ ...data, quota: q });
}

function openPanel(context) {
  if (panel) return panel.reveal(vscode.ViewColumn.Beside);

  panel = vscode.window.createWebviewPanel(
    'claudeUsage', 'Claude Usage', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = fs.readFileSync(
    path.join(context.extensionPath, 'media', 'dashboard.html'), 'utf8'
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  // The webview signals when its listener is attached, avoiding a post-before-ready race.
  panel.webview.onDidReceiveMessage(m => { if (m === 'ready') render(); },
    null, context.subscriptions);
}

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'claudeUsage.open';
  // Show something immediately. render() awaits a network call, so without this
  // the bar would be absent for the first few seconds of every session.
  status.text = '$(pulse) usage…';
  status.tooltip = 'Reading Claude usage…';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsage.open', () => openPanel(context)),
    vscode.commands.registerCommand('claudeUsage.refresh', () => render()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeUsage')) render();
    })
  );

  render();

  // Transcripts are append-only, so the parser tails only new bytes. Coalesce
  // the burst of writes a single assistant turn produces.
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

  // The quota clock keeps moving even when no transcript is being written, so
  // the reset countdown needs its own tick. quota() caches for 60s, so this is
  // one endpoint call a minute at most.
  poll = setInterval(render, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
}

function deactivate() {
  clearTimeout(debounce);
  clearInterval(poll);
  if (watcher) watcher.close();
}

module.exports = { activate, deactivate };
