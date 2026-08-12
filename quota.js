'use strict';
// Real plan quota — session / weekly / per-model utilisation and reset times.
//
// This is the ONE thing that cannot be derived from local transcripts: the
// quota lives server-side. Claude Code's own /usage command reads it from
// GET /api/oauth/usage, authenticated with the OAuth token in the OS keychain.
//
// ⚠️ That endpoint is INTERNAL AND UNDOCUMENTED. Anthropic may change or remove
// it in any Claude Code release. Every failure here is therefore soft: we return
// null and the caller falls back to the transcript-derived estimate. The quota
// bars disappearing must never take the rest of the dashboard down with them.
//
// The access token is read at request time, held only in a local, and is never
// logged, persisted, or sent anywhere except api.anthropic.com.
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';

// This endpoint is built for on-demand use (Claude Code hits it when you type
// /usage), NOT for polling — it rate-limits hard and its Retry-After is 0, which
// is useless. Percentages move slowly and the client ticks the reset countdown
// locally from `resetsAt`, so a long TTL costs nothing and keeps us under the cap.
const TTL_MS = 15 * 60_000;
const PROFILE_TTL_MS = 6 * 3600_000;   // plan/tier/status is effectively static
const TIMEOUT_MS = 6_000;
const BACKOFF_MS = 5 * 60_000;         // first 429 with a value already cached
const BACKOFF_MAX_MS = 40 * 60_000;    // ceiling for the exponential
const COLD_BACKOFF_MS = 60_000;        // 429 with nothing to show — retry, but gently

// The dashboard runs in two processes at once (dev server + extension host).
// Without a shared cache they poll independently and double the request rate —
// which is exactly how the first 429 happened. One file, one poller's worth of load.
//
// ⚠️ The BACKOFF must be shared too, not just the data. Each process keeping its
// own in-memory nextTryAt caused a live deadlock: once the cache went stale, BOTH
// processes retried on their own clocks, kept tripping the limiter for each
// other, and the cache stayed stale for hours. Whoever gets 429'd now writes the
// backoff to the same file, so the pair behaves like one polite client.
const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-meter-quota.json');
const LOCK_FILE = `${CACHE_FILE}.lock`;
const LOCK_MAX_AGE_MS = 15_000;
const LOCK_WAIT_MS = 8_000;

let mem = null;          // { at, data, nextTryAt?, failStreak? }
let profileCache = null; // { at, data }
let refreshing = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function maskAccount(value) {
  if (!value) return null;
  const text = String(value);
  const at = text.indexOf('@');
  if (at < 0) return text.length <= 8 ? text : `${text.slice(0, 4)}…${text.slice(-4)}`;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const shown = local.length <= 2 ? local[0] || '*' : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, Math.min(3, local.length - shown.length)))}@${domain}`;
}

function accountMeta(tok = null) {
  let account = null;
  try {
    account = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount || null;
  } catch {}
  const stable = account?.accountUuid || account?.organizationUuid || account?.emailAddress || tok;
  if (!stable) return { key: null, display: null };
  return {
    key: crypto.createHash('sha256').update(String(stable)).digest('hex').slice(0, 24),
    display: maskAccount(account?.emailAddress),
  };
}

function cacheMatches(cache, accountKey) {
  return !!cache && !!accountKey && cache.accountKey === accountKey;
}

// Always take the NEWER of our in-memory copy and the file — the other process
// may have refreshed it since. Preferring `mem` blindly would make one process
// poll on a stale clock and re-trigger the 429 we're trying to avoid.
function readCache(accountKey = null) {
  let disk = null;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && (c.at || c.nextTryAt)) disk = c;
  } catch {}
  if (disk && (!mem || (disk.at || 0) > (mem.at || 0) || (disk.nextTryAt || 0) > (mem.nextTryAt || 0))) {
    mem = disk;
  }
  if (accountKey && !cacheMatches(mem, accountKey)) return null;
  return mem;
}

function writeCache(patch) {
  // Merge, don't replace — a backoff write must not clobber the cached data,
  // and a data write resets the backoff (success = the limiter is happy).
  const existing = readCache();
  const cur = patch.accountKey && existing?.accountKey !== patch.accountKey ? {} : (existing || {});
  mem = { ...cur, ...patch };
  const temp = `${CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(mem));
    fs.renameSync(temp, CACHE_FILE);
  } catch {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function sharedNextTryAt(accountKey) {
  const c = readCache(accountKey);
  return (c && c.nextTryAt) || 0;
}

function noteRateLimited(accountKey) {
  const c = readCache(accountKey) || { accountKey };
  const streak = (c.failStreak || 0) + 1;
  const hasData = !!c.data;
  // Exponential: 5 → 10 → 20 → 40 min (cold start stays gentle but linear-ish).
  const base = hasData ? BACKOFF_MS : COLD_BACKOFF_MS;
  const wait = Math.min(base * Math.pow(2, streak - 1), BACKOFF_MAX_MS);
  writeCache({ accountKey, nextTryAt: Date.now() + wait, failStreak: streak });
}

function removeStaleLock(now = Date.now()) {
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (now - stat.mtimeMs > LOCK_MAX_AGE_MS) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

function acquireLock() {
  removeStaleLock();
  try {
    const owner = `${process.pid}:${crypto.randomUUID()}`;
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ owner, at: Date.now() }));
    return () => {
      try { fs.closeSync(fd); } catch {}
      try {
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (lock.owner === owner) fs.unlinkSync(LOCK_FILE);
      } catch {}
    };
  } catch { return null; }
}

