const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function createSessionStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'gitforge.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS open_repositories (position INTEGER PRIMARY KEY, path TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)');
  return {
    load: () => db.prepare('SELECT path, active FROM open_repositories ORDER BY position').all(),
    save(paths, activeIndex) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM open_repositories');
        const insert = db.prepare('INSERT INTO open_repositories (position, path, active) VALUES (?, ?, ?)');
        paths.forEach((root, index) => insert.run(index, root, index === activeIndex ? 1 : 0));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
module.exports = { createSessionStore };
