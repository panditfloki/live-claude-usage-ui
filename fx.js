'use strict';
// USD → INR conversion for display only.
//
// Every figure Mātrā computes is in USD, because every source (Anthropic's API,
// ccusage, plan.json) is priced in USD. This module converts for DISPLAY at the
// last moment — nothing upstream is ever stored in rupees, so a bad or missing
// rate can never corrupt a stored number.
//
// Soft-fail contract, same as quota.js and gemini.js: a failed fetch serves the
// last good rate tagged stale, and a rate that has NEVER been fetched returns
// null so the UI falls back to showing dollars. It must never invent a rate —
// a plausible-looking wrong exchange rate is exactly the class of silent
// fabrication this project has already been burned by three times.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// exchangerate-api.com's free tier. No key, no package, updates once daily —
// which is why the TTL below is 12h rather than minutes: the upstream number
// simply does not change more often, so polling harder would be pure noise.
// Verified live 2026-08-13; it returns time_last_update_utc, which is what
// lets the UI say how old the rate actually is instead of implying "now".
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_FILE = path.join(os.tmpdir(), 'matra-fx.json');
const TTL_MS = 12 * 3600e3;
const TIMEOUT_MS = 8_000;

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

function writeCache(data) {
  const temp = `${CACHE_FILE}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(data)); fs.renameSync(temp, CACHE_FILE); }
  catch { try { fs.unlinkSync(temp); } catch {} }
}

let refreshing = null;

async function fetchRate() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FX_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`FX endpoint returned ${res.status}`);
    const body = await res.json();
    const rate = body?.rates?.INR;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error('FX response carried no usable INR rate');
    }
    return {
      rate,
      // The upstream's own timestamp, not ours — a rate fetched at noon may
      // still be yesterday's published rate, and the UI should be able to say so.
      publishedAt: body.time_last_update_unix ? body.time_last_update_unix * 1000 : null,
      nextUpdateAt: body.time_next_update_unix ? body.time_next_update_unix * 1000 : null,
      provider: body.provider || 'open.er-api.com',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refresh({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache?.fx && Date.now() - (cache.at || 0) < TTL_MS) return read();
  if (refreshing) { await refreshing; return read(); }

  refreshing = (async () => {
    try {
      const fx = await fetchRate();
      writeCache({ at: Date.now(), fx, error: null });
    } catch (err) {
      // Keep whatever rate we already had; only record why the refresh failed.
      writeCache({ ...(cache || {}), error: String(err.message || err) });
    } finally {
      refreshing = null;
    }
  })();
  await refreshing;
  return read();
}

// markupPercent is the card/forex spread the bank adds on top of the mid-market
// rate — declared in plan.json, because no public API knows what a given card
// charges. Applied here so every rupee figure in the app reflects what the
// charge actually costs him, not the interbank rate he never actually gets.
function read(markupPercent = 0) {
  const cache = readCache();
  if (!cache?.fx) {
    return { available: false, rate: null, staleReason: cache?.error || 'no rate fetched yet' };
  }
  const age = Date.now() - (cache.at || 0);
  const markup = Number.isFinite(markupPercent) ? markupPercent : 0;
  return {
    available: true,
    // The rate actually used for conversion, markup included.
    rate: cache.fx.rate * (1 + markup / 100),
    midMarketRate: cache.fx.rate,
    markupPercent: markup,
    publishedAt: cache.fx.publishedAt,
    nextUpdateAt: cache.fx.nextUpdateAt,
    provider: cache.fx.provider,
    fetchedAt: cache.at,
    stale: age >= TTL_MS || !!cache.error,
    staleReason: cache.error || (age >= TTL_MS ? 'rate cache expired' : null),
  };
}

module.exports = { read, refresh, fetchRate, CACHE_FILE, TTL_MS, FX_URL };
