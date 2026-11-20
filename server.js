'use strict';
// MehmaanOS pilot server. Zero runtime dependencies (Node >= 18).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { quote, canTransition, OrderError, ACTIVE } = require('./lib/orders');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT || 3000);
const { ALLERGENS } = require('./lib/seed');
const { dailyReport } = require('./lib/report');
const store = new Store({ dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'), databaseUrl: process.env.DATABASE_URL });
const D = () => store.data;
let SECRET;

// Login sources, in order: named staff accounts (Admin > Staff), then env PINs,
// then built-in setup PINs 1111/2222/3333 ONLY while no env PINs and no admin account exist.
const ENV_PINS = { admin: process.env.ADMIN_PIN, staff: process.env.STAFF_PIN, kitchen: process.env.KITCHEN_PIN };
const SETUP_PINS = { admin: '1111', staff: '2222', kitchen: '3333' };
const hasEnvPins = () => Object.values(ENV_PINS).some(Boolean);
const setupMode = () => !hasEnvPins() && !D().users.some(u => u.active && u.role === 'admin');

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PUB = path.join(__dirname, 'public');

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function err(res, e) {
  if (e instanceof OrderError) return send(res, e.status, { error: e.code, message: e.message });
  console.error(e);
  send(res, 500, { error: 'SERVER', message: 'Something went wrong' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 32 * 1024) { reject(new OrderError('TOO_LARGE', 'Request too large', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new OrderError('BAD_JSON', 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
// Returns { role, uid, name } for a valid session, or null. Deactivated users are rejected immediately.
function who(req) {
  const s = auth.verifySession(SECRET, cookies(req).mos);
  if (!s) return null;
  if (s.uid === 'setup' && !setupMode()) return null; // setup PINs die as soon as a real admin exists
  if (s.uid === 'env' && !ENV_PINS[s.role]) return null;
  if (s.uid === 'env' || s.uid === 'setup') return { ...s, name: `${s.role} (${s.uid === 'env' ? 'shared PIN' : 'setup PIN'})` };
  const u = D().users.find(x => x.id === s.uid);
  if (!u || !u.active || u.role !== s.role) return null;
  return { ...s, name: u.name };
}
function need(req, roles) {
  const w = who(req);
  if (!w || !roles.includes(w.role)) throw new OrderError('UNAUTHORIZED', 'Please sign in', 401);
  return w;
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function ip(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
const now = () => new Date().toISOString();

// Simple fixed-window rate limiter.
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key);
  if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return false; }
  b.n++; return b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---------- realtime (SSE) ----------
const clients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25e3).unref();

// ---------- views ----------
function publicOrder(o) {
  return { id: o.id, no: o.no, tableId: o.tableId, status: o.status, lines: o.lines, total: o.total, createdAt: o.createdAt, events: o.events };
}
function guestMenu() {
  const m = D().menu;
  return {
    restaurant: D().restaurant,
    orderingPaused: D().settings.orderingPaused,
    menu: { version: m.version, categories: m.categories, items: m.items, allergenReview: m.allergenReview }
  };
}
function staffState() {
  const d = D();
  const since = Date.now() - 12 * 3600e3;
  return {
    restaurant: d.restaurant, settings: d.settings, defaultPins: setupMode(),
    tables: d.tables.map(t => ({ id: t.id, label: t.label })),
    orders: d.orders.filter(o => ACTIVE.includes(o.status) || Date.parse(o.createdAt) > since).map(publicOrder),
    requests: d.requests.filter(r => r.status !== 'closed' || Date.parse(r.createdAt) > since)
  };
}

// ---------- order actions ----------
function createOrder(table, body) {
  const d = D();
  if (d.settings.orderingPaused) throw new OrderError('PAUSED', 'Ordering is paused. Please ask a waiter.', 409);
  const idem = String(body.idemKey || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idem)) throw new OrderError('BAD_IDEM', 'Missing idempotency key');
  // Idempotency: the same table + key always returns the same order, never a duplicate.
  const existing = d.orders.find(o => o.tableId === table.id && o.idemKey === idem);
  if (existing) return { order: existing, duplicate: true };
  const open = d.orders.filter(o => o.tableId === table.id && ['PendingApproval', 'Accepted', 'InPreparation'].includes(o.status)).length;
  if (open >= 5) throw new OrderError('TOO_MANY_OPEN', 'This table has several open orders. Please ask a waiter.', 429);
  const q = quote(d.menu, body.cart);
  d.counters.order++;
  const status = d.settings.requireApproval ? 'PendingApproval' : 'Accepted';
  const order = {
    id: crypto.randomUUID(), no: d.counters.order, tableId: table.id, idemKey: idem,
    status, lines: q.lines, total: q.total, menuVersion: q.menuVersion, currency: d.restaurant.currency,
    createdAt: now(), events: [{ at: now(), status, actor: 'guest' }]
  };
  d.orders.push(order);
  store.audit('guest:' + table.id, 'order.create', { no: order.no, total: order.total });
  return { order, duplicate: false };
}

function transition(orderId, to, actor, reason) {
  const role = actor.role;
  const o = D().orders.find(x => x.id === orderId);
  if (!o) throw new OrderError('NOT_FOUND', 'Order not found', 404);
  if (!canTransition(o.status, to, role)) throw new OrderError('BAD_TRANSITION', `Cannot move order from ${o.status} to ${to}`, 409);
  const from = o.status;
  o.status = to;
  o.events.push({ at: now(), status: to, actor: actor.name, role, reason: reason ? String(reason).slice(0, 200) : undefined });
  store.audit(actor.name, 'order.status', { no: o.no, from, to, reason });
  store.save();
  broadcast('order', publicOrder(o));
  return o;
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const M = req.method;

  // security headers on everything
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");

  if (p === '/healthz') return send(res, store.lastError ? 503 : 200, { ok: !store.lastError, storage: store.driver.name, lastSavedAt: store.lastSavedAt, error: store.lastError || undefined });

  // ----- pages -----
  const pages = { '/': 'index.html', '/kitchen': 'kitchen.html', '/staff': 'staff.html', '/admin': 'admin.html', '/login': 'login.html', '/guide': 'guide.html' };
  if (M === 'GET' && pages[p]) return serveFile(res, pages[p]);
  if (M === 'GET' && p.startsWith('/t/')) return serveFile(res, 'guest.html');
  if (M === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8));

  try {
    // ----- guest API -----
    const g = p.match(/^\/api\/guest\/([^/]+)(\/.*)?$/);
    if (g) {
      const table = auth.verifyTableToken(SECRET, D().tables, g[1]);
      if (!table) throw new OrderError('BAD_TABLE', 'This table code is not valid. Please ask a waiter.', 403);
      const sub = g[2] || '';
      if (M === 'GET' && sub === '/menu') return send(res, 200, { table: { id: table.id, label: table.label }, ...guestMenu() });
      if (M === 'POST' && sub === '/orders') {
        if (limited('ord:' + table.id, 6, 60e3) || limited('ordip:' + ip(req), 10, 60e3)) throw new OrderError('RATE', 'Too many orders. Please wait a moment.', 429);
        const { order, duplicate } = createOrder(table, await readBody(req));
        if (!duplicate) {
          // Do not confirm to the guest until the order is durably stored.
          try { await store.flush(); } catch { D().orders = D().orders.filter(o => o !== order); throw new OrderError('STORAGE', 'Could not save your order. Please try again or ask a waiter.', 503); }
          broadcast('order', publicOrder(order));
        }
        return send(res, duplicate ? 200 : 201, { order: publicOrder(order), duplicate });
      }
      if (M === 'GET' && sub === '/orders') {
        const ids = (url.searchParams.get('ids') || '').split(',').slice(0, 20);
        const list = D().orders.filter(o => o.tableId === table.id && ids.includes(o.id)).map(publicOrder);
        const reqs = D().requests.filter(r => r.tableId === table.id && r.status !== 'closed');
        return send(res, 200, { orders: list, requests: reqs });
      }
      if (M === 'POST' && sub === '/requests') {
        const body = await readBody(req);
        const type = ['waiter', 'bill', 'water'].includes(body.type) ? body.type : 'waiter';
        const dup = D().requests.find(r => r.tableId === table.id && r.type === type && r.status !== 'closed');
        if (dup) return send(res, 200, { request: dup, duplicate: true });
        if (limited('req:' + table.id, 4, 60e3)) throw new OrderError('RATE', 'Please wait a moment before calling again.', 429);
        D().counters.request++;
        const r = { id: crypto.randomUUID(), no: D().counters.request, tableId: table.id, type, status: 'open', createdAt: now() };
        D().requests.push(r);
        store.audit('guest:' + table.id, 'request.create', { type });
        store.save(); broadcast('request', r);
        return send(res, 201, { request: r });
      }
      throw new OrderError('NOT_FOUND', 'Not found', 404);
    }

    // ----- auth -----
    if (M === 'POST' && p === '/api/login') {
      if (limited('login:' + ip(req), 8, 5 * 60e3)) throw new OrderError('RATE', 'Too many attempts. Try again in a few minutes.', 429);
      const { pin } = await readBody(req);
      const pinStr = String(pin || '');
      let found = null;
      const rank = { admin: 0, staff: 1, kitchen: 2 };
      for (const u of D().users.filter(u => u.active).sort((a, b) => rank[a.role] - rank[b.role])) {
        if (auth.checkPin(pinStr, u.pinHash)) { found = { role: u.role, uid: u.id, name: u.name }; break; }
      }
      if (!found) for (const r of ['admin', 'staff', 'kitchen']) if (ENV_PINS[r] && auth.safeEq(ENV_PINS[r], pinStr)) { found = { role: r, uid: 'env', name: `${r} (shared PIN)` }; break; }
      if (!found && setupMode()) for (const r of ['admin', 'staff', 'kitchen']) if (auth.safeEq(SETUP_PINS[r], pinStr)) { found = { role: r, uid: 'setup', name: `${r} (setup PIN)` }; break; }
      if (!found) { store.audit('anon', 'login.fail', { ip: ip(req) }); store.save(); throw new OrderError('BAD_PIN', 'Wrong PIN', 401); }
      store.audit(found.name, 'login', { ip: ip(req), role: found.role }); store.save();
      const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
      return send(res, 200, { role: found.role, name: found.name }, { 'Set-Cookie': `mos=${auth.sessionCookie(SECRET, found.role, found.uid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=50400${secure}` });
    }
    if (M === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'mos=; Path=/; Max-Age=0' });
    if (M === 'GET' && p === '/api/me') { const w = who(req); return send(res, 200, { role: w?.role || null, name: w?.name || null }); }

    // ----- staff / kitchen -----
    if (M === 'GET' && p === '/api/stream') {
      need(req, ['kitchen', 'staff', 'admin']);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (M === 'GET' && p === '/api/state') { need(req, ['kitchen', 'staff', 'admin']); return send(res, 200, staffState()); }

    const os = p.match(/^\/api\/orders\/([\w-]+)\/status$/);
    if (M === 'POST' && os) {
      const actor = need(req, ['kitchen', 'staff', 'admin']);
      const body = await readBody(req);
      return send(res, 200, { order: publicOrder(transition(os[1], String(body.to), actor, body.reason)) });
    }
    const rq = p.match(/^\/api\/requests\/([\w-]+)\/(claim|close)$/);
    if (M === 'POST' && rq) {
      const role = need(req, ['staff', 'admin']).name;
      const r = D().requests.find(x => x.id === rq[1]);
      if (!r) throw new OrderError('NOT_FOUND', 'Request not found', 404);
      if (rq[2] === 'claim' && r.status === 'open') { r.status = 'claimed'; r.claimedAt = now(); r.claimedBy = role; }
      else if (rq[2] === 'close' && r.status !== 'closed') { r.status = 'closed'; r.closedAt = now(); r.closedBy = role; }
      else throw new OrderError('BAD_TRANSITION', 'Request already ' + r.status, 409);
      store.audit(role, 'request.' + rq[2], { no: r.no, table: r.tableId }); store.save(); broadcast('request', r);
      return send(res, 200, { request: r });
    }

    // ----- admin -----
    if (p.startsWith('/api/admin/')) {
      const role = need(req, ['admin', ...(p === '/api/admin/availability' ? ['staff'] : [])]).name;
      const d = D();
      if (M === 'GET' && p === '/api/admin/menu') return send(res, 200, d.menu);
      if (M === 'POST' && p === '/api/admin/availability') {
        const { itemId, available } = await readBody(req);
        const it = d.menu.items.find(i => i.id === itemId);
        if (!it) throw new OrderError('NOT_FOUND', 'Item not found', 404);
        it.available = !!available;
        store.audit(role, 'menu.availability', { itemId, available: it.available }); store.save();
        broadcast('menu', { itemId, available: it.available });
        return send(res, 200, { item: it });
      }
      if (M === 'POST' && p === '/api/admin/price') {
        const { itemId, price } = await readBody(req);
        const it = d.menu.items.find(i => i.id === itemId);
        if (!it) throw new OrderError('NOT_FOUND', 'Item not found', 404);
        const n = Number(price);
        if (!Number.isInteger(n) || n < 0 || n > 1e7) throw new OrderError('BAD_PRICE', 'Price must be a whole number');
        const old = it.price; it.price = n; d.menu.version++; d.menu.publishedAt = now();
        store.audit(role, 'menu.price', { itemId, from: old, to: n, version: d.menu.version }); store.save();
        broadcast('menu', { itemId });
        return send(res, 200, { item: it, version: d.menu.version });
      }
      if (M === 'POST' && p === '/api/admin/allergen-review') {
        const { by } = await readBody(req);
        const name = String(by || '').trim().slice(0, 60);
        if (!name) throw new OrderError('BAD_NAME', 'Reviewer name required');
        d.menu.allergenReview = { by: name, at: now(), version: d.menu.version };
        store.audit(role, 'menu.allergen_review', d.menu.allergenReview); store.save();
        return send(res, 200, d.menu.allergenReview);
      }
      if (M === 'POST' && p === '/api/admin/settings') {
        const b = await readBody(req);
        if (typeof b.requireApproval === 'boolean') d.settings.requireApproval = b.requireApproval;
        if (typeof b.orderingPaused === 'boolean') d.settings.orderingPaused = b.orderingPaused;
        if (typeof b.restaurantName === 'string' && b.restaurantName.trim()) d.restaurant.name = b.restaurantName.trim().slice(0, 80);
        store.audit(role, 'settings', b); store.save(); broadcast('settings', d.settings);
        return send(res, 200, { settings: d.settings, restaurant: d.restaurant });
      }
      if (M === 'GET' && p === '/api/admin/tables') {
        const base = baseUrl(req);
        return send(res, 200, { tables: d.tables.map(t => ({ ...t, url: `${base}/t/${auth.tableToken(SECRET, t)}` })) });
      }
      if (M === 'POST' && p === '/api/admin/tables') {
        const { label } = await readBody(req);
        const id = 'T' + (d.tables.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0) + 1);
        d.tables.push({ id, label: String(label || id).slice(0, 20), nonce: 1 });
        store.audit(role, 'table.add', { id }); store.save();
        return send(res, 201, { id });
      }
      const rot = p.match(/^\/api\/admin\/tables\/(\w+)\/rotate$/);
      if (M === 'POST' && rot) {
        const t = d.tables.find(x => x.id === rot[1]);
        if (!t) throw new OrderError('NOT_FOUND', 'Table not found', 404);
        t.nonce++;
        store.audit(role, 'table.rotate_qr', { id: t.id, nonce: t.nonce }); store.save();
        return send(res, 200, { ok: true });
      }
      // ----- menu editor -----
      const LANGS = ['en', 'fa', 'ps'];
      const txt = (o, max, required) => {
        const out = {};
        for (const l of LANGS) out[l] = String((o && o[l]) || '').trim().slice(0, max);
        if (required && !out.en) throw new OrderError('BAD_NAME', 'English name is required');
        return out;
      };
      const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const bump = () => { d.menu.version++; d.menu.publishedAt = now(); };
      if (M === 'POST' && p === '/api/admin/items') {
        const b = await readBody(req);
        if (!d.menu.categories.some(c => c.id === b.cat)) throw new OrderError('BAD_CAT', 'Choose a category');
        const price = Number(b.price);
        if (!Number.isInteger(price) || price < 0 || price > 1e7) throw new OrderError('BAD_PRICE', 'Price must be a whole number');
        const allergens = [...new Set((Array.isArray(b.allergens) ? b.allergens : []).filter(a => ALLERGENS.includes(a)))];
        const fields = { cat: b.cat, price, spicy: !!b.spicy, name: txt(b.name, 60, true), desc: txt(b.desc, 160, false), allergens };
        let it = b.id ? d.menu.items.find(i => i.id === b.id) : null;
        if (b.id && !it) throw new OrderError('NOT_FOUND', 'Item not found', 404);
        if (it) {
          // Any allergen change invalidates the manager's allergen sign-off.
          if ([...it.allergens].sort().join() !== [...allergens].sort().join()) d.menu.allergenReview = null;
          Object.assign(it, fields);
        } else {
          let id = slug(fields.name.en) || 'item'; while (d.menu.items.some(i => i.id === id)) id += '-2';
          it = { id, available: true, ...fields };
          d.menu.items.push(it);
          if (allergens.length) d.menu.allergenReview = null;
        }
        bump(); store.audit(role, b.id ? 'menu.item.edit' : 'menu.item.add', { id: it.id, price, version: d.menu.version }); store.save();
        broadcast('menu', { itemId: it.id });
        return send(res, 200, { item: it });
      }
      const delItem = p.match(/^\/api\/admin\/items\/([\w-]+)\/delete$/);
      if (M === 'POST' && delItem) {
        const i = d.menu.items.findIndex(x => x.id === delItem[1]);
        if (i < 0) throw new OrderError('NOT_FOUND', 'Item not found', 404);
        const [gone] = d.menu.items.splice(i, 1); // past orders keep their own snapshot
        bump(); store.audit(role, 'menu.item.delete', { id: gone.id, name: gone.name.en }); store.save();
        broadcast('menu', { itemId: gone.id });
        return send(res, 200, { ok: true });
      }
      if (M === 'POST' && p === '/api/admin/categories') {
        const b = await readBody(req);
        const name = txt(b.name, 40, true);
        let c = b.id ? d.menu.categories.find(x => x.id === b.id) : null;
        if (c) c.name = name;
        else { let id = slug(name.en) || 'cat'; while (d.menu.categories.some(x => x.id === id)) id += '-2'; c = { id, name }; d.menu.categories.push(c); }
        if (Number.isInteger(b.move) && b.move) {
          const i = d.menu.categories.indexOf(c), j = Math.max(0, Math.min(d.menu.categories.length - 1, i + b.move));
          d.menu.categories.splice(i, 1); d.menu.categories.splice(j, 0, c);
        }
        bump(); store.audit(role, 'menu.category.save', { id: c.id }); store.save(); broadcast('menu', {});
        return send(res, 200, { category: c });
      }
      const delCat = p.match(/^\/api\/admin\/categories\/([\w-]+)\/delete$/);
      if (M === 'POST' && delCat) {
        if (d.menu.items.some(i => i.cat === delCat[1])) throw new OrderError('NOT_EMPTY', 'Move or delete the dishes in this category first', 409);
        d.menu.categories = d.menu.categories.filter(c => c.id !== delCat[1]);
        bump(); store.audit(role, 'menu.category.delete', { id: delCat[1] }); store.save(); broadcast('menu', {});
        return send(res, 200, { ok: true });
      }

      // ----- staff accounts -----
      if (M === 'GET' && p === '/api/admin/users') {
        return send(res, 200, { users: d.users.map(({ pinHash, ...u }) => u), envPins: Object.fromEntries(Object.entries(ENV_PINS).map(([k, v]) => [k, !!v])), setupMode: setupMode() });
      }
      if (M === 'POST' && p === '/api/admin/users') {
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name) throw new OrderError('BAD_NAME', 'Name is required');
        if (!auth.ROLES.includes(b.role)) throw new OrderError('BAD_ROLE', 'Choose a role');
        if (!auth.validPin(b.pin)) throw new OrderError('BAD_PIN', 'PIN must be 4 to 8 digits');
        if (d.users.some(u => u.active && auth.checkPin(b.pin, u.pinHash)) || Object.values(ENV_PINS).includes(String(b.pin))) throw new OrderError('PIN_TAKEN', 'That PIN is already used. Choose another.', 409);
        d.counters.user = (d.counters.user || 0) + 1;
        const u = { id: 'u' + d.counters.user, name, role: b.role, active: true, createdAt: now(), pinHash: auth.hashPin(b.pin) };
        d.users.push(u);
        store.audit(role, 'user.add', { id: u.id, name, role: u.role }); store.save();
        return send(res, 201, { id: u.id });
      }
      const ua = p.match(/^\/api\/admin\/users\/(\w+)\/(deactivate|activate|pin)$/);
      if (M === 'POST' && ua) {
        const u = d.users.find(x => x.id === ua[1]);
        if (!u) throw new OrderError('NOT_FOUND', 'User not found', 404);
        if (ua[2] === 'pin') {
          const { pin } = await readBody(req);
          if (!auth.validPin(pin)) throw new OrderError('BAD_PIN', 'PIN must be 4 to 8 digits');
          if (d.users.some(x => x !== u && x.active && auth.checkPin(pin, x.pinHash))) throw new OrderError('PIN_TAKEN', 'That PIN is already used. Choose another.', 409);
          u.pinHash = auth.hashPin(pin);
        } else {
          const me = need(req, ['admin']);
          if (ua[2] === 'deactivate' && me.uid === u.id) throw new OrderError('SELF', 'You cannot deactivate yourself', 409);
          if (ua[2] === 'deactivate' && u.role === 'admin' && !hasEnvPins() && d.users.filter(x => x.active && x.role === 'admin').length === 1) throw new OrderError('LAST_ADMIN', 'Keep at least one active admin', 409);
          u.active = ua[2] === 'activate';
        }
        store.audit(role, 'user.' + ua[2], { id: u.id, name: u.name }); store.save();
        return send(res, 200, { ok: true });
      }

      // ----- reporting -----
      if (M === 'GET' && p === '/api/admin/report') {
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const tz = Number(url.searchParams.get('tz') || 0);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(tz)) throw new OrderError('BAD_DATE', 'Invalid date');
        return send(res, 200, dailyReport(d, date, tz));
      }

      // ----- backup / restore -----
      if (M === 'GET' && p === '/api/admin/backup.json') {
        store.audit(role, 'backup.download', {}); store.save();
        const { secret, ...doc } = d;
        return send(res, 200, JSON.stringify(doc), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="mehmaanos-backup-${now().slice(0, 10)}.json"` });
      }
      if (M === 'GET' && p === '/api/admin/system') {
        return send(res, 200, { storage: store.driver.name, lastSavedAt: store.lastSavedAt, error: store.lastError, backups: await store.driver.listBackups(), node: process.version, uptimeSec: Math.round(process.uptime()) });
      }

      if (M === 'GET' && p === '/api/admin/audit') return send(res, 200, { audit: d.audit.slice(-300).reverse() });
      if (M === 'GET' && p === '/api/admin/export.csv') {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['order_no', 'table', 'status', 'created_at', 'item', 'qty', 'unit_price', 'line_total', 'order_total', 'currency']];
        for (const o of d.orders) for (const l of o.lines) rows.push([o.no, o.tableId, o.status, o.createdAt, l.name.en, l.qty, l.unitPrice, l.lineTotal, o.total, o.currency]);
        return send(res, 200, rows.map(r => r.map(esc).join(',')).join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mehmaanos-orders.csv"' });
      }
    }
    throw new OrderError('NOT_FOUND', 'Not found', 404);
  } catch (e) { err(res, e); }
}

function serveFile(res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) return send(res, 404, 'Not found');
  fs.readFile(file, (e, buf) => {
    if (e) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=300' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => { handle(req, res).catch(e => err(res, e)); });

async function start() {
  await store.init();
  if (!D().secret) { D().secret = crypto.randomBytes(32).toString('hex'); await store.flush(); }
  SECRET = process.env.APP_SECRET || D().secret;
  // Escalate guest requests nobody has claimed for 2 minutes (re-announced to all staff screens).
  setInterval(() => {
    const cutoff = Date.now() - 120e3;
    for (const r of D().requests) if (r.status === 'open' && !r.escalated && Date.parse(r.createdAt) < cutoff) {
      r.escalated = true; store.audit('system', 'request.escalate', { no: r.no, table: r.tableId }); store.save(); broadcast('request', r);
    }
  }, 15e3).unref();
  await new Promise(r => server.listen(PORT, r));
  console.log(`MehmaanOS listening on :${PORT} · storage=${store.driver.name}${setupMode() ? ' · SETUP MODE: setup PINs 1111/2222/3333 active until an admin account or env PINs exist' : ''}`);
}
const shutdown = async () => { server.close(); await store.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) start().catch(e => { console.error('Failed to start', e); process.exit(1); });

module.exports = { server, start, store };
