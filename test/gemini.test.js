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
  assert.equal(costOf('gemini-3.6-flash', null, null, null), null);
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

test('parseGenMetadataBuf returns correct tokens and extracts model/timestamp from real DB blob', () => {
  // A real hex string from a .db file
  const hex = '120103222430313464613738652D316335662D343662362D383264352D64653432636261646531663042FC02889CB630A5C5C930F0B18F31F6B18F31FBCFF23182D0F23193E3F431C1C8FD31BAB28332BFB28332E2F78332EDF78332ACC4AE32B3C4AE32D0EDB032D3EDB032F090B332F290B332859EB632879EB632D4F9B632D4D2B832E8EDBA32EAEDBA32A1F5BA32A6F5BA3282C5BC3283FFBC32CDD1BD32CFD1BD328FB0BE32C3ECBE32CFECBE32D1ECBE3294ABBF32EDBABF328EA5C23296A5C232FDBCC4328ABDC4328BBDC432A0BDC432A1BDC432B6BDC432BBBDC432F2BAC532D0CCC632E0D4C632E5D4C632F7D4C632B886C732ADD9C732AFD9C7328987C8329087C8329487C83293BCC8329CD1C9329ED1C932D5B3CA32A5C0CB3291EFCB32AEEFCB32889FCC32D5D6CC32ECD6CC32B791CD32B991CD328493CD328793CD32CDA2CD32CFA2CD32D4C1CE3298D8D232F3A9D332E4D5D332D4EFD532CFDDD632DFF7D632DE84D732E284D73283E5D832FEFCDC3290F5DD3296F5DD32E9FADE32EBFADE32D2FDE432D4CFE632F69DE732C0B5E832C6B5E832BEB8E832C4B8E832B7D3E9320A920518AF08224F08AF08109C880118840328DB3F301842210A0973657373696F6E494412142D3337353037363330333433363238393535373948BD0250475A165A646C3461747159464B4434342D4550695A4B6C65513A060A046175746F4A2410FFFFFFFFFFFFFFFFFF01220C08E4B2E3D30610A8CAE3A101420052070882052080D00F5A070802108C98C865620610EEA2E6B9017A6208011080800429000000000000F03F383241000000000000F03F4A083C7C757365727C3E4A073C7C626F747C3E4A133C7C636F6E746578745F726571756573747C3E4A0D3C7C656E646F66746578747C3E4A0F3C7C656E645F6F665F7475726E7C3E8A0163124F08AF08109C880118840328DB3F301842210A0973657373696F6E494412142D3337353037363330333433363238393535373948BD0250475A165A646C3461747159464B4434342D4550695A4B6C65512210346532653836343635633562343332379A011067656D696E692D332E362D666C617368A2011E0A15757365645F6E6F6E5F67656D696E695F6D6F64656C120566616C7365A201140A0F6C6173745F737465705F696E646578120132A201230A0A6D6F64656C5F656E756D12154D4F44454C5F504C414345484F4C4445525F4D3731A201350A0D7472616A6563746F72795F6964122466636234356566302D636438382D343666342D626330382D313166633664396665303539A201340A0A726571756573745F6964122666636234356566302D636438382D343666342D626330382D3131666336643966653035392D30A201140A0B757365645F636C61756465120566616C7365A201210A18757365645F636C617564655F636F6E736572766174697665120566616C7365AA011747656D696E6920332E3620466C61736820284869676829';
  const buf = Buffer.from(hex, 'hex');
  const meta = parseGenMetadataBuf(buf);

  // Assertions
  assert.strictEqual(meta.model, 'gemini-3.6-flash');
  assert.strictEqual(meta.timestamp, 1786304868000);
  assert.strictEqual(meta.input, 642);
  assert.strictEqual(meta.output, 0);
  assert.strictEqual(meta.cache, 0);
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
      cost: null,
      input: null,
      output: null,
      cacheRead: null,
      tokens: null,
      turns: 5,
      models: [
        { name: 'gemini-3.6-flash', input: null, output: null, cacheRead: null, tokens: null, cost: null }
      ],
    }
  ];

  const norm = normalise(sessions);
  assert.equal(norm.sessions.length, 1);
  assert.equal(norm.daily.length, 1);
  assert.equal(norm.daily[0].day, '2026-08-09');
  assert.equal(norm.totals.cost, null);
  assert.equal(norm.totals.tokens, null);
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
