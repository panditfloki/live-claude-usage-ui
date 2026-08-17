'use strict';
// Gemini / Antigravity usage source.
// Reads Antigravity CLI conversation SQLite DBs (~/.gemini/antigravity-cli/conversations/*.db),
// transcripts, and history logs to normalize token/cost metrics and session attribution.

const { execFileSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GEMINI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CONVERSATIONS_DIR = path.join(GEMINI_DIR, 'conversations');
const HISTORY_FILE = path.join(GEMINI_DIR, 'history.jsonl');
const CACHE_FILE = path.join(os.tmpdir(), 'matra-gemini.json');
const QUOTA_CACHE_FILE = path.join(os.tmpdir(), 'matra-gemini-quota.json');
const CACHE_VERSION = 5;   // v5: real token counts (see parseGenMetadataBuf); v4 cached nulls
const TTL_MS = 5 * 60_000;
const QUOTA_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 4_000;

const PRICING = {
  // Standard paid-tier Gemini Developer API rates, per 1M tokens.
  // These produce an equivalent API-cost proxy; Antigravity itself may be subscription-backed.
  'gemini-3.6-flash': { in: 1.50, out: 7.50, cache: 0.15 },
  'gemini-3.5-flash': { in: 1.50, out: 9.00, cache: 0.15 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40, cache: 0.025 },
  'gemini-1.5-pro': { in: 1.25, out: 5.00, cache: 0.3125 },
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
  if (input == null || output == null || cache == null) return null;
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
    try { fs.unlinkSync(temp); } catch { }
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
        } catch { }
      }
    } catch { }
  }
  return map;
}

function parseGenMetadataBuf(buf) {
  let model = 'gemini-unknown';

  const str = buf.toString('utf8');
  const modelId = str.match(/gemini-\d+(?:\.\d+)+-[a-z0-9.-]+/i);
  const displayName = str.match(/Gemini\s+(\d+(?:\.\d+)*)\s+([A-Za-z][A-Za-z-]*)(?:\s+\(([^)]+)\))?/i);
  if (modelId) {
    model = modelId[0].toLowerCase();
  } else if (displayName) {
    model = `gemini-${displayName[1]}-${displayName[2]}`.toLowerCase();
    if (displayName[3]) model += `-${displayName[3].toLowerCase().replace(/\s+/g, '-')}`;
  }

  // ── Token counts: the schema, at last, from the horse's mouth ──────────────
  // 2026-08-13. Four earlier attempts guessed at these bytes and each produced
  // fabricated numbers. The schema was never actually unknown — it is compiled
  // into Antigravity's own `language_server_macos_arm` binary as protobuf
  // descriptors. Reading it there ended the guessing in one pass:
  //
  //   exa.cortex_pb.CortexStepGeneratorMetadata
  //     1        chat_model      (ChatModelMetadata)
  //     1.4      usage           (exa.codeium_common_pb.ModelUsageStats)
  //       1.4.1  model (ENUM)    ← the infamous constant "1071". A model ID,
  //                                not a token count. Identical on every blob
  //                                BY DEFINITION, which is exactly what the
  //                                first attempt mistook for a working parser.
  //       1.4.2  input_tokens
  //       1.4.3  output_tokens
  //       1.4.5  cache_read_tokens   ← missed by all four attempts; it is the
  //                                    single biggest number in real usage and
  //                                    its absence is why earlier plausibility
  //                                    checks read an impossible 57 chars/token
  //       1.4.9  thinking_output_tokens
  //       1.4.10 response_output_tokens
  //
  // ⚠️ TRAP: field 1.17 (retry_infos) carries a `usage` that MIRRORS 1.4
  // byte-for-byte. Walking the message generically double-counts every retry.
  // The path below is therefore walked deterministically — 1 → 4 → leaves —
  // and never searched. Do not "simplify" this into a recursive scan.
  //
  // Verified before shipping: 103/103 blobs satisfy output == thinking +
  // response; per-turn totals land at 3.1–5.8 chars/token (real tokenisation);
  // and the smallest and largest turns differ 6.3×, the proportionality test
  // that caught all three previous fabrications.
  const usage = usageFromBuf(buf);
  return {
    model,
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    cache: usage?.cacheRead ?? null,
    thinking: usage?.thinking ?? null,
    timestamp: 0,
  };
}

