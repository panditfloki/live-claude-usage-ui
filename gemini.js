'use strict';
// Gemini / Antigravity usage source.
// Reads Antigravity CLI conversation SQLite DBs (~/.gemini/antigravity-cli/conversations/*.db),
// transcripts, and history logs to normalize token/cost metrics and session attribution.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GEMINI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CONVERSATIONS_DIR = path.join(GEMINI_DIR, 'conversations');
const HISTORY_FILE = path.join(GEMINI_DIR, 'history.jsonl');
const CACHE_FILE = path.join(os.tmpdir(), 'matra-gemini.json');
const CACHE_VERSION = 3;
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;

const PRICING = {
  // Standard paid-tier Gemini Developer API rates, per 1M tokens.
  // These produce an equivalent API-cost proxy; Antigravity itself may be subscription-backed.
  'gemini-3.6-flash': { in: 1.50, out: 7.50, cache: 0.15 },
  'gemini-3.5-flash': { in: 1.50, out: 9.00, cache: 0.15 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40, cache: 0.025 },
  'gemini-1.5-pro':   { in: 1.25, out: 5.00, cache: 0.3125 },
  'gemini-1.5-flash': { in: 0.075, out: 0.30, cache: 0.01875 },
};

let refreshing = null;

function baseModelKey(modelName) {
  if (!modelName) return null;
  const clean = modelName.toLowerCase().replace(/-(high|low|medium)$/, '');
  if (PRICING[clean]) return clean;
  for (const k of Object.keys(PRICING)) {
    if (clean.includes(k)) return k;
  }
  return null;
}

function costOf(modelName, input, output, cache) {
  const p = PRICING[baseModelKey(modelName)];
  if (!p) return null;
  return (input * p.in + output * p.out + cache * p.cache) / 1e6;
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

function folderLabel(cwd) {
  if (!cwd) return null;
  const home = os.homedir();
  const rel = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return rel || path.basename(cwd) || cwd;
}

function isConversationFile(file) {
  return typeof file === 'string' && (file.endsWith('.db') || file.endsWith('.db-wal'));
}

function cwdMap() {
  const map = new Map();
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.conversationId && obj.workspace) {
            map.set(String(obj.conversationId).toLowerCase(), obj.workspace);
          }
        } catch {}
      }
    } catch {}
  }
  return map;
}

function parseGenMetadataBuf(buf) {
  let model = 'gemini-unknown';
  let input = 0, output = 0, cache = 0, timestamp = 0;

  const str = buf.toString('utf8');
  const modelId = str.match(/gemini-\d+(?:\.\d+)+-[a-z0-9.-]+/i);
  const displayName = str.match(/Gemini\s+(\d+(?:\.\d+)*)\s+([A-Za-z][A-Za-z-]*)(?:\s+\(([^)]+)\))?/i);
  if (modelId) {
    model = modelId[0].toLowerCase();
  } else if (displayName) {
    model = `gemini-${displayName[1]}-${displayName[2]}`.toLowerCase();
    if (displayName[3]) model += `-${displayName[3].toLowerCase().replace(/\s+/g, '-')}`;
  }

  function find(subBuf) {
    let p = 0;
    while (p < subBuf.length) {
      let b;
      try { b = subBuf[p++]; } catch { break; }
      if (b === undefined) break;
      const wireType = b & 0x07;
      const fieldNum = b >> 3;

      if (wireType === 0) {
        let val = 0, shift = 0;
        while (p < subBuf.length) {
          const byte = subBuf[p++];
          val |= (byte & 0x7f) << shift;
          shift += 7;
          if ((byte & 0x80) === 0) break;
        }
        if (fieldNum === 1 && val > 1700000000 && val < 2000000000 && !timestamp) timestamp = val * 1000;
        if (fieldNum === 1 && val > 0 && val < 10000000 && !input) input = val;
        if (fieldNum === 2 && val > 0 && val < 10000000 && !cache) cache = val;
        if (fieldNum === 3 && val > 0 && val < 10000000 && !output) output = val;
      } else if (wireType === 2) {
        let len = 0, shift = 0;
        while (p < subBuf.length) {
          const byte = subBuf[p++];
          len |= (byte & 0x7f) << shift;
          shift += 7;
          if ((byte & 0x80) === 0) break;
        }
        if (p + len <= subBuf.length) {
          find(subBuf.slice(p, p + len));
        }
        p += len;
      } else if (wireType === 1) p += 8;
      else if (wireType === 5) p += 4;
      else break;
    }
  }

  find(buf);
  return { model, input, output, cache, timestamp };
}

