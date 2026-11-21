'use strict';
// Runs only when TEST_DATABASE_URL is set: proves data survives a restart on PostgreSQL, per restaurant.
const test = require('node:test');
const assert = require('node:assert');
const { Platform, seed } = require('../lib/store');
const url = process.env.TEST_DATABASE_URL;

test('postgres: restaurants persist across restarts, stay separate, keep backups', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url }); await pool.query('DROP TABLE IF EXISTS mos_state, mos_backups'); await pool.end();
  const a = new Platform({ databaseUrl: url }); await a.init();
  const d1 = seed(); d1.restaurant.name = 'Kabul One';
  const d2 = seed(); d2.restaurant.name = 'Dubai Two';
  await a.create({ id: 't_1', slug: 'one', name: 'Kabul One', status: 'trial' }, d1);
  await a.create({ id: 't_2', slug: 'two', name: 'Dubai Two', status: 'trial' }, d2);
  const doc = await a.open(a.find('one'));
  doc.data.orders.push({ id: 'x', no: 1 });
  await Promise.all([doc.save(), doc.save(), doc.save()]);
  await a.close();
  const b = new Platform({ databaseUrl: url }); await b.init();
  assert.deepStrictEqual(b.list().map(t => t.slug), ['one', 'two']);
  const one = await b.open(b.find('one')), two = await b.open(b.find('two'));
  assert.strictEqual(one.data.restaurant.name, 'Kabul One');
  assert.strictEqual(one.data.orders.length, 1);
  assert.strictEqual(two.data.orders.length, 0, 'restaurants do not share data');
  assert.strictEqual(one.data.schema, 3);
  assert.ok((await one.listBackups()).length >= 1);
  await b.remove(b.find('two'));
  assert.strictEqual(b.find('two'), null);
  await b.close();
});