// Minimal protobuf wire-format reader. Only what this one path needs — no
// dependency, and nothing that could wander into the retry_infos mirror.
function* wireFields(b) {
  let i = 0;
  while (i < b.length) {
    let key = 0, shift = 0, byte;
    do {
      if (i >= b.length) return;
      byte = b[i++]; key |= (byte & 0x7f) << shift; shift += 7;
    } while (byte & 0x80);
    const field = key >>> 3, type = key & 7;
    if (type === 0) {
      let v = 0; shift = 0;
      do {
        if (i >= b.length) return;
        byte = b[i++]; v += (byte & 0x7f) * Math.pow(2, shift); shift += 7;
      } while (byte & 0x80);
      yield [field, 0, v];
    } else if (type === 2) {
      let len = 0; shift = 0;
      do {
        if (i >= b.length) return;
        byte = b[i++]; len |= (byte & 0x7f) << shift; shift += 7;
      } while (byte & 0x80);
      if (len < 0 || i + len > b.length) return;
      yield [field, 2, b.subarray(i, i + len)]; i += len;
    } else if (type === 5) { i += 4; }
    else if (type === 1) { i += 8; }
    else return;                       // groups: unused here, and unparseable
  }
}

const USAGE_FIELDS = { 2: 'input', 3: 'output', 5: 'cacheRead', 9: 'thinking', 10: 'response' };

function usageFromBuf(buf) {
  try {
    for (const [f1, t1, chatModel] of wireFields(buf)) {
      if (f1 !== 1 || t1 !== 2) continue;                 // chat_model only
      for (const [f2, t2, usageMsg] of wireFields(chatModel)) {
        if (f2 !== 4 || t2 !== 2) continue;               // usage only
        const found = {};
        for (const [f3, t3, v] of wireFields(usageMsg)) {
          if (t3 === 0 && USAGE_FIELDS[f3]) found[USAGE_FIELDS[f3]] = v;
        }
        // A usage message carrying no token field at all is unknown, not zero.
        if (!Object.keys(found).length) return null;
        // But WITHIN a usage message, an absent numeric field means zero —
        // protobuf omits default values on the wire. Treating "absent" as
        // unknown here made costOf() return null for any turn that simply had
        // no cache hit, silently dropping real spend from the totals.
        return {
          input: found.input ?? 0,
          output: found.output ?? 0,
          cacheRead: found.cacheRead ?? 0,
          thinking: found.thinking ?? 0,
          response: found.response ?? 0,
        };
      }
    }
  } catch { /* malformed blob → unknown, never a fabricated zero */ }
  return null;
}

function scanConversations() {
  const cwds = cwdMap();
  let files = [];
  try { files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.db')); } catch { return []; }

  const sessions = [];
  // Every read below shells out to sqlite3. If that binary is missing — routine
  // on Windows, where this has never been tested — each read throws, every
  // conversation is skipped, and the dashboard reports zero Gemini sessions:
  // "you used nothing" instead of "I could not read it". Distinguish the two.
  let sqliteFailures = 0;

  for (const f of files) {
    const fullPath = path.join(CONVERSATIONS_DIR, f);
    const uuid = f.replace('.db', '').toLowerCase();
    const stat = fs.statSync(fullPath);
    const cwd = cwds.get(uuid) || null;

    let rows = [];
    try {
      const raw = execFileSync('sqlite3', [fullPath, 'SELECT hex(data) FROM gen_metadata;'], { encoding: 'utf8', timeout: TIMEOUT_MS });
      rows = raw.trim().split('\n').filter(Boolean);
    } catch (err) {
      // ENOENT is "no sqlite3 on this machine"; anything else is one bad file.
      if (err && (err.code === 'ENOENT' || /ENOENT|not found|not recognized/i.test(String(err.message)))) sqliteFailures++;
    }

    if (!rows.length) continue;

    let sessInput = null, sessOutput = null, sessCache = null, sessCost = null, lastTs = stat.mtimeMs;
    const modelStatsMap = new Map();

    for (const r of rows) {
      const parsed = parseGenMetadataBuf(Buffer.from(r, 'hex'));
      const turnCost = costOf(parsed.model, parsed.input, parsed.output, parsed.cache);

      if (parsed.input != null) sessInput = (sessInput || 0) + parsed.input;
      if (parsed.output != null) sessOutput = (sessOutput || 0) + parsed.output;
      if (parsed.cache != null) sessCache = (sessCache || 0) + parsed.cache;
      if (turnCost != null) sessCost = (sessCost || 0) + turnCost;
      if (parsed.timestamp > 0) lastTs = Math.max(lastTs, parsed.timestamp);

      const mKey = parsed.model;
      const mStat = modelStatsMap.get(mKey) || { name: mKey, input: null, output: null, cacheRead: null, tokens: null, cost: null };
      if (parsed.input != null) mStat.input = (mStat.input || 0) + parsed.input;
      if (parsed.output != null) mStat.output = (mStat.output || 0) + parsed.output;
      if (parsed.cache != null) mStat.cacheRead = (mStat.cacheRead || 0) + parsed.cache;
      if (parsed.input != null || parsed.output != null || parsed.cache != null) {
        mStat.tokens = (mStat.tokens || 0) + (parsed.input || 0) + (parsed.output || 0) + (parsed.cache || 0);
      }
      if (turnCost != null) mStat.cost = (mStat.cost || 0) + turnCost;
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
      tokens: (sessInput != null || sessOutput != null || sessCache != null) ? ((sessInput || 0) + (sessOutput || 0) + (sessCache || 0)) : null,
      turns: rows.length,
      models: Array.from(modelStatsMap.values()).sort((a, b) => (b.tokens || 0) - (a.tokens || 0)),
    });
  }

  // Files present, none readable, and sqlite3 is the reason: that is a broken
  // install, not an idle account. Fail loudly rather than reporting an
  // authoritative zero.
  if (!sessions.length && sqliteFailures === files.length && files.length) {
    const err = new Error('sqlite3 not found — Gemini token/cost needs it on PATH (untested on Windows)');
    err.code = 'ENOSQLITE';
    throw err;
  }

  return sessions.sort((a, b) => b.ts - a.ts);
}

