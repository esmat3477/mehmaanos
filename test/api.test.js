'use strict';
// End-to-end: boots the real server on a random port with a temp data dir.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');

let proc, root, base;
async function boot(env, dir) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'mos-'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const b = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: port, DATA_DIR: dir, SIGNUP_LIMIT: '100', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(b + '/healthz'); return { p, b }; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start');
}
// raw request against the platform root
const raw = async (method, url, body, cookie, host = root) => {
  const r = await fetch(host + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, location: r.headers.get('location'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
async function signup(slug, pin, extra = {}) {
  const r = await raw('POST', '/api/signup', { restaurantName: 'Test ' + slug, slug, country: 'AF', ownerName: 'Owner ' + slug, contact: 'owner@example.com', pin, demoMenu: true, terms: true, ...extra });
  return r;
}
let ADMIN;
const adminLogin = async () => ADMIN;
const j = async (method, url, body, cookie) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
test.before(async () => {
  ({ p: proc, b: root } = await boot({ PLATFORM_PIN: '7777777777' }));
  const s = await signup('test-resto', '900100');
  assert.strictEqual(s.status, 201, JSON.stringify(s.body));
  base = `${root}/r/test-resto`;
  ADMIN = s.cookie;
  await j('POST', '/api/admin/users', { name: 'Waiter One', role: 'staff', pin: '9002' }, ADMIN);
  await j('POST', '/api/admin/users', { name: 'Cook One', role: 'kitchen', pin: '9003' }, ADMIN);
});
test.after(() => proc.kill());

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
  const h = await raw('GET', '/healthz');
  assert.strictEqual(h.body.ok, true);
  const b = await j('GET', '/api/admin/backup.json', null, admin);
  assert.ok(!('secret' in (typeof b.body === 'string' ? JSON.parse(b.body) : b.body)), 'backup never contains the signing secret');
});

test('upgrade from single-restaurant install: becomes /r/main, old links redirect, setup PINs until a manager exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-legacy-'));
  const old = require('../lib/seed').seed(); old.schema = 2; old.secret = 'legacysecret'; old.restaurant = { name: 'Old Place', currency: 'AFN', demo: true };
  fs.writeFileSync(path.join(dir, 'mehmaanos.json'), JSON.stringify(old));
  const { p, b } = await boot({}, dir);
  try {
    const qr = require('../lib/auth').tableToken('legacysecret', old.tables[0]);
    const red = await raw('GET', `/t/${qr}`, null, null, b);
    assert.strictEqual(red.status, 302); assert.strictEqual(red.location, `/r/main/t/${qr}`);
    const menu = await raw('GET', `/r/main/api/guest/${qr}/menu`, null, null, b);
    assert.strictEqual(menu.status, 200, 'printed QR codes from the old install still work');
    assert.strictEqual(menu.body.restaurant.name, 'Old Place');
    const setup = await raw('POST', '/r/main/api/login', { pin: '1111' }, null, b);
    assert.strictEqual(setup.status, 200);
    assert.strictEqual((await raw('POST', '/r/main/api/admin/users', { name: 'Owner', role: 'admin', pin: '739100' }, setup.cookie, b)).status, 201);
    assert.strictEqual((await raw('POST', '/r/main/api/login', { pin: '1111' }, null, b)).status, 401, 'setup PIN disabled');
    assert.strictEqual((await raw('GET', '/r/main/api/state', null, setup.cookie, b)).status, 401, 'old setup session revoked');
  } finally { p.kill(); }
});

