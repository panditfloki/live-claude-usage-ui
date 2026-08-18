'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalise, costOf, parseGenMetadataBuf, present, isConversationFile, TTL_MS, CACHE_VERSION,
  quotaShapeFromResponse, remainingPercent, resetMs,
  consumption, QUOTA_HISTORY_FILE,
  estimatedValueFor, estimatedSpendFrom, probeIsRpc, rpcCall,
} = require('../gemini');

test('gemini model pricing and cost calculations', () => {
  const c1 = costOf('gemini-3.6-flash', 1000000, 1000000, 1000000);
  // Standard paid-tier API proxy: $1.50 input + $7.50 output + $0.15 cache.
  assert.equal(c1, 9.15);

  const c37 = costOf('gemini-3.7-flash', 1000000, 1000000, 1000000);
  assert.equal(c37, 9.15);

  const c37low = costOf('gemini-3.7-flash-low', 1000000, 1000000, 0);
  assert.equal(c37low, 9);

  const c2 = costOf('gemini-3.6-flash-high', 1000000, 1000000, 0);
  assert.equal(c2, 9);
  assert.equal(costOf('gemini-unknown', 1000000, 1000000, 0), null);
  assert.equal(costOf('gemini-3.6-flash', null, null, null), null);
});

test('uses the concrete Antigravity display model instead of its placeholder id', () => {
  const buf = Buffer.from('gemini-default\0model_enum\0Gemini 3.5 Flash (Medium)');
  assert.equal(parseGenMetadataBuf(buf).model, 'gemini-3.5-flash-medium');
});

const INR = { geminiPrice: 1950, geminiPriceCurrency: 'INR' };

test('estimatedValueFor spreads a declared price linearly across a quota window', () => {
  // 5-hour session window, ₹1950/mo, 70% remaining — matches the worked example
  // Pandit Ji brought from Perplexity: value/window ≈ 13.54, remaining ≈ 9.48, used ≈ 4.06.
  const v = estimatedValueFor({ percent: 70, windowMs: 5 * 3600e3 }, INR);
  assert.equal(v.window, 13.54);
  assert.equal(v.remaining, 9.48);
  assert.equal(v.used, 4.06);
  assert.equal(v.currency, 'INR');
  assert.equal(v.label, 'Estimated subscription-value equivalent');

  // Weekly window, same price, 70% remaining.
  const w = estimatedValueFor({ percent: 70, windowMs: 7 * 24 * 3600e3 }, INR);
  assert.equal(w.window, 455); // 1950 / (30*24/168)
  assert.equal(Math.round((w.remaining + w.used) * 100) / 100, w.window);
});

test('estimatedValueFor stays null with no declared price, no percent, or no window', () => {
  assert.equal(estimatedValueFor({ percent: 70, windowMs: 18e6 }, { geminiPrice: null }), null);
  assert.equal(estimatedValueFor({ percent: null, windowMs: 18e6 }, INR), null);
  assert.equal(estimatedValueFor({ percent: 70, windowMs: null }, INR), null);
});

test('estimatedSpendFrom prices what was actually burned, in the declared currency', () => {
  // A full 5-hour window burned end to end is exactly one window's worth of plan value.
  const full = estimatedSpendFrom({ pp: 100, samples: 30, gapMs: 0, resets: 0 }, 5 * 3600e3, INR);
  assert.equal(full.amount, 13.54);
  assert.equal(full.currency, 'INR');

  // Half of it, half the value.
  const half = estimatedSpendFrom({ pp: 50, samples: 30, gapMs: 0, resets: 0 }, 5 * 3600e3, INR);
  assert.equal(half.amount, 6.77);

  // Observation gaps ride along untouched so the UI can disclose them.
  assert.equal(estimatedSpendFrom({ pp: 20, samples: 4, gapMs: 7.2e6, resets: 1 }, 5 * 3600e3, INR).gapMs, 7.2e6);
});

