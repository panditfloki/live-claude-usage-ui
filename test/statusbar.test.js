'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { localDay, primaryCodexLimit, primaryGeminiLimit, statusSummary } = require('../statusbar');

const claudeData = {
  block: { cost: 12.5, turns: 4 },
  today: { cost: 20 },
  totals: { cost: 200, turns: 40 },
};
const claudeQuota = { limits: [
  { kind: 'session', percent: 42 },
  { kind: 'weekly_all', percent: 12 },
] };
const codexData = {
  available: true,
  quota: { limits: [
    { kind: 'primary', percent: 31 },
    { kind: 'secondary', percent: 81 },
  ] },
  daily: [{ day: '2026-08-09', cost: 3.25, tokens: 5000 }],
  totals: { cost: 30, tokens: 50000 },
  sessions: [],
};
const geminiData = {
  available: true,
  quota: { limits: [
    { kind: 'primary', percent: 15 },
  ] },
  daily: [{ day: '2026-08-09', cost: 1.50, tokens: 2000 }],
  totals: { cost: 15, tokens: 20000 },
  sessions: [],
};
const now = new Date(2026, 7, 9, 12).getTime();

test('quota label keeps Claude, Codex, and Gemini denominators separate', () => {
  const out = statusSummary('quota', claudeData, claudeQuota, codexData, geminiData, now);
  assert.equal(out.label, 'C 42% · X 31% · G 15%');
  assert.equal(out.codexPrimary.kind, 'primary');
  assert.equal(out.geminiPrimary.kind, 'primary');
  assert.equal(out.warn, true, 'any provider limit at 80% should warn');
});

test('missing Codex or Gemini quota is explicit', () => {
  const out = statusSummary('quota', claudeData, claudeQuota, { available: false }, { available: false }, now);
  assert.equal(out.label, 'C 42% · X — · G —');
  assert.equal(out.warn, false);
});

test('today and total metrics show each provider separately', () => {
  assert.equal(statusSummary('today', claudeData, claudeQuota, codexData, geminiData, now).label,
    'C $20.00 · X $3.25 · G $1.50 today');
  assert.equal(statusSummary('total', claudeData, claudeQuota, codexData, geminiData, now).label,
    'C $200 · X $30.00 · G $15.00 total');
});

test('cost metric displays Claude window cost with Codex and Gemini primary quotas', () => {
  assert.equal(statusSummary('cost', claudeData, claudeQuota, codexData, geminiData, now).label,
    'C $12.50 · X 31% · G 15%');
});

test('local day is calendar-local, not UTC', () => {
  assert.match(localDay(now), /^2026-08-09$/);
  assert.equal(primaryCodexLimit(codexData).percent, 31);
  assert.equal(primaryGeminiLimit(geminiData).percent, 15);
});