test('isolation: one restaurant can never see or change another', async () => {
  const s = await signup('other-place', '515000');
  assert.strictEqual(s.status, 201);
  const B = s.cookie;
  const rawB = (m, u, body, c) => raw(m, '/r/other-place' + u, body, c);
  // B's session is useless at A, and A's at B
  assert.strictEqual((await j('GET', '/api/state', null, B)).status, 401);
  assert.strictEqual((await rawB('GET', '/api/state', null, ADMIN)).status, 401);
  // A's PIN does not log in at B
  assert.strictEqual((await rawB('POST', '/api/login', { pin: '900100' })).status, 401);
  // A's table QR token is rejected at B (signed with a different secret)
  const { body: { tables } } = await j('GET', '/api/admin/tables', null, ADMIN);
  const tokA = tables[0].url.split('/t/')[1];
  assert.strictEqual((await rawB('GET', `/api/guest/${tokA}/menu`)).status, 403);
  // B sees none of A's orders, users or audit
  const stB = (await rawB('GET', '/api/state', null, B)).body;
  assert.strictEqual(stB.orders.length, 0);
  const usersB = (await rawB('GET', '/api/admin/users', null, B)).body.users;
  assert.deepStrictEqual(usersB.map(u => u.name), ['Owner other-place']);
  // A's order ids cannot be moved by B
  const anyA = (await j('GET', '/api/state', null, ADMIN)).body.orders[0];
  if (anyA) assert.strictEqual((await rawB('POST', `/api/orders/${anyA.id}/status`, { to: 'Canceled' }, B)).status, 404);
  // Cookies are scoped to each restaurant's path
  assert.match((await rawB('POST', '/api/login', { pin: '515000' })).cookie, /^mos=/);
});

test('signup rules: unique and valid web address, PIN, terms', async () => {
  assert.strictEqual((await signup('test-resto', '1234')).status, 409, 'taken');
  assert.strictEqual((await signup('api', '1234')).status, 400, 'reserved');
  assert.strictEqual((await signup('Bad Slug!', '1234')).status, 400);
  assert.strictEqual((await signup('fine-slug', '12')).status, 400, 'short PIN');
  assert.strictEqual((await signup('fine-slug', '1234', { terms: false })).status, 400);
  const chk = await raw('GET', '/api/signup/check?slug=test-resto');
  assert.strictEqual(chk.body.available, false);
  const ae = await signup('dubai-demo', '246800', { country: 'AE' });
  const st = (await raw('GET', '/r/dubai-demo/api/admin/menu', null, ae.cookie)).body;
  assert.strictEqual(st.items.find(i => i.id === 'kabuli').price, 1800, 'sample menu gets AED prices (AED 18.00)');
});