test('estimatedSpendFrom refuses to invent a figure with no price or no samples', () => {
  assert.equal(estimatedSpendFrom({ pp: 50, samples: 30, observedMs: 18e6, gapMs: 0 }, 18e6, { geminiPrice: null }), null);
  // pp === null means "too few samples to say", which must never become a confident zero.
  assert.equal(estimatedSpendFrom({ pp: null, samples: 1, observedMs: 0, gapMs: 0 }, 18e6, INR), null);
  assert.equal(estimatedSpendFrom(null, 18e6, INR), null);
});

test('a barely-observed window yields no figure rather than a confident zero', () => {
  const w = 5 * 3600e3;
  // Two samples five minutes apart: "nothing was watching", not "nothing was spent".
  assert.equal(estimatedSpendFrom({ pp: 0, samples: 2, observedMs: 3e5, gapMs: w }, w, INR), null);
  // Enough samples but almost no coverage — still not publishable.
  assert.equal(estimatedSpendFrom({ pp: 0, samples: 9, observedMs: 6e5, gapMs: w }, w, INR), null);
  // Well-observed and genuinely idle: a real, publishable zero.
  const idle = estimatedSpendFrom({ pp: 0, samples: 40, observedMs: w * 0.9, gapMs: 0 }, w, INR);
  assert.equal(idle.amount, 0);
  // Observed burn is always publishable — it was, by definition, seen happening.
  assert.equal(estimatedSpendFrom({ pp: 25, samples: 2, observedMs: 6e5, gapMs: w }, w, INR).amount, 3.39);
});

test('active SQLite WAL writes trigger near-live refreshes', () => {
  assert.equal(isConversationFile('conversation.db'), true);
  assert.equal(isConversationFile('conversation.db-wal'), true);
  assert.equal(isConversationFile('conversation.db-shm'), false);
});

test('real metadata exposes its model but unverified protobuf quantities stay unknown', () => {
  // A real hex string from a .db file
  const hex = '120103222430313464613738652D316335662D343662362D383264352D64653432636261646531663042FC02889CB630A5C5C930F0B18F31F6B18F31FBCFF23182D0F23193E3F431C1C8FD31BAB28332BFB28332E2F78332EDF78332ACC4AE32B3C4AE32D0EDB032D3EDB032F090B332F290B332859EB632879EB632D4F9B632D4D2B832E8EDBA32EAEDBA32A1F5BA32A6F5BA3282C5BC3283FFBC32CDD1BD32CFD1BD328FB0BE32C3ECBE32CFECBE32D1ECBE3294ABBF32EDBABF328EA5C23296A5C232FDBCC4328ABDC4328BBDC432A0BDC432A1BDC432B6BDC432BBBDC432F2BAC532D0CCC632E0D4C632E5D4C632F7D4C632B886C732ADD9C732AFD9C7328987C8329087C8329487C83293BCC8329CD1C9329ED1C932D5B3CA32A5C0CB3291EFCB32AEEFCB32889FCC32D5D6CC32ECD6CC32B791CD32B991CD328493CD328793CD32CDA2CD32CFA2CD32D4C1CE3298D8D232F3A9D332E4D5D332D4EFD532CFDDD632DFF7D632DE84D732E284D73283E5D832FEFCDC3290F5DD3296F5DD32E9FADE32EBFADE32D2FDE432D4CFE632F69DE732C0B5E832C6B5E832BEB8E832C4B8E832B7D3E9320A920518AF08224F08AF08109C880118840328DB3F301842210A0973657373696F6E494412142D3337353037363330333433363238393535373948BD0250475A165A646C3461747159464B4434342D4550695A4B6C65513A060A046175746F4A2410FFFFFFFFFFFFFFFFFF01220C08E4B2E3D30610A8CAE3A101420052070882052080D00F5A070802108C98C865620610EEA2E6B9017A6208011080800429000000000000F03F383241000000000000F03F4A083C7C757365727C3E4A073C7C626F747C3E4A133C7C636F6E746578745F726571756573747C3E4A0D3C7C656E646F66746578747C3E4A0F3C7C656E645F6F665F7475726E7C3E8A0163124F08AF08109C880118840328DB3F301842210A0973657373696F6E494412142D3337353037363330333433363238393535373948BD0250475A165A646C3461747159464B4434342D4550695A4B6C65512210346532653836343635633562343332379A011067656D696E692D332E362D666C617368A2011E0A15757365645F6E6F6E5F67656D696E695F6D6F64656C120566616C7365A201140A0F6C6173745F737465705F696E646578120132A201230A0A6D6F64656C5F656E756D12154D4F44454C5F504C414345484F4C4445525F4D3731A201350A0D7472616A6563746F72795F6964122466636234356566302D636438382D343666342D626330382D313166633664396665303539A201340A0A726571756573745F6964122666636234356566302D636438382D343666342D626330382D3131666336643966653035392D30A201140A0B757365645F636C61756465120566616C7365A201210A18757365645F636C617564655F636F6E736572766174697665120566616C7365AA011747656D696E6920332E3620466C61736820284869676829';
  const buf = Buffer.from(hex, 'hex');
  const meta = parseGenMetadataBuf(buf);

  assert.strictEqual(meta.model, 'gemini-3.6-flash');
  assert.strictEqual(meta.timestamp, 0);

  // Real token counts, read from the documented path (1 → 4 → leaves) after the
  // schema was recovered from Antigravity's own language_server binary.
  // ⚠️ This is the very blob that broke the previous two attempts: 1,085 bytes,
  // which round 1 read as input:1071 (actually ModelUsageStats.model, an enum)
  // and round 3 read as input:37,892 (actually a unix timestamp). Both are now
  // regression-locked below.
  assert.strictEqual(meta.input, 17436);
  assert.strictEqual(meta.output, 388);
  assert.strictEqual(meta.cache, 8155);
  assert.notStrictEqual(meta.input, 1071);    // round-1 fabrication
  assert.notStrictEqual(meta.input, 37892);   // round-3 fabrication

  // The invariant that proves these are the real fields and not a lucky offset:
  // output is exactly thinking + response on every blob Antigravity writes.
  assert.strictEqual(meta.output, meta.thinking + 71);
});

