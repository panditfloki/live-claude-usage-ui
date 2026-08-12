'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchCacheChanges } = require('../refresh-sync');

test('atomic cache replacements coalesce into one redraw notification', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matra-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'provider.json');
  let calls = 0;
  const watcher = watchCacheChanges([cache], () => { calls++; }, { debounceMs: 40 });
  t.after(() => watcher.dispose());

  for (let i = 0; i < 3; i++) {
    const temp = `${cache}.${i}.tmp`;
    fs.writeFileSync(temp, String(i));
    fs.renameSync(temp, cache);
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls, 1);
});