test('owner console: list, suspend locks guests and staff, reactivate, delete', async () => {
  assert.strictEqual((await raw('GET', '/api/platform/tenants')).status, 401);
  assert.strictEqual((await raw('POST', '/api/platform/login', { pin: '000000' })).status, 401);
  const P = (await raw('POST', '/api/platform/login', { pin: '7777777777' })).cookie;
  const list = (await raw('GET', '/api/platform/tenants', null, P)).body.tenants;
  const other = list.find(t => t.slug === 'other-place');
  assert.ok(other && other.status === 'trial' && other.trialEndsAt);
  assert.ok(!JSON.stringify(list).includes('pinHash') && !JSON.stringify(list).includes('secret'));
  await raw('POST', `/api/platform/tenants/${other.id}`, { status: 'suspended' }, P);
  assert.strictEqual((await raw('POST', '/r/other-place/api/login', { pin: '515000' })).status, 423);
  await raw('POST', `/api/platform/tenants/${other.id}`, { status: 'active', paidUntil: '2027-01-31' }, P);
  assert.strictEqual((await raw('POST', '/r/other-place/api/login', { pin: '515000' })).status, 200);
  const exp = await raw('GET', `/api/platform/tenants/${other.id}/export`, null, P);
  assert.ok(!/pinHash|"secret"/.test(typeof exp.body === 'string' ? exp.body : JSON.stringify(exp.body)), 'export holds no PIN hashes or secrets');
  assert.strictEqual((await raw('POST', `/api/platform/tenants/${other.id}/delete`, { confirm: 'wrong' }, P)).status, 400);
  assert.strictEqual((await raw('POST', `/api/platform/tenants/${other.id}/delete`, { confirm: 'other-place' }, P)).status, 200);
  assert.strictEqual((await raw('GET', '/r/other-place/api/state')).status, 404);
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

test('security: PIN change signs the person out, manager PINs need 6 digits, CSV formulas neutralised', async () => {
  const admin = await adminLogin();
  assert.strictEqual((await j('POST', '/api/admin/users', { name: 'Weak Boss', role: 'admin', pin: '4321' }, admin)).status, 400);
  const u = await j('POST', '/api/admin/users', { name: 'Zahra', role: 'staff', pin: '246810' }, admin);
  const z = (await j('POST', '/api/login', { pin: '246810' })).cookie;
  assert.strictEqual((await j('GET', '/api/state', null, z)).status, 200);
  await j('POST', `/api/admin/users/${u.body.id}/pin`, { pin: '135790' }, admin);
  assert.strictEqual((await j('GET', '/api/state', null, z)).status, 401, 'old session ends after PIN change');
  assert.strictEqual((await j('POST', '/api/login', { pin: '246810' })).status, 401, 'old PIN no longer works');
  assert.strictEqual((await j('POST', '/api/login', { pin: '135790' })).status, 200);
  // spreadsheet formula in a guest note is neutralised in the CSV
  const { body: { tables } } = await j('GET', '/api/admin/tables', null, admin);
  const tok = tables[1].url.split('/t/')[1];
  await j('POST', `/api/guest/${tok}/orders`, { idemKey: 'csvinject01', cart: [{ itemId: 'naan', qty: 1, note: '=HYPERLINK("http://evil")' }] });
  await j('POST', '/api/admin/items', { cat: 'mains', price: 100, name: { en: '=cmd|calc' } }, admin);
  const csv = (await j('GET', '/api/admin/export.csv', null, admin)).body;
  assert.ok(!/"=/.test(csv), 'no cell starts with =');
});

test('security: forged X-Forwarded-For cannot bypass login limits (no trusted proxy)', async () => {
  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` }, body: JSON.stringify({ pin: '000000' }) });
    if (r.status === 429) { blocked = true; break; }
  }
  assert.ok(blocked, 'rate limit applies to the real connection, not the forged header');
});

test('owner console: reset a locked-out manager PIN', async () => {
  const P = (await raw('POST', '/api/platform/login', { pin: '7777777777' })).cookie;
  const t = (await raw('GET', '/api/platform/tenants', null, P)).body.tenants.find(x => x.slug === 'dubai-demo');
  const r = await raw('POST', `/api/platform/tenants/${t.id}/reset-pin`, {}, P);
  assert.strictEqual(r.status, 200); assert.match(r.body.pin, /^\d{6}$/);
  assert.strictEqual((await raw('POST', '/r/dubai-demo/api/login', { pin: r.body.pin })).status, 200);
  assert.strictEqual((await raw('POST', '/r/dubai-demo/api/login', { pin: '246800' })).status, 401, 'old manager PIN replaced');
});

test('archiving: old finished orders move to monthly archives; report and CSV still include them', async () => {
  // Use the platform library directly on a fresh data folder with orders dated 3 months ago.
  const { Platform, seed } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-arc-'));
  const pf = new Platform({ dataDir: dir }); await pf.init();
  const data = seed();
  const old = new Date(Date.now() - 90 * 864e5).toISOString();
  for (let i = 1; i <= 500; i++) data.orders.push({ id: 'o' + i, no: i, tableId: 'T1', status: i % 10 ? 'Closed' : 'Canceled', total: 100, tax: 0, createdAt: old, lines: [{ itemId: 'naan', name: { en: 'Afghan naan' }, qty: 1, lineTotal: 100 }], events: [] });
  data.orders.push({ id: 'live', no: 501, tableId: 'T1', status: 'Accepted', total: 50, createdAt: old, lines: [], events: [] }); // unfinished: must stay live
  await pf.create({ id: 't_arc', slug: 'arc', name: 'Arc', status: 'trial' }, data);
  pf.tenants.clear();
  const doc = await pf.open(pf.find('arc')); // archiving runs on open
  assert.deepStrictEqual(doc.data.orders.map(o => o.id), ['live'], 'only the unfinished order stays live');
  assert.strictEqual(doc.data.archives.length, 1);
  const day = old.slice(0, 10), from = Date.parse(day + 'T00:00:00Z');
  const span = await pf.ordersBetween(doc, from, from + 864e5);
  const { dailyReport } = require('../lib/report');
  const r = dailyReport({ ...doc.data, orders: span.orders, requests: span.requests }, day, 0);
  assert.strictEqual(r.orders.total, 501, 'report for an old day still sees every order');
  assert.strictEqual(r.exceptions.length, 50);
  assert.strictEqual((await pf.allArchived(doc)).orders.length, 500);
  await pf.remove(pf.find('arc'));
  assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('t_arc')), 'deleting a restaurant also deletes its archives');
  await pf.close();
});
