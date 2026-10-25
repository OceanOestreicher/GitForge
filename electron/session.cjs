const { Message } = require('../dist-electron/messages.cjs');
const { openDatabase, isDatabaseBusy } = require('./database.cjs');

function createSessionStore(directory, db = openDatabase(directory)) {
  db.exec('CREATE TABLE IF NOT EXISTS open_repositories (position INTEGER PRIMARY KEY, path TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)');
  let savedState;
  return {
    load: () => db.prepare('SELECT path, active FROM open_repositories ORDER BY position').all(),
    save(paths, activeIndex) {
      const state = JSON.stringify({ paths, activeIndex });
      if (state === savedState) return;
      let transaction = false;
      try {
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        db.exec('DELETE FROM open_repositories');
        const insert = db.prepare('INSERT INTO open_repositories (position, path, active) VALUES (?, ?, ?)');
        paths.forEach((root, index) => insert.run(index, root, index === activeIndex ? 1 : 0));
        db.exec('COMMIT');
        transaction = false; savedState = state;
      } catch (error) {
        if (transaction) db.exec('ROLLBACK');
        if (isDatabaseBusy(error)) throw new Error(Message['session.save.busy']);
        throw error;
      }
    }
  };
}
module.exports = { createSessionStore };