async function waitForRefresh(accountKey, after, timeoutMs = LOCK_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cache = readCache(accountKey);
    if (cache?.data && cache.at >= after) return decorate(cache.data);
    if (!fs.existsSync(LOCK_FILE)) break;
    await delay(200);
  }
  return null;
}

function keychainToken() {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout).claudeAiOauth.accessToken || null);
        } catch { resolve(null); }
      }
    );
  });
}

function fileToken() {
  // Linux / non-keychain installs keep the same JSON on disk.
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return JSON.parse(raw).claudeAiOauth.accessToken || null;
  } catch { return null; }
}

async function token() {
  return (process.platform === 'darwin' ? await keychainToken() : null) || fileToken();
}

// "default_claude_max_5x" -> "Max (5x)"
function planLabel() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const tier = JSON.parse(raw).oauthAccount?.organizationRateLimitTier;
    if (!tier) return null;
    const m = /max_(\d+)x/.exec(tier);
    if (m) return `Max (${m[1]}x)`;
    if (tier.includes('pro')) return 'Pro';
    return tier;
  } catch { return null; }
}

const TITLE = {
  session: 'Current session',
  weekly_all: 'Weekly · all models',
  weekly_scoped: 'Weekly',   // refined below using scope.model.display_name
};

/**
 * @returns {Promise<null | {plan, fetchedAt, limits: Array<{
 *   kind, group, label, percent, severity, resetsAt, active
 * }>}>}  null on ANY failure — caller must degrade to the estimate.
 */
async function get(url, tok, accountKey) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${tok}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { return null; }              // offline, DNS, timeout
  if (res.status === 429) {
    // Its Retry-After header is observed as 0 — useless. Record the strike in
    // the SHARED cache so the other process backs off with us.
    noteRateLimited(accountKey);
    return null;
  }
  if (!res.ok) return null;             // 401 (token rotated) / 404 (endpoint moved)
  try { return await res.json(); } catch { return null; }
}

// Facts the API does not expose to this token — subscription renewal date, and
// (if you top up on console.anthropic.com) the Console credit balance. Optional:
// if plan.json is absent, those rows are simply omitted rather than faked.
function local() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

const money = m =>
  m && typeof m.amount_minor === 'number'
    ? m.amount_minor / Math.pow(10, m.exponent ?? 2)
    : null;

// plan.json values are applied on READ, never baked into the cache — otherwise an
// edit wouldn't show up until the TTL expired, and a cache written by an older
// build would keep serving its old field names.
function decorate(data) {
  const cfg = local();
  return {
    ...data,
    // Window LENGTH is not in the API response — only when the window ENDS. We
    // infer it from the kind (session = 5h, weekly = 7d), which is what lets the
    // client work out how far through the window you are, and therefore whether
    // you are on pace to blow the limit.
    //
    // Derived on READ, never cached — a cache written by an older build would
    // otherwise keep serving limits with this field missing, and the pace
    // indicator would silently vanish. (Exactly what happened once already.)
    limits: (data.limits || []).map(l => ({
      ...l,
      windowMs: l.group === 'session' ? 5 * 3600e3 : 7 * 24 * 3600e3,
    })),
    planInfo: {
      ...data.planInfo,
      renewsOn: cfg.renewsOn || null,
      priceUsd: cfg.priceUsd ?? null,
      billingPeriod: cfg.billingPeriod || 'month',
      creditBalance: cfg.creditBalance ?? null,
      spentToDate: cfg.spentToDate ?? null,
    },
  };
}

