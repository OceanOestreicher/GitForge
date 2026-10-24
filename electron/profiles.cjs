const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

function createProfileStore(directory, safeStorage, verify) {
  const db = new DatabaseSync(path.join(directory, 'gitforge.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL, pat BLOB NOT NULL, active INTEGER NOT NULL DEFAULT 0); CREATE UNIQUE INDEX IF NOT EXISTS one_active_profile ON profiles(active) WHERE active=1');
  const list = () => db.prepare('SELECT id, name, username, email, active FROM profiles').all().map(row => ({ ...row, active: Boolean(row.active) })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const encrypt = pat => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Profile credentials could not be saved.');
    return safeStorage.encryptString(pat);
  };
  const validate = (input, creating) => {
    if (!input || !['name', 'username', 'email', 'pat'].every(key => typeof input[key] === 'string')) throw new Error('Complete the profile form.');
    const result = { name: input.name.trim(), username: input.username.trim(), email: input.email.trim(), pat: input.pat };
    if (!result.name || !result.username || !result.email || (creating && !result.pat.trim())) throw new Error('Complete the profile form.');
    return result;
  };
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    return list();
  };
  const exists = id => { if (typeof id !== 'string' || !db.prepare('SELECT id FROM profiles WHERE id=?').get(id)) throw new Error('The profile no longer exists.'); };
  return {
    list,
    async create(input) {
      const data = validate(input, true), encrypted = encrypt(data.pat);
      await verify(data.username, data.pat);
      return transaction(() => db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), data.name, data.username, data.email, encrypted, list().length === 0 ? 1 : 0));
    },
    async edit(id, input) {
      exists(id); const data = validate(input, false);
      let pat = data.pat;
      if (!pat.trim()) {
        try { pat = safeStorage.decryptString(Buffer.from(db.prepare('SELECT pat FROM profiles WHERE id=?').get(id).pat)); }
        catch { throw new Error('The saved PAT could not be decrypted. Enter a new PAT and try again.'); }
      }
      await verify(data.username, pat);
      exists(id);
      if (data.pat.trim()) db.prepare('UPDATE profiles SET name=?,username=?,email=?,pat=? WHERE id=?').run(data.name, data.username, data.email, encrypt(data.pat), id);
      else db.prepare('UPDATE profiles SET name=?,username=?,email=? WHERE id=?').run(data.name, data.username, data.email, id);
      return list();
    },
    switch(id) { exists(id); return transaction(() => { db.exec('UPDATE profiles SET active=0'); db.prepare('UPDATE profiles SET active=1 WHERE id=?').run(id); }); },
    delete(id) {
      exists(id);
      return transaction(() => {
        db.prepare('DELETE FROM profiles WHERE id=?').run(id);
        const remaining = list();
        if (remaining.length && !remaining.some(profile => profile.active)) db.prepare('UPDATE profiles SET active=1 WHERE id=?').run(remaining[0].id);
      });
    }
  };
}
module.exports = { createProfileStore };
