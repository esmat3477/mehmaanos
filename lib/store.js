'use strict';
// Persistence. Two drivers behind one interface:
//   - PostgreSQL when DATABASE_URL is set (survives redeploys; recommended on Aria Run)
//   - JSON file in DATA_DIR otherwise (local dev / quick demos)
// The whole venue state is one document written atomically. Writes are coalesced,
// and callers that need durability (e.g. order creation) await flush() before replying.
const fs = require('fs');
const path = require('path');
const { seed, migrate } = require('./seed');

class FileDriver {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'mehmaanos.json'); this.bdir = path.join(dir, 'backups'); }
  async init() { fs.mkdirSync(this.bdir, { recursive: true }); }
  async load() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null; }
  async write(doc) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(doc)); fs.renameSync(tmp, this.file); }
  async backup(doc) {
    fs.writeFileSync(path.join(this.bdir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(doc));
    const files = fs.readdirSync(this.bdir).filter(f => f.startsWith('backup-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 28))) fs.unlinkSync(path.join(this.bdir, f));
  }
  async listBackups() { return fs.readdirSync(this.bdir).filter(f => f.startsWith('backup-')).sort().reverse(); }
  async close() {}
  get name() { return 'file'; }
}

class PgDriver {
  constructor(url) {
    const { Pool } = require('pg');
    const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: url, ssl, max: 3 });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mos_state (id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS mos_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), doc JSONB NOT NULL);`);
  }
  async load() { const r = await this.pool.query(`SELECT doc FROM mos_state WHERE id='venue'`); return r.rows[0]?.doc || null; }
  async write(doc) {
    await this.pool.query(`INSERT INTO mos_state (id, doc, updated_at) VALUES ('venue', $1, now())
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, [JSON.stringify(doc)]);
  }
  async backup(doc) {
    await this.pool.query(`INSERT INTO mos_backups (doc) VALUES ($1)`, [JSON.stringify(doc)]);
    await this.pool.query(`DELETE FROM mos_backups WHERE id NOT IN (SELECT id FROM mos_backups ORDER BY id DESC LIMIT 28)`);
  }
  async listBackups() { return (await this.pool.query(`SELECT id, created_at FROM mos_backups ORDER BY id DESC`)).rows.map(r => `${r.id} · ${r.created_at.toISOString()}`); }
  async close() { await this.pool.end(); }
  get name() { return 'postgres'; }
}

class Store {
  constructor({ dataDir, databaseUrl }) {
    this.driver = databaseUrl ? new PgDriver(databaseUrl) : new FileDriver(dataDir);
    this.pending = null; this.dirty = false; this.lastError = null; this.lastSavedAt = null;
  }
  async init() {
    await this.driver.init();
    const doc = await this.driver.load();
    this.data = migrate(doc || seed());
    await this.driver.write(this.data);
    this.lastSavedAt = new Date().toISOString();
    // Backup on start and every 6 hours.
    await this.driver.backup(this.data).catch(e => console.error('backup failed', e.message));
    this.bt = setInterval(() => this.driver.backup(this.data).catch(e => console.error('backup failed', e.message)), 6 * 3600e3);
    this.bt.unref();
  }
  // Mark dirty and flush soon. Returns a promise that resolves once the data is durably written.
  save() {
    this.dirty = true;
    if (!this.pending) {
      // Writes are chained so they can never overlap or land out of order.
      this.chain = this.chain || Promise.resolve();
      const p = this.chain.then(() => new Promise(r => setTimeout(r, 25))).then(async () => {
        this.pending = null;
        if (!this.dirty) return;
        this.dirty = false;
        try { await this.driver.write(this.data); this.lastSavedAt = new Date().toISOString(); this.lastError = null; }
        catch (e) { this.dirty = true; this.lastError = e.message; console.error('save failed', e); throw e; }
      });
      this.pending = p;
      this.chain = p.catch(() => {});
    }
    return this.pending;
  }
  flush() { return this.save(); }
  replace(doc) { this.data = migrate(doc); return this.save(); }
  audit(actor, action, detail) {
    this.data.audit.push({ at: new Date().toISOString(), actor, action, detail });
    if (this.data.audit.length > 5000) this.data.audit.splice(0, this.data.audit.length - 5000);
  }
  async close() { clearInterval(this.bt); if (this.dirty) await this.driver.write(this.data).catch(() => {}); await this.driver.close(); }
}

module.exports = { Store };
