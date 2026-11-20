'use strict';
// End-to-end: boots the real server on a random port with a temp data dir.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');

let proc, base;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: port, DATA_DIR: dir, ADMIN_PIN: '9001', STAFF_PIN: '9002', KITCHEN_PIN: '9003' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
test.after(() => proc.kill());

const j = async (method, url, body, cookie) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

test('full flow: QR order -> approval -> kitchen -> served, with idempotency and auth', async () => {
  assert.strictEqual((await j('POST', '/api/login', { pin: '0000' })).status, 401);
  const admin = (await j('POST', '/api/login', { pin: '9001' })).cookie;
  const kitchen = (await j('POST', '/api/login', { pin: '9003' })).cookie;
  const { body: { tables } } = await j('GET', '/api/admin/tables', null, admin);
  const token = tables[0].url.split('/t/')[1];

  assert.strictEqual((await j('GET', '/api/guest/forged.token/menu')).status, 403);
  const menu = await j('GET', `/api/guest/${token}/menu`);
  assert.strictEqual(menu.status, 200);

  const cart = [{ itemId: 'kabuli', qty: 1 }, { itemId: 'mantu', qty: 2, spice: 'hot' }];
  const a = await j('POST', `/api/guest/${token}/orders`, { idemKey: 'abcdef123456', cart });
  const b = await j('POST', `/api/guest/${token}/orders`, { idemKey: 'abcdef123456', cart });
  assert.strictEqual(a.status, 201); assert.strictEqual(b.status, 200);
  assert.strictEqual(a.body.order.id, b.body.order.id, 'retry must not duplicate');
  assert.strictEqual(a.body.order.total, 350 + 560);
  assert.strictEqual(a.body.order.status, 'PendingApproval');

  const id = a.body.order.id;
  assert.strictEqual((await j('POST', `/api/orders/${id}/status`, { to: 'Accepted' }, kitchen)).status, 409, 'kitchen cannot approve');
  assert.strictEqual((await j('POST', `/api/orders/${id}/status`, { to: 'Accepted' })).status, 401);
  for (const [to, who] of [['Accepted', admin], ['InPreparation', kitchen], ['Ready', kitchen], ['Served', admin], ['Closed', admin]]) {
    const r = await j('POST', `/api/orders/${id}/status`, { to }, who);
    assert.strictEqual(r.status, 200, to);
  }
  const st = await j('GET', `/api/guest/${token}/orders?ids=${id}`);
  assert.strictEqual(st.body.orders[0].status, 'Closed');

  // old QR stops working after rotation
  await j('POST', `/api/admin/tables/${tables[0].id}/rotate`, {}, admin);
  assert.strictEqual((await j('GET', `/api/guest/${token}/menu`)).status, 403);

  // waiter request de-duplicates
  const t2 = tables[1].url.split('/t/')[1];
  const r1 = await j('POST', `/api/guest/${t2}/requests`, { type: 'waiter' });
  const r2 = await j('POST', `/api/guest/${t2}/requests`, { type: 'waiter' });
  assert.strictEqual(r1.body.request.id, r2.body.request.id);

  const csv = await j('GET', '/api/admin/export.csv', null, admin);
  assert.match(csv.body, /Kabuli Pulao/);
});
