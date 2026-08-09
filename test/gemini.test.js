'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalise, costOf, parseGenMetadataBuf, present, isConversationFile, TTL_MS, CACHE_VERSION } = require('../gemini');

test('gemini model pricing and cost calculations', () => {
  const c1 = costOf('gemini-3.6-flash', 1000000, 1000000, 1000000);
  // Standard paid-tier API proxy: $1.50 input + $7.50 output + $0.15 cache.
  assert.equal(c1, 9.15);

  const c2 = costOf('gemini-3.6-flash-high', 1000000, 1000000, 0);
  assert.equal(c2, 9);
  assert.equal(costOf('gemini-unknown', 1000000, 1000000, 0), null);
});

test('uses the concrete Antigravity display model instead of its placeholder id', () => {
  const buf = Buffer.from('gemini-default\0model_enum\0Gemini 3.5 Flash (Medium)');
  assert.equal(parseGenMetadataBuf(buf).model, 'gemini-3.5-flash-medium');
});

test('active SQLite WAL writes trigger near-live refreshes', () => {
  assert.equal(isConversationFile('conversation.db'), true);
  assert.equal(isConversationFile('conversation.db-wal'), true);
  assert.equal(isConversationFile('conversation.db-shm'), false);
});

test('normalises gemini sessions and daily burn aggregations', () => {
  const sessions = [
    {
      id: 'sess-1',
      directory: '/work/MATRA',
      folder: 'MATRA',
      cwd: '/work/MATRA',
      attributed: true,
      lastActivity: '2026-08-09T12:00:00.000Z',
      ts: Date.parse('2026-08-09T12:00:00.000Z'),
      cost: 1.50,
      input: 1000,
      output: 500,
      cacheRead: 2000,
      tokens: 3500,
      turns: 5,
      models: [
        { name: 'gemini-3.6-flash', input: 1000, output: 500, cacheRead: 2000, tokens: 3500, cost: 1.50 }
      ],
    }
  ];

  const norm = normalise(sessions);
  assert.equal(norm.sessions.length, 1);
  assert.equal(norm.daily.length, 1);
  assert.equal(norm.daily[0].day, '2026-08-09');
  assert.equal(norm.totals.cost, 1.50);
  assert.equal(norm.totals.tokens, 3500);
  assert.equal(norm.totals.turns, 5);
  assert.equal(norm.quota, null, 'must not invent an Antigravity account quota');
  assert.deepEqual(norm.daily[0].models, sessions[0].models);
});

test('presents cached data with soft failure handling', () => {
  const cache = {
    version: CACHE_VERSION,
    at: Date.now() - 1000,
    data: {
      sessions: [
        { id: 's1', folder: 'MATRA', lastActivity: '2026-08-09T10:00:00Z', cost: 0.5, input: 100, output: 100, cacheRead: 0, tokens: 200, turns: 1 }
      ]
    },
    error: null,
  };

  const pres = present(cache);
  assert.equal(pres.available, true);
  assert.equal(pres.stale, false);
  assert.equal(pres.totals.cost, 0.5);
  assert.equal(pres.source.name, 'Antigravity CLI');
  assert.equal(pres.quota, null);
});

test('rejects pre-pricing-fix cache so stale costs cannot leak into v1.3.0', () => {
  const pres = present({ at: Date.now(), data: { sessions: [] } });
  assert.equal(pres.available, false);
  assert.match(pres.staleReason, /requires refresh/);
});
