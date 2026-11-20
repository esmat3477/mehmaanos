'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { quote, canTransition, OrderError } = require('../lib/orders');
const { seed } = require('../lib/seed');
const auth = require('../lib/auth');

const menu = () => seed().menu;

test('server computes totals from menu prices, ignoring client price', () => {
  const q = quote(menu(), [{ itemId: 'kabuli', qty: 2, price: 1 }, { itemId: 'naan', qty: 3 }]);
  assert.strictEqual(q.total, 350 * 2 + 30 * 3);
  assert.ok(q.lines.every(l => Number.isInteger(l.lineTotal)));
});
test('rejects empty cart, unknown items, bad quantities, unavailable items', () => {
  const m = menu();
  assert.throws(() => quote(m, []), OrderError);
  assert.throws(() => quote(m, [{ itemId: 'nope', qty: 1 }]), /no longer/);
  for (const qty of [0, -1, 1.5, 21, 'x']) assert.throws(() => quote(m, [{ itemId: 'naan', qty }]), /quantity/);
  m.items.find(i => i.id === 'naan').available = false;
  assert.throws(() => quote(m, [{ itemId: 'naan', qty: 1 }]), /not available/);
});
test('order lines snapshot the menu, later edits do not change them', () => {
  const m = menu();
  const q = quote(m, [{ itemId: 'mantu', qty: 1, spice: 'hot' }]);
  m.items.find(i => i.id === 'mantu').price = 999;
  m.items.find(i => i.id === 'mantu').name.en = 'Changed';
  assert.strictEqual(q.lines[0].unitPrice, 280);
  assert.strictEqual(q.lines[0].name.en, 'Mantu');
  assert.strictEqual(q.lines[0].spice, 'hot');
});
test('spice only on spicy items, invalid spice falls back to medium', () => {
  const q = quote(menu(), [{ itemId: 'mantu', qty: 1, spice: 'nuclear' }, { itemId: 'chai', qty: 1, spice: 'hot' }]);
  assert.strictEqual(q.lines[0].spice, 'medium');
  assert.strictEqual(q.lines[1].spice, null);
});
test('state machine enforces order and roles', () => {
  assert.ok(canTransition('PendingApproval', 'Accepted', 'staff'));
  assert.ok(!canTransition('PendingApproval', 'Accepted', 'kitchen'));
  assert.ok(canTransition('Accepted', 'InPreparation', 'kitchen'));
  assert.ok(!canTransition('Accepted', 'Ready', 'kitchen'), 'cannot skip preparation');
  assert.ok(!canTransition('Closed', 'Accepted', 'admin'), 'closed is final');
  assert.ok(!canTransition('Ready', 'Canceled', 'staff'));
});
test('table QR tokens verify and are revoked by rotation', () => {
  const tables = seed().tables;
  const tok = auth.tableToken('s3cret', tables[0]);
  assert.strictEqual(auth.verifyTableToken('s3cret', tables, tok).id, 'T1');
  assert.strictEqual(auth.verifyTableToken('other', tables, tok), null);
  assert.strictEqual(auth.verifyTableToken('s3cret', tables, tok.replace(/.$/, c => c === 'A' ? 'B' : 'A')), null);
  tables[0].nonce++;
  assert.strictEqual(auth.verifyTableToken('s3cret', tables, tok), null);
});
test('staff sessions reject tampered roles', () => {
  const c = auth.sessionCookie('k', 'kitchen');
  assert.strictEqual(auth.verifySession('k', c), 'kitchen');
  assert.strictEqual(auth.verifySession('k', c.replace('kitchen', 'admin')), null);
});