test('absent token fields mean zero, not unknown — protobuf omits defaults', () => {
  // A usage message with input only. cache_read/output are simply not on the
  // wire because they were zero; reading them as null made costOf() return null
  // and silently dropped the turn's real spend from every total.
  //  field 1 (chat_model) { field 4 (usage) { field 2 (input) = 300 } }
  const usage = Buffer.from([0x10, 0xac, 0x02]);              // 2:varint = 300
  const chatModel = Buffer.concat([Buffer.from([0x22, usage.length]), usage]);   // 4:len
  const blob = Buffer.concat([Buffer.from([0x0a, chatModel.length]), chatModel]); // 1:len
  const meta = parseGenMetadataBuf(blob);
  assert.strictEqual(meta.input, 300);
  assert.strictEqual(meta.output, 0);
  assert.strictEqual(meta.cache, 0);
});

test('the CSRF token is never sent to a port that is not Connect-RPC', async () => {
  // Antigravity forwards user ports through the language_server pid, so the
  // candidate list really does include Mātrā (:4317) and Lekhā (:4318) on this
  // machine. Both answer HTTP 200 with text/html to the RPC path — measured,
  // not assumed. Before the 2026-08-13 fix the token was POSTed to every one of
  // them and only JSON.parse() throwing on HTML kept it from being used.
  const http = require('node:http');
  let sawToken = false;
  const srv = http.createServer((req, res) => {
    if (req.headers['x-codeium-csrf-token']) sawToken = true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html>a dashboard, not an RPC server</html>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const method = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

  await assert.rejects(
    () => probeIsRpc('http', port, method),
    /not a Connect-RPC endpoint/,
    'an HTML responder must never be accepted as the RPC endpoint',
  );
  assert.equal(sawToken, false, 'probe must carry no credential at all');

  // And the authenticated call refuses the same host, so a regression in the
  // probe cannot quietly re-open the leak downstream.
  await assert.rejects(() => rpcCall('http', port, 'secret-token', method), /not a Connect-RPC endpoint/);

  await new Promise(r => srv.close(r));
});

test('a blob with no usage message stays unknown rather than becoming zero', () => {
  const meta = parseGenMetadataBuf(Buffer.from('no protobuf here at all', 'utf8'));
  assert.strictEqual(meta.input, null);
  assert.strictEqual(meta.output, null);
  assert.strictEqual(meta.cache, null);
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
  // Quota moved out of normalise() in v1.4.2 — it is real, live data from
  // Antigravity's own RPC, attached by present(), so normalise() stays a pure
  // function of session data.
  assert.equal('quota' in norm, false, 'normalise must not fabricate a quota field');
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

  // quota is now an explicit argument — present() attaches whatever the live
  // RPC layer supplied, and null when it supplied nothing.
  const pres = present(cache, null);
  assert.equal(pres.available, true);
  assert.equal(pres.stale, false);
  assert.equal(pres.totals.cost, 0.5);
  assert.equal(pres.source.name, 'Antigravity CLI');
  assert.equal(pres.quota, null);

  const withQuota = present(cache, { plan: null, limits: [{ kind: 'gemini', percent: 70, remaining: true }] });
  assert.equal(withQuota.quota.limits[0].percent, 70);
});

test('rejects old caches so guessed Gemini costs cannot leak into v1.4.0', () => {
  const pres = present({ at: Date.now(), data: { sessions: [] } });
  assert.equal(pres.available, false);
  assert.match(pres.staleReason, /requires refresh/);
});

// ── Live account quota (RetrieveUserQuotaSummary over Antigravity's own RPC) ──
// Fixture mirrors the real response shape observed on this machine 2026-08-13,
// cross-checked against what the AG Usage extension displayed at the same
// moment: Gemini 70% / 82%, Other 100% / 100%.
const QUOTA_FIXTURE = {
  response: {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          { displayName: 'Five Hour Limit Remaining', remainingFraction: 0.7, resetTime: 1786573083000 },
          { displayName: 'Weekly Limit Remaining', remainingFraction: 0.82, resetTime: 1786635118000 },
        ],
      },
      {
        displayName: 'Other',
        buckets: [
          { displayName: 'Five Hour Limit Remaining', remainingFraction: 1, resetTime: 1786578985000 },
          { displayName: 'Weekly Limit Remaining', remainingFraction: 1, resetTime: 1787166385000 },
        ],
      },
    ],
  },
};

