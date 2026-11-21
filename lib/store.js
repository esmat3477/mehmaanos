'use strict';
// Persistence for many restaurants (tenants). Each restaurant is one document, stored and
// backed up separately. A small "platform" document holds the registry of restaurants.
//   - PostgreSQL when DATABASE_URL is set (recommended; survives redeploys)
//   - JSON files in DATA_DIR otherwise (local dev / demos)
const fs = require('fs');
const path = require('path');
const { seed, migrate } = require('./seed');

const PLATFORM_ID = '__platform';
const LEGACY_ID = 'venue'; // the single restaurant of v0.x installs

class FileDriver {
  constructor(dir) { this.dir = dir; this.bdir = path.join(dir, 'backups'); }
  file(id) { return id === LEGACY_ID && fs.existsSync(path.join(this.dir, 'mehmaanos.json')) ? path.join(this.dir, 'mehmaanos.json') : path.join(this.dir, `${id}.json`); }
  async init() { fs.mkdirSync(this.bdir, { recursive: true }); }
  async load(id) { const f = this.file(id); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
  async write(id, doc) { const f = this.file(id), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(doc)); fs.renameSync(tmp, f); }
  async remove(id) { const f = this.file(id); if (fs.existsSync(f)) fs.unlinkSync(f); for (const b of fs.readdirSync(this.bdir).filter(x => x.startsWith(id + '-'))) fs.unlinkSync(path.join(this.bdir, b)); }
  async backup(id, doc) {
    fs.writeFileSync(path.join(this.bdir, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(doc));
    const files = fs.readdirSync(this.bdir).filter(f => f.startsWith(id + '-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 28))) fs.unlinkSync(path.join(this.bdir, f));
  }
  async listBackups(id) { return fs.readdirSync(this.bdir).filter(f => f.startsWith(id + '-')).sort().reverse(); }
  async close() {}
  get name() { return 'file'; }
}

class PgDriver {
  constructor(url) {
    const { Pool } = require('pg');
    const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: url, ssl, max: 5 });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mos_state (id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS mos_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), doc JSONB NOT NULL);
      ALTER TABLE mos_backups ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'venue';
      CREATE INDEX IF NOT EXISTS mos_backups_tenant ON mos_backups (tenant, id DESC);`);
  }
  async load(id) { const r = await this.pool.query(`SELECT doc FROM mos_state WHERE id=$1`, [id]); return r.rows[0]?.doc || null; }
  async write(id, doc) {
    await this.pool.query(`INSERT INTO mos_state (id, doc, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, [id, JSON.stringify(doc)]);
  }
  async remove(id) { await this.pool.query(`DELETE FROM mos_state WHERE id=$1`, [id]); await this.pool.query(`DELETE FROM mos_backups WHERE tenant=$1`, [id]); }
  async backup(id, doc) {
    await this.pool.query(`INSERT INTO mos_backups (tenant, doc) VALUES ($1, $2)`, [id, JSON.stringify(doc)]);
    await this.pool.query(`DELETE FROM mos_backups WHERE tenant=$1 AND id NOT IN (SELECT id FROM mos_backups WHERE tenant=$1 ORDER BY id DESC LIMIT 28)`, [id]);
  }
  async listBackups(id) { return (await this.pool.query(`SELECT id, created_at FROM mos_backups WHERE tenant=$1 ORDER BY id DESC`, [id])).rows.map(r => `${r.id} · ${r.created_at.toISOString()}`); }
  async close() { await this.pool.end(); }
  get name() { return 'postgres'; }
}

// One document with ordered, coalesced writes.
class Doc {
  constructor(driver, id, data) {
    this.driver = driver; this.id = id; this.data = data;
    this.pending = null; this.chain = Promise.resolve(); this.dirty = false; this.lastError = null; this.lastSavedAt = null;
    this.clients = new Set(); // realtime screens of this restaurant
  }
  save() {
    this.dirty = true;
    if (!this.pending) {
      const p = this.chain.then(() => new Promise(r => setTimeout(r, 25))).then(async () => {
        this.pending = null;
        if (!this.dirty) return;
        this.dirty = false;
        try { await this.driver.write(this.id, this.data); this.lastSavedAt = new Date().toISOString(); this.lastError = null; }
        catch (e) { this.dirty = true; this.lastError = e.message; console.error('save failed', this.id, e.message); throw e; }
      });
      this.pending = p; this.chain = p.catch(() => {});
    }
    return this.pending;
  }
  flush() { return this.save(); }
  audit(actor, action, detail) {
    this.data.audit.push({ at: new Date().toISOString(), actor, action, detail });
    if (this.data.audit.length > 5000) this.data.audit.splice(0, this.data.audit.length - 5000);
  }
  async listBackups() { return this.driver.listBackups(this.id); }
}

class Platform {
  constructor({ dataDir, databaseUrl }) {
    this.driver = databaseUrl ? new PgDriver(databaseUrl) : new FileDriver(dataDir);
    this.tenants = new Map(); // id -> Doc (loaded on demand)
  }
  async init() {
    await this.driver.init();
    let reg = await this.driver.load(PLATFORM_ID);
    if (!reg) {
      reg = { schema: 1, tenants: [] };
      // Upgrade path: a v0.x single-restaurant install becomes restaurant "main"; old QR links keep working.
      const legacy = await this.driver.load(LEGACY_ID);
      if (legacy) reg.tenants.push({ id: LEGACY_ID, slug: process.env.DEFAULT_SLUG || 'main', name: legacy.restaurant?.name || 'Restaurant', status: 'active', plan: 'pilot', legacy: true, createdAt: new Date().toISOString() });
    }
    this.registry = new Doc(this.driver, PLATFORM_ID, reg);
    await this.driver.write(PLATFORM_ID, reg);
    this.bt = setInterval(() => this.backupAll().catch(e => console.error('backup failed', e.message)), 6 * 3600e3); this.bt.unref();
  }
  list() { return this.registry.data.tenants; }
  find(slug) { return this.list().find(t => t.slug === slug) || null; }
  async open(entry) {
    if (this.tenants.has(entry.id)) return this.tenants.get(entry.id);
    const raw = await this.driver.load(entry.id);
    if (!raw) throw new Error('restaurant data missing: ' + entry.id);
    const doc = new Doc(this.driver, entry.id, migrate(raw));
    this.tenants.set(entry.id, doc);
    await doc.save();
    await this.driver.backup(entry.id, doc.data).catch(() => {});
    return doc;
  }
  async create(entry, data) {
    if (this.find(entry.slug)) throw new Error('slug taken');
    const doc = new Doc(this.driver, entry.id, data);
    await this.driver.write(entry.id, data);
    this.tenants.set(entry.id, doc);
    this.list().push(entry);
    await this.registry.save();
    return doc;
  }
  async remove(entry) {
    this.tenants.delete(entry.id);
    this.registry.data.tenants = this.list().filter(t => t.id !== entry.id);
    await this.registry.save();
    await this.driver.remove(entry.id);
  }
  async backupAll() { for (const [id, d] of this.tenants) await this.driver.backup(id, d.data); }
  async close() {
    clearInterval(this.bt);
    for (const d of [this.registry, ...this.tenants.values()]) if (d.dirty) await this.driver.write(d.id, d.data).catch(() => {});
    await this.driver.close();
  }
}

module.exports = { Platform, Doc, LEGACY_ID, seed };
