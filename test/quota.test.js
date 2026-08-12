'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskAccount, cacheMatches } = require('../quota');

test('account display masks emails and long identifiers', () => {
  assert.equal(maskAccount('pandit@example.com'), 'pa***@example.com');
  assert.equal(maskAccount('a@example.com'), 'a*@example.com');
  assert.equal(maskAccount('1234567890abcdef'), '1234…cdef');
  assert.equal(maskAccount(null), null);
});

test('a cache belongs only to the matching account fingerprint', () => {
  const cache = { accountKey: 'account-a', data: { limits: [] } };
  assert.equal(cacheMatches(cache, 'account-a'), true);
  assert.equal(cacheMatches(cache, 'account-b'), false);
  assert.equal(cacheMatches({ data: {} }, 'account-a'), false, 'legacy unscoped cache must fail closed');
});