test('quota percentages are REMAINING and match what Antigravity itself shows', () => {
  const q = quotaShapeFromResponse(QUOTA_FIXTURE);
  const byLabel = Object.fromEntries(q.limits.map(l => [l.label, l.percent]));
  assert.equal(byLabel['Gemini · 5-hour left'], 70);
  assert.equal(byLabel['Gemini · weekly left'], 82);
});

// Rewritten 2026-08-13: the "other" leg used to be asserted here. It is now
// dropped on purpose — he never routes Claude or GPT through Antigravity, so
// it reads a permanent 100% and sits misleadingly next to Mātrā's real
// Claude/Codex bars. Keep this test: it is what stops the leg coming back.
test('the always-100% "other" leg is dropped, not surfaced', () => {
  const q = quotaShapeFromResponse(QUOTA_FIXTURE);
  assert.equal(q.limits.length, 2, 'only the two Gemini windows survive');
  for (const l of q.limits) {
    assert.equal(l.kind, 'gemini');
    assert.doesNotMatch(l.label, /other/i, 'no "other" leg may reach the UI');
  }
});

test('every Gemini limit is flagged remaining, so nothing reads it as "used"', () => {
  const q = quotaShapeFromResponse(QUOTA_FIXTURE);
  assert.ok(q.limits.length > 0);
  for (const l of q.limits) {
    assert.equal(l.remaining, true, `${l.label} must be flagged remaining`);
    assert.match(l.label, /left$/, 'the direction must be visible in the label itself');
  }
});

