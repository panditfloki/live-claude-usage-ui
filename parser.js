'use strict';
// Shared usage parser. CommonJS because the VS Code extension host requires it —
// the dev server (server.js) and the extension both consume this one file.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// USD per million tokens. Cache-write rates differ by TTL: 1.25x base input for
// the 5-minute cache, 2x for the 1-hour cache. Claude Code writes 1h entries.
const PRICING = {
  'claude-opus-4-8':           { in: 5,  out: 25, write5m: 6.25,  write1h: 10, read: 0.50 },
  'claude-opus-4-7':           { in: 5,  out: 25, write5m: 6.25,  write1h: 10, read: 0.50 },
  'claude-opus-4-6':           { in: 5,  out: 25, write5m: 6.25,  write1h: 10, read: 0.50 },
  'claude-fable-5':            { in: 10, out: 50, write5m: 12.50, write1h: 20, read: 1.00 },
  'claude-sonnet-5':           { in: 3,  out: 15, write5m: 3.75,  write1h: 6,  read: 0.30 },
  'claude-sonnet-4-6':         { in: 3,  out: 15, write5m: 3.75,  write1h: 6,  read: 0.30 },
  'claude-haiku-4-5':          { in: 1,  out: 5,  write5m: 1.25,  write1h: 2,  read: 0.10 },
  'claude-haiku-4-5-20251001': { in: 1,  out: 5,  write5m: 1.25,  write1h: 2,  read: 0.10 },
};

const BLOCK_MS = 5 * 60 * 60 * 1000;

function costOf(model, u) {
  const p = PRICING[model];
  if (!p) return 0;
  const w1h = u.cacheCreation.ephemeral1h;
  const w5m = u.cacheCreation.ephemeral5m;
  // Fall back to the aggregate when the per-TTL split is absent (older transcripts).
  const unsplit = Math.max(0, u.cacheWrite - w1h - w5m);
  return (
    u.input * p.in +
    u.output * p.out +
    u.cacheRead * p.read +
    w1h * p.write1h +
    (w5m + unsplit) * p.write5m
  ) / 1e6;
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const home = os.homedir();
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel || path.basename(cwd);
}

// Incremental tail state: file -> bytes already consumed.
const offsets = new Map();

// One record per assistant message, keyed by message.id + requestId.
//
// Two distinct sources of repeats, both handled here:
//   1. A streaming message is rewritten to the transcript as it grows, so the
//      same key appears several times with an INCREASING output_tokens. Only
//      the last write is complete — keeping the first undercounts output badly.
//   2. Resuming or forking a session replays earlier turns into a second file.
// Keeping the highest-output row per key is correct for both.
const byId = new Map();
let anon = 0;

function ingestLine(line) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (d.type !== 'assistant') return;

  const msg = d.message;
  const u = msg && msg.usage;
  if (!u || !msg.model || msg.model === '<synthetic>') return;

  const key = msg.id && d.requestId ? `${msg.id}:${d.requestId}` : `anon:${anon++}`;
  const output = u.output_tokens || 0;
  const prev = byId.get(key);
  if (prev && prev.output >= output) return;

  const cc = u.cache_creation || {};
  const usage = {
    input: u.input_tokens || 0,
    output,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: {
      ephemeral1h: cc.ephemeral_1h_input_tokens || 0,
      ephemeral5m: cc.ephemeral_5m_input_tokens || 0,
    },
  };

  byId.set(key, Object.assign({
    ts: Date.parse(d.timestamp),
    model: msg.model,
    session: d.sessionId,
    project: projectName(d.cwd),
    // A subagent's cwd matches its parent, so tag it to keep the two apart.
    subagent: d.isSidechain === true,
    cost: costOf(msg.model, usage),
  }, usage));
}

function scanFile(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }

  let start = offsets.get(file) || 0;
  if (size < start) start = 0;   // truncated or rewritten — re-read from the top
  if (size <= start) return;

  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(size - start);
  fs.readSync(fd, buf, 0, size - start, start);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  // Keep any trailing partial line for the next pass — a turn may still be streaming.
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return;
  for (const line of text.slice(0, lastNl).split('\n')) {
    if (line.trim()) ingestLine(line);
  }
  offsets.set(file, start + Buffer.byteLength(text.slice(0, lastNl + 1)));
}