// ── Live account quota ──────────────────────────────────────────────────────
// Unlike token/cost (undocumented protobuf, no schema — see parseGenMetadataBuf),
// quota % comes from Antigravity's OWN internal RPC service: the exact endpoint
// its own UI calls. Same trick quota.js already uses for Claude — read a token
// the running process already has, then call the real API with it. No guessing.
//
// Mechanism (reverse-engineered from the open-source `ag-usage` extension,
// which two independent developers implemented the same way — corroboration,
// not a single unverified source):
//   1. `ps` for the Antigravity `language_server` process; its --csrf_token
//      argument is already right there in the command line.
//   2. `lsof` for that PID's listening TCP ports (macOS only, matching the
//      existing macOS-first pattern in quota.js's Keychain path).
//   3. POST an empty JSON body to each candidate port's
//      /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//      — Connect-RPC over plain JSON, not binary protobuf, so the response is
//      just JSON.parse(), no decoding involved. Try https then http per port;
//      Antigravity's local listener has been observed on either.
const CSRF_RE = /--csrf_token[=\s]+"([^"]+)"|--csrf_token[=\s]+'([^']+)'|--csrf_token[=\s]+([^\s"']+)/i;

// `ps -eo` and `lsof` are Unix-only, and there is no platform guard further
// down: on Windows both simply throw, discovery returns nothing, and the user
// is told "is Antigravity running?" — a confident, wrong diagnosis of a machine
// where this was never going to work. Same failure shape as the unpriced-model
// $0 and the bare-PATH launchd exit 127: silence that reads as a real answer.
// Say the true reason instead. (Windows support would need `tasklist /v` +
// `netstat -ano`; nobody has written or tested that.)
const RPC_SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

function findLanguageServerProcess() {
  if (!RPC_SUPPORTED) return null;
  let out;
  try { out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', timeout: 5_000 }); }
  catch { return null; }
  const candidates = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, pidStr, cmd] = m;
    if (!cmd.includes('language_server')) continue;
    const csrf = CSRF_RE.exec(cmd);
    if (!csrf) continue;
    candidates.push({ pid: Number(pidStr), cmd, csrfToken: csrf[1] || csrf[2] || csrf[3] });
  }
  if (!candidates.length) return null;
  // Prefer a standalone Antigravity-branded server if more than one is running.
  const score = c => (c.cmd.includes('--standalone') ? 2 : 0) + (c.cmd.toLowerCase().includes('antigravity') ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a) || b.pid - a.pid);
  return candidates[0];
}

function listeningPorts(pid) {
  let out;
  try { out = execFileSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }); }
  catch { return []; }
  const ports = new Set();
  for (const m of out.matchAll(/:(\d+)\s+\(LISTEN\)/g)) ports.add(Number(m[1]));
  return [...ports];
}