test('both windows survive per leg, and window lengths are derived', () => {
  const q = quotaShapeFromResponse(QUOTA_FIXTURE);
  const gemini = q.limits.filter(l => l.kind === 'gemini');
  assert.equal(gemini.length, 2, 'the 5-hour window must not swallow the weekly one');
  assert.equal(gemini.find(l => l.group === 'session').windowMs, 5 * 3600e3);
  assert.equal(gemini.find(l => l.group === 'weekly').windowMs, 7 * 24 * 3600e3);
});

test('a full tank is 100% remaining, an empty one is 0 — never inverted', () => {
  assert.equal(remainingPercent(1), 100);
  assert.equal(remainingPercent(0), 0);
  assert.equal(remainingPercent(0.7), 70);
  assert.equal(remainingPercent('nonsense'), null);
  assert.equal(remainingPercent(undefined), null);
});

test('reset times accept both epoch millis and ISO strings', () => {
  assert.equal(resetMs(1786573083000), 1786573083000);
  assert.equal(resetMs('2026-08-13T03:48:03.000Z'), Date.parse('2026-08-13T03:48:03.000Z'));
  assert.equal(resetMs(null), null);
  assert.equal(resetMs('not a date'), null);
});

test('an empty or malformed quota response yields null, not a fake zero bar', () => {
  assert.equal(quotaShapeFromResponse({}), null);
  assert.equal(quotaShapeFromResponse({ response: { groups: [] } }), null);
  assert.equal(quotaShapeFromResponse({ response: { groups: [{ displayName: 'Gemini', buckets: [] }] } }), null);
});

// ── Percentage-point consumption ────────────────────────────────────────────
// The only "amount" Gemini can honestly produce. Antigravity exposes a quota
// LEVEL, not tokens and not money, so consumption is derived by differencing
// polled levels — which makes the failure modes below the whole contract.
function withHistory(samples, fn) {
  const backup = fs.existsSync(QUOTA_HISTORY_FILE) ? fs.readFileSync(QUOTA_HISTORY_FILE) : null;
  fs.mkdirSync(path.dirname(QUOTA_HISTORY_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_HISTORY_FILE, JSON.stringify({ samples }));
  try { return fn(); }
  finally {
    if (backup) fs.writeFileSync(QUOTA_HISTORY_FILE, backup);
    else try { fs.unlinkSync(QUOTA_HISTORY_FILE); } catch {}
  }
}

test('burn is the sum of drops in remaining, in percentage points', () => {
  const now = Date.now();
  withHistory([
    { at: now - 15 * 60_000, session: 70 },
    { at: now - 10 * 60_000, session: 62 },
    { at: now - 5 * 60_000, session: 55 },
  ], () => {
    assert.equal(consumption(5 * 3600e3, 'session', now).pp, 15);
  });
});

test('a window reset is not counted as negative usage', () => {
  const now = Date.now();
  withHistory([
    { at: now - 15 * 60_000, session: 20 },
    { at: now - 10 * 60_000, session: 100 },  // refilled
    { at: now - 5 * 60_000, session: 92 },
  ], () => {
    const c = consumption(5 * 3600e3, 'session', now);
    assert.equal(c.pp, 8, 'only the post-reset 8pp drop counts');
    assert.equal(c.resets, 1, 'the refill is reported, not silently absorbed');
  });
});

test('an unobserved stretch is reported as a gap, never as zero burn', () => {
  const now = Date.now();
  withHistory([
    { at: now - 300 * 60_000, session: 80 },   // Mātrā was not running between
    { at: now - 5 * 60_000, session: 55 },     // these two readings
  ], () => {
    const c = consumption(5 * 3600e3, 'session', now);
    assert.equal(c.pp, 0, 'a 25-point drop across a 5h blind spot is not attributable');
    assert.ok(c.gapMs > 4 * 3600e3, 'the blind spot must be surfaced so the 0 is readable');
  });
});

test('a single sample yields no figure at all rather than a fake zero', () => {
  const now = Date.now();
  withHistory([{ at: now - 60_000, session: 70 }], () => {
    assert.equal(consumption(5 * 3600e3, 'session', now).pp, null);
  });
});