// Subagent transcripts sit three levels down (<project>/<session>/subagents/),
// so this has to recurse — a one-level listing silently drops all of them.
function listTranscripts(dir, out) {
  dir = dir || PROJECTS_DIR;
  out = out || [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) listTranscripts(full, out);
    else if (it.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function refresh() {
  for (const f of listTranscripts()) scanFile(f);
  return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
}

// Rolling 5-hour windows, ccusage-style: a block opens on the first message
// after a >=5h gap, anchored to the top of that hour, and stays open for 5h.
// This is a RECONSTRUCTION. The server's real quota is not in any local file.
function blocks(list) {
  const out = [];
  let cur = null;
  for (const e of list) {
    if (!cur || e.ts - cur.start >= BLOCK_MS || e.ts - cur.last >= BLOCK_MS) {
      const anchor = new Date(e.ts);
      anchor.setMinutes(0, 0, 0);
      cur = { start: anchor.getTime(), last: e.ts, cost: 0, tokens: 0, entries: 0 };
      out.push(cur);
    }
    cur.last = e.ts;
    cur.cost += e.cost;
    cur.tokens += e.input + e.output + e.cacheWrite + e.cacheRead;
    cur.entries++;
  }
  return out;
}

function byKey(list, keyFn) {
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    const g = m.get(k) || { key: k, cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0 };
    g.cost += e.cost;
    g.input += e.input;
    g.output += e.output;
    g.cacheWrite += e.cacheWrite;
    g.cacheRead += e.cacheRead;
    g.turns++;
    m.set(k, g);
  }
  return Array.from(m.values()).sort((a, b) => b.cost - a.cost);
}

const dayKey = ts => {
  const d = new Date(ts);            // local calendar day, not UTC — streaks must
  d.setHours(0, 0, 0, 0);            // match the days the user actually worked
  return d;
};
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Consecutive active days ending today (or yesterday — a streak shouldn't break
// just because today's work hasn't started yet).
function streaks(activeDays) {
  if (!activeDays.size) return { current: 0, longest: 0 };
  const sorted = [...activeDays].sort();
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]), cur = new Date(sorted[i]);
    const gap = Math.round((cur - prev) / 864e5);
    run = gap === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  let current = 0;
  const cursor = dayKey(Date.now());
  if (!activeDays.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (activeDays.has(iso(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

function snapshot() {
  const list = refresh();
  const now = Date.now();
  const dayAgo = now - 24 * 3600e3;

  const blks = blocks(list);
  const open = blks[blks.length - 1];
  const live = open && now - open.start < BLOCK_MS ? open : null;

  const days = new Map();
  for (const e of list) {
    const d = new Date(e.ts).toISOString().slice(0, 10);
    const g = days.get(d) || { day: d, cost: 0, tokens: 0 };
    g.cost += e.cost;
    g.tokens += e.input + e.output + e.cacheWrite + e.cacheRead;
    days.set(d, g);
  }

  const totals = list.reduce((a, e) => {
    a.cost += e.cost; a.input += e.input; a.output += e.output;
    a.cacheWrite += e.cacheWrite; a.cacheRead += e.cacheRead; a.turns++;
    return a;
  }, { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0 });

  const subagents = list.filter(e => e.subagent)
    .reduce((a, e) => { a.cost += e.cost; a.turns++; return a; }, { cost: 0, turns: 0 });

  const today = list.filter(e => e.ts >= dayAgo);
  const todayAgg = today.length ? byKey(today, () => 'today')[0] : null;

  // --- Overview stats -------------------------------------------------------
  const activeDays = new Set(list.map(e => iso(dayKey(e.ts))));
  const hours = new Array(24).fill(0);
  for (const e of list) hours[new Date(e.ts).getHours()] += e.input + e.output;
  const peakHour = hours.indexOf(Math.max(...hours));

  const models = byKey(list, e => e.model);
  // "Total tokens" here is input + output only, excluding cache — the same basis
  // Claude Code's own usage view reports, so the two numbers are comparable.
  const billableTokens = totals.input + totals.output;
  const modelTotals = models.map(m => ({
    key: m.key,
    input: m.input,
    output: m.output,
    turns: m.turns,
    cost: m.cost,
    share: billableTokens ? (m.input + m.output) / billableTokens * 100 : 0,
  }));

  // 26-week contribution grid, oldest → newest, aligned so each row is a weekday.
  const heat = [];
  const cursor = dayKey(now);
  cursor.setDate(cursor.getDate() - 181);
  const perDay = new Map();
  for (const e of list) {
    const k = iso(dayKey(e.ts));
    const g = perDay.get(k) || { tokens: 0, cost: 0 };
    g.tokens += e.input + e.output;
    g.cost += e.cost;
    perDay.set(k, g);
  }
  while (cursor <= dayKey(now)) {
    const k = iso(cursor);
    const g = perDay.get(k);
    heat.push({ day: k, dow: cursor.getDay(), tokens: g ? g.tokens : 0, cost: g ? g.cost : 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const st = streaks(activeDays);

  // Ship the per-turn events, dictionary-encoded, so the client can re-cut ANY
  // date range instantly without a round trip. Costs are precomputed per turn —
  // pricing must never be duplicated in the UI layer.
  const modelDict = [], projectDict = [], sessionDict = [];
  const idx = (dict, v) => {
    let i = dict.indexOf(v);
    if (i === -1) { dict.push(v); i = dict.length - 1; }
    return i;
  };
  const events = list.map(e => [
    e.ts,
    idx(modelDict, e.model),
    idx(projectDict, e.project),
    idx(sessionDict, e.session),
    e.input, e.output, e.cacheWrite, e.cacheRead,
    Math.round(e.cost * 1e6) / 1e6,
    e.subagent ? 1 : 0,
  ]);

  return {
    generatedAt: now,
    dict: { models: modelDict, projects: projectDict, sessions: sessionDict },
    events,
    totals,
    subagents,
    today: todayAgg,
    stats: {
      sessions: new Set(list.map(e => e.session)).size,
      turns: totals.turns,
      billableTokens,
      activeDays: activeDays.size,
      currentStreak: st.current,
      longestStreak: st.longest,
      peakHour,
      favoriteModel: models.length ? models[0].key : null,
    },
    modelTotals,
    heatmap: heat,
    block: live
      ? { start: live.start, endsAt: live.start + BLOCK_MS, cost: live.cost, tokens: live.tokens, turns: live.entries }
      : null,
    byModel: byKey(list, e => e.model),
    byProject: byKey(list, e => e.project).slice(0, 12),
    bySession: byKey(list, e => e.session).slice(0, 10),
    daily: Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
  };
}

module.exports = { snapshot, refresh, listTranscripts, PROJECTS_DIR, BLOCK_MS };
