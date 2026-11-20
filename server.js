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
const store = new Store(process.env.DATA_DIR || path.join(__dirname, 'data'));
const D = () => store.data;

if (!D().secret) { D().secret = crypto.randomBytes(32).toString('hex'); store.saveNow(); }
const SECRET = process.env.APP_SECRET || D().secret;
const PINS = {
  admin: process.env.ADMIN_PIN || '1111',
  staff: process.env.STAFF_PIN || '2222',
  kitchen: process.env.KITCHEN_PIN || '3333'
};
const DEFAULT_PINS = !process.env.ADMIN_PIN || !process.env.STAFF_PIN || !process.env.KITCHEN_PIN;

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
function roleOf(req) { return auth.verifySession(SECRET, cookies(req).mos); }
function need(req, roles) {
  const r = roleOf(req);
  if (!r || !roles.includes(r)) throw new OrderError('UNAUTHORIZED', 'Please sign in', 401);
  return r;
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
    restaurant: d.restaurant, settings: d.settings, defaultPins: DEFAULT_PINS,
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
  store.save();
  broadcast('order', publicOrder(order));
  return { order, duplicate: false };
}

function transition(orderId, to, role, reason) {
  const o = D().orders.find(x => x.id === orderId);
  if (!o) throw new OrderError('NOT_FOUND', 'Order not found', 404);
  if (!canTransition(o.status, to, role)) throw new OrderError('BAD_TRANSITION', `Cannot move order from ${o.status} to ${to}`, 409);
  const from = o.status;
  o.status = to;
  o.events.push({ at: now(), status: to, actor: role, reason: reason ? String(reason).slice(0, 200) : undefined });
  store.audit(role, 'order.status', { no: o.no, from, to, reason });
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

  if (p === '/healthz') return send(res, 200, { ok: true, orders: D().orders.length });

  // ----- pages -----
  const pages = { '/': 'index.html', '/kitchen': 'kitchen.html', '/staff': 'staff.html', '/admin': 'admin.html', '/login': 'login.html' };
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
      const role = Object.keys(PINS).find(r => auth.safeEq(PINS[r], String(pin || '')));
      if (!role) { store.audit('anon', 'login.fail', { ip: ip(req) }); throw new OrderError('BAD_PIN', 'Wrong PIN', 401); }
      store.audit(role, 'login', { ip: ip(req) }); store.save();
      const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
      return send(res, 200, { role }, { 'Set-Cookie': `mos=${auth.sessionCookie(SECRET, role)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=50400${secure}` });
    }
    if (M === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'mos=; Path=/; Max-Age=0' });
    if (M === 'GET' && p === '/api/me') return send(res, 200, { role: roleOf(req) });

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
      const role = need(req, ['kitchen', 'staff', 'admin']);
      const body = await readBody(req);
      return send(res, 200, { order: publicOrder(transition(os[1], String(body.to), role, body.reason)) });
    }
    const rq = p.match(/^\/api\/requests\/([\w-]+)\/(claim|close)$/);
    if (M === 'POST' && rq) {
      const role = need(req, ['staff', 'admin']);
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
      const role = need(req, ['admin', ...(p === '/api/admin/availability' ? ['staff'] : [])]);
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
server.listen(PORT, () => console.log(`MehmaanOS listening on :${PORT}${DEFAULT_PINS ? ' (WARNING: default PINs in use, set ADMIN_PIN/STAFF_PIN/KITCHEN_PIN)' : ''}`));
const shutdown = () => { try { store.saveNow(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

module.exports = { server };
