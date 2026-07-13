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
const BACKOFF_MS = 5 * 60_000;         // 429 with a value already cached — sit it out
const COLD_BACKOFF_MS = 60_000;        // 429 with nothing to show — retry, but gently

// The dashboard runs in two processes at once (dev server + extension host).
// Without a shared cache they poll independently and double the request rate —
// which is exactly how the 429 happened. One file, one poller's worth of load.
const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-meter-quota.json');

let mem = null;          // { at, data }
let profileCache = null; // { at, data }
let nextTryAt = 0;       // set on 429 — do not hammer a limiter

// Always take the NEWER of our in-memory copy and the file — the other process
// may have refreshed it since. Preferring `mem` blindly would make one process
// poll on a stale clock and re-trigger the 429 we're trying to avoid.
function readCache() {
  let disk = null;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && c.at && c.data) disk = c;
  } catch {}
  if (disk && (!mem || disk.at > mem.at)) mem = disk;
  return mem;
}

function writeCache(entry) {
  mem = entry;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(entry)); } catch {}
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
async function get(url, tok) {
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
    const ra = Number(res.headers.get('retry-after'));   // observed as 0 — useless
    // Back off hard only when we already have something to show. On a cold start
    // there's nothing to serve, so a 5-minute sulk would leave the page blank —
    // retry soon instead.
    const base = readCache() ? BACKOFF_MS : COLD_BACKOFF_MS;
    nextTryAt = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : base);
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
function stale(reason) {
  const c = readCache();
  if (!c) return null;
  return decorate({ ...c.data, stale: true, staleSince: c.at, staleReason: reason });
}

async function quota({ force = false } = {}) {
  const now = Date.now();

  const cached = readCache();
  if (!force && cached && now - cached.at < TTL_MS) return decorate(cached.data);

  // Backing off from a 429 — do not touch the endpoint, just serve what we have.
  if (now < nextTryAt) return stale('rate-limited');

  const tok = await token();
  if (!tok) return stale('no token');

  const usage = await get(USAGE, tok);
  if (!usage || !Array.isArray(usage.limits)) {
    return stale(now < nextTryAt ? 'rate-limited' : 'unreachable');
  }

  // Plan/tier/status barely changes — refetch it a couple of times a day, not
  // on every poll. Halving the request rate is what keeps us under the limit.
  let profile = profileCache && now - profileCache.at < PROFILE_TTL_MS ? profileCache.data : null;
  if (!profile) {
    profile = await get(PROFILE, tok);
    if (profile) profileCache = { at: now, data: profile };
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

  const data = { plan: plan.label, fetchedAt: now, limits, credits, planInfo: plan };
  writeCache({ at: now, data });
  return decorate(data);
}

module.exports = { quota };
