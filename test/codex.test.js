'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalise, quotaShape, latestQuota, present, commandPath, TTL_MS } = require('../codex');

const totals = {
  costUSD: 12.5,
  inputTokens: 100,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  cacheCreationTokens: 10,
  cacheReadTokens: 200,
  totalTokens: 330,
};

test('normalises ccusage v20 daily and session contracts without duplication', () => {
  const daily = {
    daily: [{ date: '2026-08-09', ...totals, models: {
      'gpt-5.6-sol': { ...totals, costUSD: undefined, isFallback: false },
    } }],
    totals,
  };
  const sessions = {
    sessions: [{ sessionId: 's1', directory: '/work/MATRA', lastActivity: '2026-08-09T12:00:00Z',
      ...totals, models: {} }],
    totals,
  };

  const first = normalise(daily, sessions);
  const second = normalise(daily, sessions);
  assert.deepEqual(second, first);
  assert.equal(first.daily.length, 1);
  assert.equal(first.sessions.length, 1);
  assert.equal(first.totals.cost, 12.5);
  assert.equal(first.daily[0].models[0].cost, null);
  assert.equal(first.sessions[0].directory, '/work/MATRA');
});

test('uses an explicit unattributed directory fallback', () => {
  const result = normalise({ daily: [], totals: {} }, {
    sessions: [{ sessionId: 's1', directory: null, models: {} }], totals: {},
  });
  assert.equal(result.sessions[0].directory, 'unattributed');
});

test('maps primary and secondary Codex limits without combining denominators', () => {
  const quota = quotaShape({
    plan_type: 'plus',
    primary: { used_percent: 12, window_minutes: 10080, resets_at: 1786830656 },
    secondary: { used_percent: 44, window_minutes: 300, resets_at: 1786220000 },
    credits: { has_credits: false, unlimited: false, balance: '0' },
  }, 1234);
  assert.equal(quota.plan, 'Plus');
  assert.equal(quota.limits.length, 2);
  assert.deepEqual(quota.limits.map(x => x.label), ['Codex · 7-day', 'Codex · 5-hour']);
  assert.equal(quota.limits[0].resetsAt, 1786830656000);
  assert.equal(quota.fetchedAt, 1234);
});

test('selects the newest valid token_count rate-limit record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matra-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldFile = path.join(dir, 'old.jsonl');
  const newFile = path.join(dir, 'new.jsonl');
  fs.writeFileSync(oldFile, JSON.stringify({
    timestamp: '2026-08-08T10:00:00Z', type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      plan_type: 'plus', primary: { used_percent: 8, window_minutes: 10080, resets_at: 10 },
    } },
  }) + '\n');
  fs.writeFileSync(newFile, [
    JSON.stringify({ type: 'response_item', payload: {} }),
    JSON.stringify({
      timestamp: '2026-08-09T10:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', rate_limits: {
        plan_type: 'plus', primary: { used_percent: 22, window_minutes: 10080, resets_at: 20 },
      } },
    }),
  ].join('\n') + '\n');
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(newFile, future, future);

  const quota = latestQuota(dir);
  assert.equal(quota.limits[0].percent, 22);
});

test('malformed or absent quota degrades to null', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matra-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), '{not-json}\n');
  assert.equal(latestQuota(dir), null);
  assert.equal(quotaShape(null), null);
});

test('cold ccusage failure returns an unavailable envelope while preserving quota', () => {
  const quota = quotaShape({ primary:{ used_percent:1, window_minutes:10080, resets_at:20 } }, 10);
  const result = present({ error:'ccusage unavailable' }, quota, 100);
  assert.equal(result.available, false);
  assert.equal(result.staleReason, 'ccusage unavailable');
  assert.equal(result.quota, quota);
});

test('last good data remains available and is explicitly stale after refresh failure', () => {
  const cache = {
    at:1000, version:'20.0.19', error:'ccusage refresh failed',
    data:{ daily:{ daily:[], totals }, sessions:{ sessions:[], totals } },
  };
  const result = present(cache, null, 1000 + TTL_MS + 1);
  assert.equal(result.available, true);
  assert.equal(result.stale, true);
  assert.equal(result.staleReason, 'ccusage refresh failed');
  assert.equal(result.totals.cost, 12.5);
});

test('resolves the installed ccusage executable for GUI extension hosts', () => {
  assert.match(commandPath(), /ccusage(?:\.exe|\.cmd)?$/);
  assert.equal(fs.existsSync(commandPath()), true);
});