// ⚠️ SECURITY — why this sends the CSRF token to almost nothing.
//
// The language_server holds 30+ listening ports because Antigravity FORWARDS
// USER PORTS through the same pid. On this machine that set includes Mātrā's
// own :4317 and Lekhā's :4318. The original implementation POSTed the CSRF
// token to every one of them and relied on JSON.parse() throwing on the HTML
// they return — which is an accident, not a safeguard. Measured 2026-08-13:
//   POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//   → :4317 HTTP 200 text/html   → :4318 HTTP 200 text/html
// Both received the token. This is a PUBLIC repo, so every clone would spray
// its user's token across whatever else that user runs on localhost.
//
// So the token is now withheld until a port has proved it speaks Connect-RPC,
// using an UNAUTHENTICATED probe that carries no secret at all. A JSON
// content-type is the discriminator: Connect-RPC always answers JSON (200 or
// error alike), while an ordinary web app answers HTML.
function httpRequest({ scheme, port, method, headers, body, wantJson }) {
  return new Promise((resolve, reject) => {
    const req = (scheme === 'https' ? https : http).request({
      hostname: '127.0.0.1', port, path: method, method: 'POST',
      rejectUnauthorized: false, headers, timeout: RPC_TIMEOUT_MS,
    }, res => {
      const ctype = String(res.headers['content-type'] || '');
      // Bail out before reading a body from something that is not this RPC.
      if (wantJson && !/application\/json|application\/connect/i.test(ctype)) {
        res.resume();
        return reject(new Error(`not a Connect-RPC endpoint (content-type: ${ctype || 'none'})`));
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, ctype, data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Carries NO token. Its only job is to decide whether this port is worth
// trusting with one. Any JSON answer — including 401/403 — proves Connect-RPC.
async function probeIsRpc(scheme, port, method) {
  const res = await httpRequest({
    scheme, port, method, body: '{}', wantJson: true,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': 2,
      'Connect-Protocol-Version': '1',
    },
  });
  return { scheme, port, status: res.status };
}

async function rpcCall(scheme, port, csrfToken, method) {
  const body = '{}';
  const res = await httpRequest({
    scheme, port, method, body, wantJson: true,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Codeium-Csrf-Token': csrfToken,
      'Connect-Protocol-Version': '1',
    },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const parsed = JSON.parse(res.data);
  if (!parsed || typeof parsed !== 'object') throw new Error('RPC returned a non-object');
  return parsed;
}

const RETRIEVE_USER_QUOTA_SUMMARY = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

// The language_server can hold 30+ listening ports (Antigravity also forwards
// user ports through the same process), and only one speaks this RPC. Probing
// them SEQUENTIALLY is the difference between ~200ms and several minutes, so
// every candidate is raced in parallel and the first success wins.
async function callAntigravityRpc(method) {
  if (!RPC_SUPPORTED) {
    throw new Error(`Gemini quota needs ps/lsof — not supported on ${process.platform} (untested; macOS and Linux only)`);
  }
  const proc = findLanguageServerProcess();
  if (!proc) throw new Error('Antigravity language_server process not found (is Antigravity running?)');
  const ports = listeningPorts(proc.pid);
  if (!ports.length) throw new Error('no listening ports found for the Antigravity process');

  // Phase 1 — narrow the field WITHOUT revealing the token. Every candidate is
  // probed in parallel: 30+ sequential 4s probes take minutes, which is what
  // made an early console test look like a hang.
  //
  // ⚠️ Keep ALL the JSON responders, not the first. Measured on this Mac: of 27
  // candidate ports, SIX speak Connect-RPC and only TWO accept the token — the
  // rest answer 401/405 even with a valid one. An unauthenticated probe cannot
  // tell those apart, so picking a single winner here loses the endpoint
  // roughly two times in three, with no fallback. That regression is what made
  // the dashboard serve a stale 100% with staleReason "HTTP 401".
  // Each candidate runs its OWN probe→authenticate chain, and the chains race.
  // Waiting for every probe to settle before authenticating anything costs the
  // full timeout of the slowest dead port — measured at 8s here, against ~200ms
  // for the race. Phase 2 of a losing chain simply never runs.
  const chains = [];
  for (const port of ports) {
    for (const scheme of ['https', 'http']) {
      chains.push(
        probeIsRpc(scheme, port, method)
          // Phase 2 — the token is sent only after THIS port has proved it
          // speaks Connect-RPC, so a forwarded user port serving HTML
          // (Mātrā's :4317, Lekhā's :4318) never sees it.
          .then(() => rpcCall(scheme, port, proc.csrfToken, method)),
      );
    }
  }
  try {
    return await Promise.any(chains);
  } catch {
    throw new Error(`no Connect-RPC endpoint accepted the token (${ports.length} ports probed)`);
  }
}

// remainingFraction is 0 (empty) .. 1 (full). Reported as-is — see the
// DIRECTION note above; Gemini bars are "left", not "used".
function remainingPercent(remainingFraction) {
  const f = parseFloat(remainingFraction);
  if (!Number.isFinite(f)) return null;
  return Math.round(Math.max(0, Math.min(1, f)) * 100);
}

function resetMs(resetTime) {
  if (resetTime == null) return null;
  const t = typeof resetTime === 'number' ? resetTime : Date.parse(resetTime);
  return Number.isFinite(t) ? t : null;
}

// ⚠️ DIRECTION: Antigravity reports REMAINING ("Five Hour Limit Remaining",
// 70% = 70% left), and Mātrā shows it AS remaining — his call, 2026-08-13, so
// the number matches the AG Usage / Antigravity Panel extensions on screen.
// This is the OPPOSITE direction from Mātrā's Claude/Codex bars, which are
// USED (83% = 83% burnt). Because the two directions coexist on one dashboard,
// every Gemini label must carry the word "left" — an unlabelled 70% next to
// Claude's 83% would read as the same kind of number when it is the inverse.
function windowOf(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('week')) return { label: 'weekly', windowMs: 7 * 24 * 3600e3, group: 'weekly' };
  if (t.includes('five hour') || t.includes('5 hour') || t.includes('5h')) return { label: '5-hour', windowMs: 5 * 3600e3, group: 'session' };
  return { label: String(text || 'window').replace(/\s*limit\s*remaining\s*$/i, '').trim() || 'window', windowMs: null, group: 'rolling' };
}

// Antigravity meters two legs — Gemini models, and an "other" leg for the
// Claude/GPT models it can also route to. Only the Gemini leg is kept.
//
// ⚠️ The "other" leg is deliberately DROPPED (his call, 2026-08-13). He drives
// Claude through Claude Code and GPT through Codex, never through Antigravity,
// so that leg reads a permanent 100% and is pure noise — worse, sitting beside
// Mātrā's real Claude/Codex bars it invites the reading that Claude is fine
// when the number is simply unused. Mātrā already meters those two providers
// properly; a second, always-full copy of them is a liability, not a feature.
function quotaShapeFromResponse(body) {
  const groups = body?.response?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const rows = [];
  for (const g of groups) {
    const name = String(g.displayName || '').toLowerCase();
    if (!name.includes('gemini') && !name.includes('flash')) continue;   // drop the "other" leg
    for (const b of g.buckets || []) {
      const percent = remainingPercent(b.remainingFraction);
      if (percent === null) continue;
      const win = windowOf(b.displayName || b.window || b.bucketId || g.displayName);
      rows.push({ ...win, percent, resetsAt: resetMs(b.resetTime) });
    }
  }

  // Both windows are kept, mirroring how Claude shows session AND weekly
  // rather than collapsing to whichever is worst.
  const limits = [];
  const seen = new Set();
  for (const r of rows.sort((a, b) => (a.windowMs || 0) - (b.windowMs || 0))) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    limits.push({
      kind: 'gemini', group: r.group,
      label: `Gemini · ${r.label} left`,
      percent: r.percent, windowMs: r.windowMs, resetsAt: r.resetsAt,
      // Consumers must not treat this like a Claude/Codex "used" percent —
      // a full bar here is GOOD, not a warning.
      remaining: true,
    });
  }
  if (!limits.length) return null;
  return { plan: null, fetchedAt: Date.now(), limits, credits: { hasCredits: false, unlimited: false, balance: null } };
}

function readQuotaCache() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

function writeQuotaCache(data) {
  const temp = `${QUOTA_CACHE_FILE}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(data)); fs.renameSync(temp, QUOTA_CACHE_FILE); }
  catch { try { fs.unlinkSync(temp); } catch { } }
}

// ── Estimated subscription-value (declared price ÷ quota window) ───────────
// ⚠️ 2026-08-13, his explicit call, same day as the note below: reverses the
// "never converted to money" line — but NOT the same fabrication. The three
// dead-end attempts this file's history log describes were all trying to
// MEASURE token/cost from undocumented protobuf; they were guesses dressed as
// data. This is different in kind: it takes a price HE TYPES (plan.json's
// geminiPriceUsd, same "declared" category as Claude's priceUsd) and spreads
// it linearly across the real, live quota %. It never claims to be Google's
// bill — it is labelled "estimated subscription-value equivalent" everywhere
// it is shown, kept out of every real-cost total (dashboard.js's `cost`
// aggregation must never add this in), and returns null the instant
// geminiPriceUsd is unset. Token/cost themselves stay null forever — see below.
// The price is kept in the currency it was DECLARED in and never round-tripped
// through USD. He pays ₹1,950/mo; converting that to dollars to do the maths and
// back to rupees for display would make the number drift with the FX rate every
// day, for a figure that in reality does not move at all.
function estimatedValueFor(limit, cfg) {
  if (cfg.geminiPrice == null || limit.percent == null || !limit.windowMs) return null;
  const windowsPerMonth = (30 * 24 * 3600e3) / limit.windowMs;
  const valuePerWindow = cfg.geminiPrice / windowsPerMonth;
  const remaining = valuePerWindow * (limit.percent / 100);
  return {
    remaining: Math.round(remaining * 100) / 100,
    used: Math.round((valuePerWindow - remaining) * 100) / 100,
    window: Math.round(valuePerWindow * 100) / 100,
    currency: cfg.geminiPriceCurrency,
    method: 'linear-proportional: declared plan price ÷ windows-per-month, split by remaining %',
    label: 'Estimated subscription-value equivalent',
  };
}

// Estimated value of what was actually BURNED, rather than what is left.
// This is the figure the dashboard's Today / Selected-range slots want: it moves
// with real usage instead of with the calendar, because pp comes from polling
// the live quota and differencing it.
//
// Its honesty lives in `burned` — pp is null when there are too few samples, and
// gapMs records stretches where nothing was watching (IDE closed). Both are
// carried through untouched so the UI can say "≈ $2.40 · 6h unobserved" rather
// than quietly implying the number is complete.
// Below this, "0 pp burned" cannot be distinguished from "nothing was watching",
// and a confident ₹0.00 is exactly the failure this project has hit three times
// (unpriced model → $0, null → 0 by coercion, bare PATH → stale-but-plausible).
// Two samples five minutes apart say nothing about a five-hour window.
const MIN_SAMPLES = 3;
const MIN_OBSERVED_FRACTION = 0.05;

function estimatedSpendFrom(burned, windowMs, cfg) {
  if (cfg.geminiPrice == null || !burned || burned.pp == null) return null;
  // A zero is only publishable when enough of the window was actually observed.
  // Real burn (pp > 0) is always publishable — it was, by definition, seen.
  if (burned.pp === 0
      && (burned.samples < MIN_SAMPLES
          || (burned.observedMs || 0) < windowMs * MIN_OBSERVED_FRACTION)) {
    return null;
  }
  const windowsPerMonth = (30 * 24 * 3600e3) / windowMs;
  const valuePerWindow = cfg.geminiPrice / windowsPerMonth;
  return {
    amount: Math.round(valuePerWindow * (burned.pp / 100) * 100) / 100,
    currency: cfg.geminiPriceCurrency,
    pp: burned.pp,
    samples: burned.samples,
    gapMs: burned.gapMs,
    resets: burned.resets,
    method: 'percentage-points actually burned × declared plan price per point',
    label: 'Estimated subscription-value equivalent',
  };
}

function planConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return {
      geminiPrice: cfg.geminiPrice ?? null,
      geminiPriceCurrency: cfg.geminiPriceCurrency || 'USD',
      geminiBillingPeriod: cfg.geminiBillingPeriod || 'month',
      forexMarkupPercent: cfg.forexMarkupPercent ?? 0,
    };
  } catch { return { geminiPrice: null, geminiPriceCurrency: 'USD', geminiBillingPeriod: 'month', forexMarkupPercent: 0 }; }
}

// ── Consumption in percentage points ────────────────────────────────────────
// There is no measured dollar or token figure to be had for Gemini. Antigravity's
// own panel does not have one either: its "consumed: 0.0 pp" is percentage
// POINTS, derived by polling the quota level and differencing it — which is why
// that extension also says "No sampling data (IDE was closed)".
//
// Mātrā does the same thing, and labels it the same way. This is a DERIVED
// figure with holes in it, not a bill: it only sees what it was running for.
// Reported as pp, never converted to money by MEASURING usage — that guess is
// still refused. (The declared-price estimate above is a different thing: a
// number he typed, not a number this file inferred from opaque bytes.)
const QUOTA_HISTORY_FILE = path.join(os.homedir(), '.matra', 'gemini-quota-history.json');
const HISTORY_KEEP_MS = 8 * 24 * 3600e3;      // slightly over a week
// Two samples further apart than this cannot be assumed continuous — the gap
// is counted as unobserved rather than silently treated as zero burn.
const MAX_SAMPLE_GAP_MS = 20 * 60_000;

function readHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_HISTORY_FILE, 'utf8'));
    return Array.isArray(raw?.samples) ? raw.samples : [];
  } catch { return []; }
}

function writeHistory(samples) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_HISTORY_FILE), { recursive: true });
    const temp = `${QUOTA_HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ samples }));
    fs.renameSync(temp, QUOTA_HISTORY_FILE);
  } catch { }
}

// One sample per successful quota read: the remaining % of each window.
function recordSample(quota, now = Date.now()) {
  if (!quota?.limits?.length) return;
  const point = { at: now };
  for (const l of quota.limits) {
    if (l.group === 'session') point.session = l.percent;
    if (l.group === 'weekly') point.weekly = l.percent;
  }
  if (point.session == null && point.weekly == null) return;

  const samples = readHistory();
  const last = samples[samples.length - 1];
  // The quota TTL is 5 minutes; anything tighter is the same reading twice.
  if (last && now - last.at < 60_000) return;
  samples.push(point);
  writeHistory(samples.filter(s => now - s.at <= HISTORY_KEEP_MS));
}

// Percentage points burned over a window. Only DROPS in remaining count as
// consumption — a rise means the window reset, which is not negative usage.
function consumption(windowMs, field = 'session', now = Date.now()) {
  const samples = readHistory().filter(s => s[field] != null && now - s.at <= windowMs);
  if (samples.length < 2) {
    return { pp: null, samples: samples.length, observedMs: 0, gapMs: windowMs, resets: 0 };
  }
  let pp = 0, observedMs = 0, resets = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].at - samples[i - 1].at;
    if (dt > MAX_SAMPLE_GAP_MS) continue;            // unobserved stretch
    observedMs += dt;
    const delta = samples[i - 1][field] - samples[i][field];
    if (delta > 0) pp += delta;
    else if (delta < -5) resets++;                    // refill, not usage
  }
  const span = now - samples[0].at;
  return {
    pp: Math.round(pp * 10) / 10,
    samples: samples.length,
    observedMs,
    gapMs: Math.max(0, span - observedMs),
    resets,
  };
}

