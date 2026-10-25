const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'gitforge.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');
    return db;
  } catch (error) { db.close(); throw error; }
}
function isDatabaseBusy(error) {
  return [5, 6].includes(Number(error.errcode) & 255) || /database (?:is|table is) (?:locked|busy)/i.test(error.message || '');
}
module.exports = { openDatabase, isDatabaseBusy };