function scanConversations() {
  const cwds = cwdMap();
  let files = [];
  try { files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.db')); } catch { return []; }

  const sessions = [];

  for (const f of files) {
    const fullPath = path.join(CONVERSATIONS_DIR, f);
    const uuid = f.replace('.db', '').toLowerCase();
    const stat = fs.statSync(fullPath);
    const cwd = cwds.get(uuid) || null;

    let rows = [];
    try {
      const raw = execFileSync('sqlite3', [fullPath, 'SELECT hex(data) FROM gen_metadata;'], { encoding: 'utf8', timeout: TIMEOUT_MS });
      rows = raw.trim().split('\n').filter(Boolean);
    } catch {}

    if (!rows.length) continue;

    let sessInput = 0, sessOutput = 0, sessCache = 0, sessCost = 0, lastTs = stat.mtimeMs;
    const modelStatsMap = new Map();

    for (const r of rows) {
      const parsed = parseGenMetadataBuf(Buffer.from(r, 'hex'));
      const turnCost = costOf(parsed.model, parsed.input, parsed.output, parsed.cache);

      sessInput += parsed.input;
      sessOutput += parsed.output;
      sessCache += parsed.cache;
      if (turnCost != null) sessCost += turnCost;
      if (parsed.timestamp > 0) lastTs = Math.max(lastTs, parsed.timestamp);

      const mKey = parsed.model;
      const mStat = modelStatsMap.get(mKey) || { name: mKey, input: 0, output: 0, cacheRead: 0, tokens: 0, cost: 0 };
      mStat.input += parsed.input;
      mStat.output += parsed.output;
      mStat.cacheRead += parsed.cache;
      mStat.tokens += (parsed.input + parsed.output + parsed.cache);
      if (turnCost != null) mStat.cost += turnCost;
      modelStatsMap.set(mKey, mStat);
    }

    sessions.push({
      id: uuid,
      directory: cwd,
      folder: folderLabel(cwd),
      cwd,
      attributed: !!cwd,
      lastActivity: new Date(lastTs).toISOString(),
      ts: lastTs,
      cost: sessCost,
      input: sessInput,
      output: sessOutput,
      cacheRead: sessCache,
      tokens: sessInput + sessOutput + sessCache,
      turns: rows.length,
      models: Array.from(modelStatsMap.values()).sort((a, b) => b.tokens - a.tokens),
    });
  }

  return sessions.sort((a, b) => b.ts - a.ts);
}

function normalise(sessionsList) {
  const dayMap = new Map();
  let totalCost = 0, totalInput = 0, totalOutput = 0, totalCache = 0, totalTurns = 0;

  for (const sess of sessionsList) {
    totalCost += sess.cost;
    totalInput += sess.input;
    totalOutput += sess.output;
    totalCache += sess.cacheRead;
    totalTurns += sess.turns;

    const day = sess.lastActivity ? sess.lastActivity.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dStat = dayMap.get(day) || { day, cost: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, turns: 0, modelMap: new Map() };
    dStat.cost += sess.cost;
    dStat.input += sess.input;
    dStat.output += sess.output;
    dStat.cacheRead += sess.cacheRead;
    dStat.tokens += sess.tokens;
    dStat.turns += sess.turns;
    for (const model of sess.models || []) {
      const m = dStat.modelMap.get(model.name) || {
        name: model.name, input: 0, output: 0, cacheRead: 0, tokens: 0, cost: 0,
      };
      m.input += model.input || 0;
      m.output += model.output || 0;
      m.cacheRead += model.cacheRead || 0;
      m.tokens += model.tokens || 0;
      m.cost += model.cost || 0;
      dStat.modelMap.set(model.name, m);
    }
    dayMap.set(day, dStat);
  }

  const daily = Array.from(dayMap.values())
    .map(({ modelMap, ...day }) => ({
      ...day,
      models: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const totals = {
    cost: totalCost,
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCache,
    tokens: totalInput + totalOutput + totalCache,
    turns: totalTurns,
  };

  // Antigravity's local stores expose measured usage, but no trustworthy account-quota API.
  return { daily, sessions: sessionsList, totals, quota: null };
}

function unavailable(reason, quota = null) {
  return {
    available: false,
    fetchedAt: null,
    stale: false,
    staleReason: reason,
    source: { name: 'Antigravity CLI', version: null },
    totals: null,
    daily: [],
    sessions: [],
    quota,
  };
}

function present(cache, now = Date.now()) {
  if (!cache?.data || cache.version !== CACHE_VERSION) return unavailable(cache?.error || 'Antigravity CLI cache requires refresh');
  const age = now - cache.at;
  const norm = normalise(cache.data.sessions || []);
  return {
    available: true,
    fetchedAt: cache.at,
    stale: age >= TTL_MS || !!cache.error,
    staleReason: cache.error || (age >= TTL_MS ? 'cache expired' : null),
    source: { name: 'Antigravity CLI', version: null },
    ...norm,
  };
}

function read() {
  return present(readCache(), Date.now());
}

async function refresh({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache?.version === CACHE_VERSION && cache?.data && Date.now() - cache.at < TTL_MS) return read();
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const sess = scanConversations();
      writeCache({ version: CACHE_VERSION, at: Date.now(), data: { sessions: sess }, error: null });
    } catch (err) {
      writeCache({
        ...(cache || {}),
        error: 'Gemini scan failed',
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
  present,
  scanConversations,
  parseGenMetadataBuf,
  costOf,
  CACHE_FILE,
  GEMINI_DIR,
  CONVERSATIONS_DIR,
  isConversationFile,
  TTL_MS,
  CACHE_VERSION,
};