let quotaRefreshing = null;

// Same soft-fail contract as quota.js: any failure serves the last good
// reading, tagged stale, rather than blanking the quota bar. This endpoint is
// undocumented and internal — it can vanish in any Antigravity release.
async function refreshQuota({ force = false } = {}) {
  const cache = readQuotaCache();
  if (!force && cache?.quota && Date.now() - (cache.at || 0) < QUOTA_TTL_MS) return cache.quota;
  if (quotaRefreshing) return quotaRefreshing;

  quotaRefreshing = (async () => {
    try {
      const body = await callAntigravityRpc(RETRIEVE_USER_QUOTA_SUMMARY);
      const quota = quotaShapeFromResponse(body);
      if (!quota) throw new Error('quota response had no usable groups');
      writeQuotaCache({ at: Date.now(), quota, error: null });
      // Sample only on a genuinely fresh reading — replaying a cached one would
      // invent a flat stretch that was never observed.
      recordSample(quota);
      return quota;
    } catch (err) {
      const stale = cache?.quota ? { ...cache.quota, stale: true, staleReason: String(err.message || err) } : null;
      writeQuotaCache({ ...(cache || {}), error: String(err.message || err) });
      return stale;
    } finally {
      quotaRefreshing = null;
    }
  })();
  return quotaRefreshing;
}

