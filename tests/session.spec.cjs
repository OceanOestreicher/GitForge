const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../electron/database.cjs');
const { createSessionStore } = require('../electron/session.cjs');
let directory, db;
test.beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-session-')); db = openDatabase(directory); });
test.afterEach(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

test('open repository tabs save while another connection reads the previous session', () => {
  const session = createSessionStore(directory, db); session.save(['first', 'second'], 0);
  const reader = new DatabaseSync(path.join(directory, 'gitforge.sqlite'));
  try {
    reader.exec('BEGIN'); expect(reader.prepare('SELECT path FROM open_repositories ORDER BY position').all().map(row => row.path)).toEqual(['first', 'second']);
    session.save(['second', 'third'], 1);
    expect(session.load().map(row => [row.path, row.active])).toEqual([['second', 0], ['third', 1]]);
    expect(reader.prepare('SELECT path FROM open_repositories ORDER BY position').all().map(row => row.path)).toEqual(['first', 'second']);
    reader.exec('COMMIT'); expect(reader.prepare('SELECT path FROM open_repositories ORDER BY position').all().map(row => row.path)).toEqual(['second', 'third']);
  } finally { reader.close(); }
});

test('a temporary write lock is waited out and the new session is saved completely', async () => {
  const session = createSessionStore(directory, db); session.save(['first'], 0);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 250);
  `, { eval: true, workerData: path.join(directory, 'gitforge.sqlite') });
  const exited = once(worker, 'exit');
  try {
    await once(worker, 'message'); session.save(['new-first', 'new-second'], 1);
    expect(session.load().map(row => [row.path, row.active])).toEqual([['new-first', 0], ['new-second', 1]]);
    await exited;
  } finally { await worker.terminate(); }
});

test('unchanged tabs need no write lock; a failed changed save can be retried without losing the old session', () => {
  const session = createSessionStore(directory, db); session.save(['first'], 0);
  const writer = new DatabaseSync(path.join(directory, 'gitforge.sqlite')); db.exec('PRAGMA busy_timeout=1');
  try {
    writer.exec('BEGIN IMMEDIATE'); session.save(['first'], 0);
    expect(() => session.save(['second'], 0)).toThrow(/settings database is busy/);
    expect(session.load().map(row => row.path)).toEqual(['first']);
    writer.exec('ROLLBACK'); session.save(['second'], 0);
    expect(session.load().map(row => row.path)).toEqual(['second']);
    const reopened = new DatabaseSync(path.join(directory, 'gitforge.sqlite'));
    try { expect(reopened.prepare('SELECT path FROM open_repositories').all().map(row => row.path)).toEqual(['second']); } finally { reopened.close(); }
  } finally { writer.close(); }
});
