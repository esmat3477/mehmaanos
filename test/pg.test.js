'use strict';
// Runs only when TEST_DATABASE_URL is set: proves data survives a restart on PostgreSQL.
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../lib/store');
const url = process.env.TEST_DATABASE_URL;

test('postgres driver persists across restarts and keeps backups', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url }); await pool.query('DROP TABLE IF EXISTS mos_state, mos_backups'); await pool.end();
  const a = new Store({ databaseUrl: url }); await a.init();
  a.data.restaurant.name = 'Persisted Kabul'; a.data.orders.push({ id: 'x', no: 1 });
  await Promise.all([a.save(), a.save(), a.save()]);
  await a.close();
  const b = new Store({ databaseUrl: url }); await b.init();
  assert.strictEqual(b.data.restaurant.name, 'Persisted Kabul');
  assert.strictEqual(b.data.orders.length, 1);
  assert.strictEqual(b.data.schema, 2);
  assert.ok((await b.driver.listBackups()).length >= 2);
  await b.close();
});
