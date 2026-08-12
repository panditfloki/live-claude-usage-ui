'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Watch parent directories because every provider cache is replaced atomically.
// Watching the file itself would silently detach after rename on macOS.
function watchCacheChanges(files, onChange, { debounceMs = 250 } = {}) {
  const groups = new Map();
  for (const file of files.filter(Boolean)) {
    const dir = path.dirname(file);
    if (!groups.has(dir)) groups.set(dir, new Set());
    groups.get(dir).add(path.basename(file));
  }

  const watchers = [];
  let timer;
  let disposed = false;
  for (const [dir, names] of groups) {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (disposed || !filename || !names.has(String(filename))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!disposed) onChange(path.join(dir, String(filename)));
        }, debounceMs);
      });
      watchers.push(watcher);
    } catch {}
  }

  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const watcher of watchers) try { watcher.close(); } catch {}
    },
  };
}

module.exports = { watchCacheChanges };
