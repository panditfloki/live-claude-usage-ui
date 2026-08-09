'use strict';
// Codex usage source. Historical token/cost aggregation belongs to ccusage;
// Mātrā only normalises its stable CLI output and reads the latest account-limit
// record that Codex already wrote into ~/.codex/sessions.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CACHE_FILE = path.join(os.tmpdir(), 'matra-codex.json');
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

let refreshing = null;

function commandPath() {
  const names = process.platform === 'win32' ? ['ccusage.exe', 'ccusage.cmd', 'ccusage'] : ['ccusage'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
  ].filter(Boolean);
  for (const dir of [...new Set(dirs)]) for (const name of names) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; }
    catch {}
  }
  return 'ccusage';
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(commandPath(), args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (parseErr) { reject(parseErr); }
    });
  });
}

function version() {
  return new Promise(resolve => {
    execFile(commandPath(), ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /ccusage\s+([^\s]+)/.exec(stdout);
      resolve(m ? m[1] : stdout.trim() || null);
    });
  });
}

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

function writeCache(data) {
  const temp = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, CACHE_FILE);
  } catch {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function tokenFields(row) {
  return {
    cost: Number(row.costUSD) || 0,
    input: Number(row.inputTokens) || 0,
    output: Number(row.outputTokens) || 0,
    reasoningOutput: Number(row.reasoningOutputTokens) || 0,
    cacheWrite: Number(row.cacheCreationTokens) || 0,
    cacheRead: Number(row.cacheReadTokens) || 0,
    tokens: Number(row.totalTokens) || 0,
  };
}

function models(raw) {
  return Object.entries(raw || {}).map(([name, value]) => ({
    name,
    ...tokenFields(value || {}),
    // ccusage v20 reports cost only at day/session/total level, not per model.
    cost: typeof value?.costUSD === 'number' ? value.costUSD : null,
    isFallback: value?.isFallback === true,
  })).sort((a, b) => b.tokens - a.tokens);
}

function normalise(dailyReport, sessionReport) {
  const daily = Array.isArray(dailyReport?.daily) ? dailyReport.daily.map(row => ({
    day: row.date,
    ...tokenFields(row),
    models: models(row.models),
  })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.day)).sort((a, b) => a.day.localeCompare(b.day)) : [];

  const sessions = Array.isArray(sessionReport?.sessions) ? sessionReport.sessions.map(row => ({
    id: row.sessionId || row.sessionFile || 'unknown',
    directory: row.directory || 'unattributed',
    lastActivity: row.lastActivity || null,
    ...tokenFields(row),
    models: models(row.models),
  })).sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))) : [];

  return { daily, sessions, totals: tokenFields(dailyReport?.totals || {}) };
}

function listJsonl(dir = CODEX_DIR, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsonl(full, out);
    else if (entry.name.endsWith('.jsonl')) {
      try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
    }
  }
  return out;
}

function quotaShape(rateLimits, observedAt) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const limits = [];
  for (const kind of ['primary', 'secondary']) {
    const raw = rateLimits[kind];
    if (!raw || typeof raw.used_percent !== 'number') continue;
    const mins = Number(raw.window_minutes) || 0;
    const group = mins <= 6 * 60 ? 'session' : mins >= 6 * 24 * 60 ? 'weekly' : 'rolling';
    const windowLabel = mins === 10080 ? '7-day' : mins === 300 ? '5-hour'
      : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${mins}-minute`;
    limits.push({
      kind,
      group,
      label: `Codex · ${windowLabel}`,
      percent: raw.used_percent,
      windowMs: mins * 60_000,
      resetsAt: Number(raw.resets_at) ? Number(raw.resets_at) * 1000 : null,
    });
  }
  const credits = rateLimits.credits || {};
  return {
    plan: rateLimits.plan_type
      ? rateLimits.plan_type.charAt(0).toUpperCase() + rateLimits.plan_type.slice(1)
      : null,
    fetchedAt: observedAt || Date.now(),
    limits,
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: credits.balance ?? null,
    },
  };
}

function latestQuota(dir = CODEX_DIR) {
  const files = listJsonl(dir).sort((a, b) => b.mtime - a.mtime);
  let newest = null;
  for (const { file } of files) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"') || !lines[i].includes('"rate_limits"')) continue;
      try {
        const row = JSON.parse(lines[i]);
        if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
        const observedAt = Date.parse(row.timestamp) || 0;
        const q = quotaShape(row.payload.rate_limits, observedAt || Date.now());
        if (q && q.limits.length) {
          if (!newest || observedAt > newest.observedAt) newest = { observedAt, quota:q };
          // Lines are newest-last. Once this file yields a valid limit, older
          // rows in the same file cannot beat it.
          break;
        }
      } catch {}
    }
  }
  return newest?.quota || null;
}

function unavailable(reason, quota = null) {
  return {
    available: false,
    fetchedAt: null,
    stale: false,
    staleReason: reason,
    source: { name: 'ccusage', version: null },
    totals: null,
    daily: [],
    sessions: [],
    quota,
  };
}

function present(cache, quota, now = Date.now()) {
  if (!cache?.data) return unavailable(cache?.error || 'ccusage unavailable', quota);
  const age = now - cache.at;
  return {
    available: true,
    fetchedAt: cache.at,
    stale: age >= TTL_MS || !!cache.error,
    staleReason: cache.error || (age >= TTL_MS ? 'cache expired' : null),
    source: { name: 'ccusage', version: cache.version || null },
    ...normalise(cache.data.daily, cache.data.sessions),
    quota,
  };
}

function read() {
  return present(readCache(), latestQuota());
}

async function refresh({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache?.data && Date.now() - cache.at < TTL_MS) return read();
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const [daily, sessions, v] = await Promise.all([
        run(['codex', 'daily', '--json']),
        run(['codex', 'session', '--json']),
        version(),
      ]);
      writeCache({ at: Date.now(), version: v, data: { daily, sessions }, error: null });
    } catch (err) {
      writeCache({
        ...(cache || {}),
        error: err?.code === 'ENOENT' ? 'ccusage unavailable' : 'ccusage refresh failed',
      });
    } finally {
      refreshing = null;
    }
    return read();
  })();
  return refreshing;
}

module.exports = {
  read,
  refresh,
  normalise,
  quotaShape,
  latestQuota,
  present,
  commandPath,
  CACHE_FILE,
  CODEX_DIR,
  TTL_MS,
};
