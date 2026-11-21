'use strict';
// End-to-end: boots the real server on a random port with a temp data dir.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');

let proc, base;
async function boot(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const b = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: port, DATA_DIR: dir, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(b + '/healthz'); return { p, b }; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start');
}
test.before(async () => { ({ p: proc, b: base } = await boot({ ADMIN_PIN: '9001', STAFF_PIN: '9002', KITCHEN_PIN: '9003' })); });
test.after(() => proc.kill());

let ADMIN;
const adminLogin = async () => ADMIN || (ADMIN = (await j('POST', '/api/login', { pin: '9001' })).cookie);
const j = async (method, url, body, cookie) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

test('full flow: QR order -> approval -> kitchen -> served, with idempotency and auth', async () => {
  assert.strictEqual((await j('POST', '/api/login', { pin: '0000' })).status, 401);
  const admin = await adminLogin();
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

test('menu editor: add, edit, delete; allergen change voids sign-off; snapshots survive', async () => {
  const admin = await adminLogin();
  await j('POST', '/api/admin/allergen-review', { by: 'Manager Test' }, admin);
  assert.ok((await j('GET', '/api/admin/menu', null, admin)).body.allergenReview);
  const add = await j('POST', '/api/admin/items', { cat: 'mains', price: 410, name: { en: 'Qabili Special', fa: 'قابلی ویژه' }, allergens: ['nuts', 'bogus'] }, admin);
  assert.strictEqual(add.status, 200);
  assert.deepStrictEqual(add.body.item.allergens, ['nuts'], 'unknown allergen keys are dropped');
  assert.strictEqual((await j('GET', '/api/admin/menu', null, admin)).body.allergenReview, null, 'new allergen data needs fresh sign-off');
  assert.strictEqual((await j('POST', '/api/admin/items', { cat: 'nope', price: 1, name: { en: 'x' } }, admin)).status, 400);
  assert.strictEqual((await j('POST', '/api/admin/categories/mains/delete', {}, admin)).status, 409, 'non-empty category cannot be deleted');
  const id = add.body.item.id;
  const { body: { tables } } = await j('GET', '/api/admin/tables', null, admin);
  const tok = tables[2].url.split('/t/')[1];
  const o = await j('POST', `/api/guest/${tok}/orders`, { idemKey: 'menuedit0001', cart: [{ itemId: id, qty: 1 }] });
  assert.strictEqual(o.body.order.total, 410);
  await j('POST', `/api/admin/items/${id}/delete`, {}, admin);
  const after = await j('GET', `/api/guest/${tok}/orders?ids=${o.body.order.id}`);
  assert.strictEqual(after.body.orders[0].lines[0].name.en, 'Qabili Special');
  // staff (non-admin) cannot edit menu
  const staff = (await j('POST', '/api/login', { pin: '9002' })).cookie;
  assert.strictEqual((await j('POST', '/api/admin/items', { cat: 'mains', price: 1, name: { en: 'x' } }, staff)).status, 401);
});

test('named staff accounts: login, audit by name, deactivation kills session, unique PINs', async () => {
  const admin = await adminLogin();
  assert.strictEqual((await j('POST', '/api/admin/users', { name: 'Farid', role: 'staff', pin: '12' }, admin)).status, 400);
  const u = await j('POST', '/api/admin/users', { name: 'Farid', role: 'staff', pin: '482915' }, admin);
  assert.strictEqual(u.status, 201);
  assert.strictEqual((await j('POST', '/api/admin/users', { name: 'Dup', role: 'kitchen', pin: '482915' }, admin)).status, 409);
  const list = await j('GET', '/api/admin/users', null, admin);
  assert.ok(!JSON.stringify(list.body).includes('pinHash'), 'hashes never leave the server');
  const farid = await j('POST', '/api/login', { pin: '482915' });
  assert.strictEqual(farid.body.name, 'Farid');
  assert.strictEqual((await j('GET', '/api/state', null, farid.cookie)).status, 200);
  await j('POST', `/api/admin/users/${u.body.id}/deactivate`, {}, admin);
  assert.strictEqual((await j('GET', '/api/state', null, farid.cookie)).status, 401, 'deactivated user is locked out at once');
  const audit = await j('GET', '/api/admin/audit', null, admin);
  assert.ok(audit.body.audit.some(a => a.actor === 'Farid' && a.action === 'login'));
});

test('report and health endpoints', async () => {
  const admin = await adminLogin();
  const r = await j('GET', `/api/admin/report?date=${new Date().toISOString().slice(0, 10)}&tz=0`, null, admin);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.orders.total >= 2);
  const h = await j('GET', '/healthz');
  assert.strictEqual(h.body.ok, true);
  const b = await j('GET', '/api/admin/backup.json', null, admin);
  assert.ok(!('secret' in (typeof b.body === 'string' ? JSON.parse(b.body) : b.body)), 'backup never contains the signing secret');
});

test('setup PINs work only until a real admin exists', async () => {
  const { p, b } = await boot({});
  try {
    const jj = async (m, u, body, cookie) => { const r = await fetch(b + u, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
    const setup = await jj('POST', '/api/login', { pin: '1111' });
    assert.strictEqual(setup.status, 200);
    assert.strictEqual((await jj('POST', '/api/admin/users', { name: 'Owner', role: 'admin', pin: '7391' }, setup.cookie)).status, 201);
    assert.strictEqual((await jj('POST', '/api/login', { pin: '1111' })).status, 401, 'setup PIN disabled');
    assert.strictEqual((await jj('GET', '/api/state', null, setup.cookie)).status, 401, 'old setup session revoked');
    assert.strictEqual((await jj('POST', '/api/login', { pin: '7391' })).status, 200);
  } finally { p.kill(); }
});

test('Dubai setup: UAE preset gives AED, 5% VAT included, Arabic; orders carry VAT; old orders unchanged', async () => {
  const admin = await adminLogin();
  const { body: { tables: t0 } } = await j('GET', '/api/admin/tables', null, admin);
  const first = await j('POST', `/api/guest/${t0[5].url.split('/t/')[1]}/orders`, { idemKey: 'beforedubai1', cart: [{ itemId: 'naan', qty: 2 }] });
  const before = first.body.order;
  const s = await j('POST', '/api/admin/settings', { preset: 'AE', restaurantName: 'Kabul Darbar Dubai' }, admin);
  assert.deepStrictEqual([s.body.restaurant.currency, s.body.restaurant.tax.mode, s.body.restaurant.tax.rate], ['AED', 'inclusive', 500]);
  assert.ok(s.body.restaurant.languages.includes('ar'));
  // AED 42.00 = 4200 fils, with an Arabic name
  const it = await j('POST', '/api/admin/items', { cat: 'mains', price: 4200, name: { en: 'Kabuli Pulao (Dubai)', ar: 'كابلي بلاو' }, allergens: [] }, admin);
  assert.strictEqual(it.body.item.name.ar, 'كابلي بلاو');
  const { body: { tables } } = await j('GET', '/api/admin/tables', null, admin);
  const tok = tables[4].url.split('/t/')[1];
  const menu = await j('GET', `/api/guest/${tok}/menu`);
  assert.strictEqual(menu.body.restaurant.currency, 'AED');
  const o = await j('POST', `/api/guest/${tok}/orders`, { idemKey: 'dubai000001', cart: [{ itemId: it.body.item.id, qty: 2 }] });
  assert.strictEqual(o.body.order.total, 8400, 'guest pays exactly the menu price (VAT included)');
  assert.strictEqual(o.body.order.tax, 400, 'AED 84.00 incl. 5% VAT = AED 4.00 VAT');
  assert.strictEqual(o.body.order.currency, 'AED');
  const again = (await j('GET', '/api/state', null, admin)).body.orders.find(x => x.id === before.id);
  assert.strictEqual(again.total, before.total, 'earlier orders keep their original currency amounts');
  assert.strictEqual((await j('POST', '/api/admin/settings', { tax: { mode: 'inclusive', rate: 9000 } }, admin)).status, 400, 'absurd tax rate refused');
  const csv = await j('GET', '/api/admin/export.csv', null, admin);
  assert.match(csv.body, /"AED","2"/);
});
