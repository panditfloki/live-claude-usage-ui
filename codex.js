'use strict';
// Codex usage source. Historical token/cost aggregation belongs to ccusage;
// Mātrā only normalises its stable CLI output and reads the latest account-limit
// record that Codex already wrote into ~/.codex/sessions.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
// Codex moves finished rollouts here, and ccusage counts them. Reading only the
// live folder loses most of the history — and with it, most of the attribution.
const CODEX_ARCHIVE_DIR = path.join(os.homedir(), '.codex', 'archived_sessions');
const CACHE_FILE = path.join(os.tmpdir(), 'matra-codex.json');
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

let refreshing = null;

// Every directory that could hold ccusage or the node its shebang needs.
// This list is the single source for BOTH finding the binary and building the
// PATH we hand the child — see execEnv().
function binDirs() {
  return [...new Set([
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
  ].filter(Boolean))];
}

// ⚠ launchd starts us with a BARE PATH (/usr/bin:/bin:/usr/sbin:/sbin). Finding
// the ccusage *file* is not enough: its shebang is `#!/usr/bin/env node`, so the
// child needs a PATH that contains node too, or it dies with exit 127
// "env: node: No such file or directory" — and the failure looks like a stale
// cache, not a broken PATH. Lekhā's LaunchAgent hit this same bug first; fixing
// it in the plist alone would leave every other device to rediscover it.
function execEnv() {
  return { ...process.env, PATH: binDirs().join(path.delimiter) };
}

function commandPath() {
  const names = process.platform === 'win32' ? ['ccusage.exe', 'ccusage.cmd', 'ccusage'] : ['ccusage'];
  for (const dir of binDirs()) for (const name of names) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; }
    catch {}
  }
  return 'ccusage';
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(commandPath(), args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: execEnv() }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (parseErr) { reject(parseErr); }
    });
  });
}

function version() {
  return new Promise(resolve => {
    execFile(commandPath(), ['--version'], { timeout: 5_000, env: execEnv() }, (err, stdout) => {
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

function normalise(dailyReport, sessionReport, folders = new Map()) {
  const daily = Array.isArray(dailyReport?.daily) ? dailyReport.daily.map(row => ({
    day: row.date,
    ...tokenFields(row),
    models: models(row.models),
  })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.day)).sort((a, b) => a.day.localeCompare(b.day)) : [];

  const sessions = Array.isArray(sessionReport?.sessions) ? sessionReport.sessions.map(row => {
    const cwd = folders.get(sessionUuid(row) || '') || null;
    return {
      id: row.sessionId || row.sessionFile || 'unknown',
      // ⚠ ccusage's Codex `directory` is the session FILE's date folder
      // ("2026/08/09"), NOT a working directory. Kept verbatim because it is
      // what upstream said, but it must never be rendered as attribution.
      directory: row.directory || null,
      // The real working folder, joined from the rollout's session_meta header.
      folder: folderLabel(cwd),
      cwd,
      attributed: !!cwd,
      lastActivity: row.lastActivity || null,
      ...tokenFields(row),
      models: models(row.models),
    };
  }).sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))) : [];

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

// One walk, newest first, reused by the quota reader and the cwd map so the
// directory tree is never scanned twice in a render.
function sessionFiles(dirs = [CODEX_DIR, CODEX_ARCHIVE_DIR]) {
  const out = [];
  for (const dir of dirs) listJsonl(dir, out);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Read one line without guessing its length. A rollout's first line carries
// base_instructions and runs ~17 KB on this disk, so a fixed 2 KB read returns
// truncated JSON and JSON.parse fails on EVERY file — silently, since the
// caller only sees "no attribution". Grow until the newline actually arrives.
function readFirstLine(file, cap = 4 * 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let acc = '';
    while (acc.length < cap) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      acc += chunk.slice(0, read).toString('utf8');
      const nl = acc.indexOf('\n');
      if (nl !== -1) return acc.slice(0, nl);
    }
    return acc || null;
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch {} }
}

// session_id -> cwd, from each rollout's `session_meta` header. Cached per file
// and invalidated by mtime, so a steady state costs one stat() per file.
const cwdCache = new Map();   // file -> { mtime, id, cwd }

function cwdMap(files = sessionFiles()) {
  const map = new Map();
  for (const { file, mtime } of files) {
    let hit = cwdCache.get(file);
    if (!hit || hit.mtime !== mtime) {
      hit = { mtime, id: null, cwd: null };
      const line = readFirstLine(file);
      if (line) {
        try {
          const row = JSON.parse(line);
          if (row?.type === 'session_meta') {
            const p = row.payload || {};
            // Codex writes the id as `id`; accept `session_id` in case that changes.
            const id = p.id || p.session_id;
            if (id && p.cwd) { hit.id = String(id).toLowerCase(); hit.cwd = p.cwd; }
          }
        } catch {}
      }
      cwdCache.set(file, hit);
    }
    if (hit.id && hit.cwd && !map.has(hit.id)) map.set(hit.id, hit.cwd);
  }
  return map;
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// ccusage identifies a session as `2026/07/19/rollout-<ISO>-<uuid>`; the uuid is
// the only part that matches the rollout header.
function sessionUuid(row) {
  for (const field of [row?.sessionFile, row?.sessionId]) {
    const m = field && UUID_RE.exec(String(field));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// Same home-relative shape parser.js gives Claude projects, so both sides of a
// Combined view read alike. parser.js stays untouched by contract.
function folderLabel(cwd) {
  if (!cwd) return null;
  const home = os.homedir();
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel || path.basename(cwd) || cwd;
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

function latestQuota(dirs = [CODEX_DIR, CODEX_ARCHIVE_DIR]) {
  const files = Array.isArray(dirs) && dirs.length && typeof dirs[0] === 'object'
    ? dirs                                       // an already-walked file list
    : sessionFiles(typeof dirs === 'string' ? [dirs] : dirs);
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

function present(cache, quota, now = Date.now(), folders = new Map()) {
  if (!cache?.data) return unavailable(cache?.error || 'ccusage unavailable', quota);
  const age = now - cache.at;
  return {
    available: true,
    fetchedAt: cache.at,
    stale: age >= TTL_MS || !!cache.error,
    staleReason: cache.error || (age >= TTL_MS ? 'cache expired' : null),
    source: { name: 'ccusage', version: cache.version || null },
    ...normalise(cache.data.daily, cache.data.sessions, folders),
    quota,
  };
}

function read() {
  // One directory walk feeds both the quota record and the folder map.
  const files = sessionFiles();
  return present(readCache(), latestQuota(files), Date.now(), cwdMap(files));
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
  binDirs,
  execEnv,
  sessionFiles,
  readFirstLine,
  cwdMap,
  sessionUuid,
  folderLabel,
  CACHE_FILE,
  CODEX_DIR,
  CODEX_ARCHIVE_DIR,
  TTL_MS,
};
