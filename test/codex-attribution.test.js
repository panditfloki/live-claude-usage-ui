'use strict';
// Contract tests for the two defects found on 2026-08-09:
//   1. the LaunchAgent could never run ccusage (bare PATH + `env node` shebang)
//   2. the "By project" card rendered ccusage's date folders as if they were projects
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalise, present, binDirs, execEnv, readFirstLine,
  cwdMap, sessionUuid, folderLabel, sessionFiles,
} = require('../codex');

const tokens = {
  costUSD: 10, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5,
  cacheCreationTokens: 10, cacheReadTokens: 200, totalTokens: 330,
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'matra-attr-'));
}

// ── defect 1: PATH ──────────────────────────────────────────────────────────

test('the exec PATH carries a node dir, so a bare launchd PATH cannot break ccusage', () => {
  const dirs = binDirs();
  assert.ok(dirs.includes(path.join(os.homedir(), '.local', 'bin')),
    '~/.local/bin must be searched — that is where node and ccusage live here');

  // Simulate launchd: nothing but the four system dirs in the inherited env.
  const realPath = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const env = execEnv();
    const parts = env.PATH.split(path.delimiter);
    assert.ok(parts.includes(path.join(os.homedir(), '.local', 'bin')),
      'a bare inherited PATH must still be widened before we spawn the child');
    assert.ok(parts.includes('/usr/bin'), 'system dirs must survive');
  } finally { process.env.PATH = realPath; }
});

// ── defect 2: attribution ───────────────────────────────────────────────────

test('a date folder from ccusage is never rendered as a project', () => {
  const sessions = { sessions: [
    { sessionId: '2026/08/09/rollout-2026-08-09T15-05-28-019fe5e0-9692-73c0-9873-780bc04bcdf5',
      sessionFile: 'rollout-2026-08-09T15-05-28-019fe5e0-9692-73c0-9873-780bc04bcdf5',
      directory: '2026/08/09', lastActivity: '2026-08-09T15:05:28Z', ...tokens, models: {} },
  ], totals: tokens };

  // No folder map → nothing may be attributed, and the date must not leak through.
  const bare = normalise({ daily: [], totals: {} }, sessions);
  assert.equal(bare.sessions[0].attributed, false);
  assert.equal(bare.sessions[0].folder, null);
  assert.equal(bare.sessions[0].directory, '2026/08/09',
    'the raw upstream value stays visible, but only as raw upstream data');

  // With a map → the real cwd wins and the date is still not a folder.
  const folders = new Map([['019fe5e0-9692-73c0-9873-780bc04bcdf5', '/Users/x/code/MATRA']]);
  const joined = normalise({ daily: [], totals: {} }, sessions, folders);
  assert.equal(joined.sessions[0].attributed, true);
  assert.equal(joined.sessions[0].cwd, '/Users/x/code/MATRA');
  assert.doesNotMatch(String(joined.sessions[0].folder), /^\d{4}\/\d{2}\/\d{2}$/,
    'a folder label must never be a YYYY/MM/DD date path');
});

test('unattributed sessions are pooled, and attributed + unattributed equals the total', () => {
  const rows = [
    { sessionFile: 'rollout-a-019fe5e0-9692-73c0-9873-780bc04bcdf5', directory: '2026/08/09',
      ...tokens, costUSD: 60, models: {} },
    { sessionFile: 'rollout-b-019fe5e1-9692-73c0-9873-780bc04bcdf6', directory: '',
      ...tokens, costUSD: 40, models: {} },
  ];
  const folders = new Map([['019fe5e0-9692-73c0-9873-780bc04bcdf5', '/Users/x/code/A']]);
  const out = normalise({ daily: [], totals: {} }, { sessions: rows, totals: {} }, folders);

  const attributed = out.sessions.filter(s => s.attributed);
  const unattributed = out.sessions.filter(s => !s.attributed);
  assert.equal(attributed.length, 1);
  assert.equal(unattributed.length, 1);

  const sum = s => s.reduce((a, r) => a + r.cost, 0);
  assert.equal(sum(attributed) + sum(unattributed), 100,
    'no session may be silently dropped from the split');
});