// Last known good, tagged so the UI can say "as of 4m ago" instead of pretending
// the feature is gone. A stale percentage is vastly more useful than no bar.
function stale(reason, accountKey) {
  const c = readCache(accountKey);
  if (!c || !c.data) return null;
  return decorate({ ...c.data, stale: true, staleSince: c.at, staleReason: reason });
}

async function quota({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = quotaOnce({ force }).finally(() => { refreshing = null; });
  return refreshing;
}

async function quotaOnce({ force = false } = {}) {
  const now = Date.now();
  const tok = await token();
  const identity = accountMeta(tok);
  if (!tok || !identity.key) return null;

  const cached = readCache(identity.key);
  if (!force && cached && cached.data && now - cached.at < TTL_MS) return decorate(cached.data);

  // Backing off from a 429 — the backoff is SHARED across processes via the cache
  // file, so the server and the extension sit it out together instead of taking
  // turns re-tripping the limiter (the deadlock that once kept the quota stale
  // for five hours while the endpoint was actually fine).
  if (now < sharedNextTryAt(identity.key)) return stale('rate-limited', identity.key);

  let release = acquireLock();
  if (!release) {
    const shared = await waitForRefresh(identity.key, now);
    if (shared) return shared;
    release = acquireLock();
    if (!release) return stale('refresh busy', identity.key);
  }

  try {
    // A second process may have completed between our initial read and lock acquisition.
    const newer = readCache(identity.key);
    if (newer?.data && newer.at >= now) return decorate(newer.data);

    const usage = await get(USAGE, tok, identity.key);
    if (!usage || !Array.isArray(usage.limits)) {
      return stale(Date.now() < sharedNextTryAt(identity.key) ? 'rate-limited' : 'unreachable', identity.key);
    }

  // Plan/tier/status barely changes — refetch it a couple of times a day, not
  // on every poll. Halving the request rate is what keeps us under the limit.
  let profile = profileCache?.accountKey === identity.key && now - profileCache.at < PROFILE_TTL_MS
    ? profileCache.data : null;
  if (!profile) {
    profile = await get(PROFILE, tok, identity.key);
    if (profile) profileCache = { accountKey: identity.key, at: now, data: profile };
    else if (cached?.data?.planInfo) profile = { organization: cached.data.planInfo._raw || {} };
  }

  const limits = usage.limits.map(l => {
    const model = l.scope?.model?.display_name;
    let label = TITLE[l.kind] || l.kind;
    if (l.kind === 'weekly_scoped' && model) label = `Weekly · ${model}`;
    return {
      kind: l.kind,
      group: l.group,
      label,
      percent: Number(l.percent) || 0,
      severity: l.severity || 'normal',
      resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      active: l.is_active === true,
    };
  });

  const org = profile?.organization || {};
  const s = usage.spend || {};

  // `spend` IS the usage-credits object. Every field reads null while extra usage
  // is disabled on the account — so these light up automatically if it's ever
  // enabled, with no code change. Nothing here is invented.
  const credits = {
    enabled: s.enabled === true,
    balance: money(s.balance),                 // null while disabled
    used: money(s.used),
    cap: money(s.cap),
    autoReload: s.auto_reload,                 // null while disabled
    canPurchase: s.can_purchase_credits === true,
    percent: typeof s.percent === 'number' ? s.percent : null,
  };

  // Only API-derived facts are cached. Declared values are layered on by
  // decorate() at read time — see the note there.
  const plan = {
    _raw: org,
    label: planLabel(),                        // "Max (5x)" from ~/.claude.json
    type: org.organization_type || null,       // "claude_max"
    status: org.subscription_status || null,   // "active"
    billing: org.billing_type || null,         // "stripe_subscription"
    extraUsage: org.has_extra_usage_enabled === true,
    since: org.subscription_created_at ? Date.parse(org.subscription_created_at) : null,
    blurb: org.organization_type === 'claude_max' ? '5× more usage than Pro' : null,
  };

  const data = { plan: plan.label, account: identity.display, fetchedAt: now, limits, credits, planInfo: plan };
  // Success clears the shared backoff — the limiter is demonstrably happy again.
    writeCache({ accountKey: identity.key, at: now, data, nextTryAt: 0, failStreak: 0 });
    return decorate(data);
  } finally {
    release();
  }
}

module.exports = {
  quota,
  maskAccount,
  accountMeta,
  cacheMatches,
  acquireLock,
  waitForRefresh,
  CACHE_FILE,
  LOCK_FILE,
  TTL_MS,
};