function readQuota() {
  const cache = readQuotaCache();
  if (!cache?.quota) return null;
  const age = Date.now() - (cache.at || 0);
  const base = (age >= QUOTA_TTL_MS || cache.error)
    ? { ...cache.quota, stale: true, staleReason: cache.error || 'cache expired' }
    : cache.quota;
  // pp burned is the only MEASURED "amount" Gemini can honestly produce — see
  // the consumption note above. Attached here so the UI never has to compute it.
  //
  // estimatedValue is applied on READ, never baked into the quota cache —
  // same reason as quota.js's plan.json decoration: editing geminiPriceUsd
  // must show up immediately, not wait out the 5-minute quota TTL.
  const cfg = planConfig();
  const burned = {
    session5h: consumption(5 * 3600e3, 'session'),
    day: consumption(24 * 3600e3, 'session'),
    week: consumption(7 * 24 * 3600e3, 'weekly'),
  };
  return {
    ...base,
    limits: (base.limits || []).map(l => ({ ...l, estimatedValue: estimatedValueFor(l, cfg) })),
    burned,
    // The spend figures the dashboard's cost slots read. `allTime` is deliberately
    // absent, not zero: the sample history is pruned to ~8 days, so there is no
    // honest all-time number to give and inventing one would be the exact
    // fabrication this file exists to refuse.
    estimatedSpend: {
      session5h: estimatedSpendFrom(burned.session5h, 5 * 3600e3, cfg),
      day: estimatedSpendFrom(burned.day, 5 * 3600e3, cfg),
      week: estimatedSpendFrom(burned.week, 7 * 24 * 3600e3, cfg),
      priceDeclared: cfg.geminiPrice != null,
      price: cfg.geminiPrice,
      currency: cfg.geminiPriceCurrency,
      billingPeriod: cfg.geminiBillingPeriod,
      historyDays: Math.round(HISTORY_KEEP_MS / 864e5),
    },
  };
}