test('folder labels are home-relative, matching the Claude side', () => {
  assert.equal(folderLabel(path.join(os.homedir(), 'code', 'MATRA')), path.join('code', 'MATRA'));
  assert.equal(folderLabel('/opt/elsewhere'), '/opt/elsewhere');
  assert.equal(folderLabel(null), null);
});

test('the session uuid is taken from either identifier ccusage supplies', () => {
  assert.equal(
    sessionUuid({ sessionFile: 'rollout-2026-08-09T15-05-28-019fe5e0-9692-73c0-9873-780bc04bcdf5' }),
    '019fe5e0-9692-73c0-9873-780bc04bcdf5');
  assert.equal(
    sessionUuid({ sessionId: '2026/08/09/rollout-x-019FE5E0-9692-73C0-9873-780BC04BCDF5' }),
    '019fe5e0-9692-73c0-9873-780bc04bcdf5', 'matching is case-insensitive');
  assert.equal(sessionUuid({ sessionFile: 'no-uuid-here' }), null);
});

test('a first line far larger than one read buffer is parsed, not truncated', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rollout-big.jsonl');
  // Real rollouts carry base_instructions inline — ~17 KB on this disk. A fixed
  // 2 KB read returned invalid JSON and killed attribution on every file.
  const meta = {
    type: 'session_meta',
    payload: {
      id: '019fe5e0-9692-73c0-9873-780bc04bcdf5',
      cwd: '/Users/x/code/BIG',
      base_instructions: 'x'.repeat(200_000),
    },
  };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n{"type":"event_msg"}\n');

  const line = readFirstLine(file);
  assert.ok(line.length > 200_000, 'the whole line must be returned');
  assert.equal(JSON.parse(line).payload.cwd, '/Users/x/code/BIG');

  const map = cwdMap([{ file, mtime: fs.statSync(file).mtimeMs }]);
  assert.equal(map.get('019fe5e0-9692-73c0-9873-780bc04bcdf5'), '/Users/x/code/BIG');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rollout with no session_meta header is skipped, not guessed at', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rollout-headerless.jsonl');
  fs.writeFileSync(file, '{"type":"event_msg","payload":{"type":"token_count"}}\n');
  assert.equal(cwdMap([{ file, mtime: fs.statSync(file).mtimeMs }]).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both the live and archived session dirs are walked', () => {
  const root = tmpdir();
  const live = path.join(root, 'sessions', '2026', '08');
  const archived = path.join(root, 'archived_sessions', '2026', '07');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(path.join(live, 'a.jsonl'), '{}\n');
  fs.writeFileSync(path.join(archived, 'b.jsonl'), '{}\n');

  const files = sessionFiles([path.join(root, 'sessions'), path.join(root, 'archived_sessions')]);
  assert.equal(files.length, 2, 'archived rollouts hold most of the history and ccusage counts them');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── soft failure ────────────────────────────────────────────────────────────

test('a failed refresh degrades to stale, and never crashes the payload', () => {
  const out = present({ at: Date.now(), version: '20.0.19', error: 'ccusage refresh failed',
    data: { daily: { daily: [], totals: {} }, sessions: { sessions: [], totals: {} } } }, null);
  assert.equal(out.available, true);
  assert.equal(out.stale, true);
  assert.equal(out.staleReason, 'ccusage refresh failed');

  // Cold failure — no data at all — is an envelope, not a throw.
  const cold = present({ error: 'ccusage unavailable' }, null);
  assert.equal(cold.available, false);
  assert.deepEqual(cold.sessions, []);
});

test('a missing session directory yields an empty map rather than throwing', () => {
  assert.equal(sessionFiles([path.join(os.tmpdir(), 'matra-does-not-exist-' + Date.now())]).length, 0);
  assert.equal(cwdMap([{ file: '/nope/missing.jsonl', mtime: 1 }]).size, 0);
});