function normalise(sessionsList) {
  const dayMap = new Map();
  let totalCost = null, totalInput = null, totalOutput = null, totalCache = null, totalTurns = 0;

  for (const sess of sessionsList) {
    if (sess.cost != null) totalCost = (totalCost || 0) + sess.cost;
    if (sess.input != null) totalInput = (totalInput || 0) + sess.input;
    if (sess.output != null) totalOutput = (totalOutput || 0) + sess.output;
    if (sess.cacheRead != null) totalCache = (totalCache || 0) + sess.cacheRead;
    totalTurns += sess.turns;

    const day = sess.lastActivity ? sess.lastActivity.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dStat = dayMap.get(day) || { day, cost: null, input: null, output: null, cacheRead: null, tokens: null, turns: 0, modelMap: new Map() };
    if (sess.cost != null) dStat.cost = (dStat.cost || 0) + sess.cost;
    if (sess.input != null) dStat.input = (dStat.input || 0) + sess.input;
    if (sess.output != null) dStat.output = (dStat.output || 0) + sess.output;
    if (sess.cacheRead != null) dStat.cacheRead = (dStat.cacheRead || 0) + sess.cacheRead;
    if (sess.tokens != null) dStat.tokens = (dStat.tokens || 0) + sess.tokens;
    dStat.turns += sess.turns;
    for (const model of sess.models || []) {
      const m = dStat.modelMap.get(model.name) || {
        name: model.name, input: null, output: null, cacheRead: null, tokens: null, cost: null,
      };
      if (model.input != null) m.input = (m.input || 0) + model.input;
      if (model.output != null) m.output = (m.output || 0) + model.output;
      if (model.cacheRead != null) m.cacheRead = (m.cacheRead || 0) + model.cacheRead;
      if (model.tokens != null) m.tokens = (m.tokens || 0) + model.tokens;
      if (model.cost != null) m.cost = (m.cost || 0) + model.cost;
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
    tokens: (totalInput != null || totalOutput != null || totalCache != null) ? ((totalInput || 0) + (totalOutput || 0) + (totalCache || 0)) : null,
    turns: totalTurns,
  };

  // Token/cost stay unverified (see parseGenMetadataBuf). Quota is real — see
  // refreshQuota/readQuota below — and is attached by present(), not here, so
  // normalise() stays a pure function of session data for its own tests.
  return { daily, sessions: sessionsList, totals };
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

function present(cache, quota, now = Date.now()) {
  if (!cache?.data || cache.version !== CACHE_VERSION) return unavailable(cache?.error || 'Antigravity CLI cache requires refresh', quota);
  const age = now - cache.at;
  const norm = normalise(cache.data.sessions || []);
  return {
    available: true,
    fetchedAt: cache.at,
    stale: age >= TTL_MS || !!cache.error,
    staleReason: cache.error || (age >= TTL_MS ? 'cache expired' : null),
    source: { name: 'Antigravity CLI', version: null },
    ...norm,
    quota,
  };
}

function read() {
  return present(readCache(), readQuota(), Date.now());
}

async function refresh({ force = false } = {}) {
  const cache = readCache();
  const needsSessionRefresh = force || cache?.version !== CACHE_VERSION || !cache?.data || Date.now() - cache.at >= TTL_MS;
  // Quota has its own TTL/cache and is deliberately never blocked on the
  // (slower, sqlite-shelling) session refresh below — the status bar % should
  // update every five minutes even if nothing new was said to Gemini today.
  const quotaPromise = refreshQuota({ force });

  if (!needsSessionRefresh) { await quotaPromise; return read(); }
  if (refreshing) { await Promise.all([refreshing, quotaPromise]); return read(); }

  refreshing = (async () => {
    try {
      const sess = scanConversations();
      writeCache({ version: CACHE_VERSION, at: Date.now(), data: { sessions: sess }, error: null });
    } catch (err) {
      // Keep the real reason. A blanket "Gemini scan failed" turns "sqlite3 is
      // not installed" into an unactionable shrug the user cannot fix.
      writeCache({
        ...(cache || {}),
        error: err && err.message ? err.message : 'Gemini scan failed',
      });
    } finally {
      refreshing = null;
    }
  })();
  await Promise.all([refreshing, quotaPromise]);
  return read();
}

module.exports = {
  read,
  refresh,
  normalise,
  present,
  scanConversations,
  parseGenMetadataBuf,
  costOf,
  // Live quota (RetrieveUserQuotaSummary over Antigravity's own local RPC).
  refreshQuota,
  readQuota,
  quotaShapeFromResponse,
  recordSample,
  consumption,
  readHistory,
  estimatedValueFor,
  estimatedSpendFrom,
  planConfig,
  QUOTA_HISTORY_FILE,
  findLanguageServerProcess,
  listeningPorts,
  probeIsRpc,
  rpcCall,
  remainingPercent,
  resetMs,
  CACHE_FILE,
  QUOTA_CACHE_FILE,
  GEMINI_DIR,
  CONVERSATIONS_DIR,
  isConversationFile,
  TTL_MS,
  QUOTA_TTL_MS,
  CACHE_VERSION,
};
