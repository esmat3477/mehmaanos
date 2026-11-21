'use strict';
// MehmaanOS server: many restaurants on one platform. Node >= 18, one dependency (pg).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { Platform } = require('./lib/store');
const { seed } = require('./lib/seed');
const { quote, canTransition, OrderError, ACTIVE } = require('./lib/orders');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT || 3000);
const { ALLERGENS } = require('./lib/seed');
const { dailyReport } = require('./lib/report');
const { LANGS, CURRENCIES, PRESETS, TAX_MODES } = require('./lib/locale');
const platform = new Platform({ dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'), databaseUrl: process.env.DATABASE_URL });

// Every request for a restaurant runs inside its own context: { entry (registry row), doc (its data) }.
// All data access below goes through D()/store, so code can only ever touch the current restaurant.
const als = new AsyncLocalStorage();
const T = () => { const c = als.getStore(); if (!c) throw new Error('no restaurant context'); return c; };
const D = () => T().doc.data;
const store = new Proxy({}, { get: (_, k) => { const d = T().doc; const v = d[k]; return typeof v === 'function' ? v.bind(d) : v; } });
const hmacHex = (k, s) => crypto.createHmac('sha256', k).update(s).digest('hex');
// Per-restaurant signing secret. A v0.x install keeps its APP_SECRET so printed QR codes stay valid.
function secret() {
  const { entry } = T();
  if (process.env.APP_SECRET) return entry.legacy ? process.env.APP_SECRET : hmacHex(process.env.APP_SECRET, 'tenant:' + entry.id);
  return D().secret;
}

// Login sources, in order: named staff accounts (Admin > Staff), then env PINs,
// then built-in setup PINs 1111/2222/3333 ONLY while no env PINs and no admin account exist.
// Shared env PINs and setup PINs exist only for the upgraded v0.x restaurant ("main"). New restaurants get their owner account at signup.
const ENV_PINS_RAW = { admin: process.env.ADMIN_PIN, staff: process.env.STAFF_PIN, kitchen: process.env.KITCHEN_PIN };
const NO_PINS = { admin: undefined, staff: undefined, kitchen: undefined };
const envPins = () => (T().entry.legacy ? ENV_PINS_RAW : NO_PINS);
const SETUP_PINS = { admin: '1111', staff: '2222', kitchen: '3333' };
const hasEnvPins = () => Object.values(envPins()).some(Boolean);
const setupMode = () => !!T().entry.legacy && !hasEnvPins() && !D().users.some(u => u.active && u.role === 'admin');

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
  const s = auth.verifySession(secret(), cookies(req).mos);
  if (!s) return null;
  if (s.uid === 'setup' && !setupMode()) return null; // setup PINs die as soon as a real admin exists
  if (s.uid === 'env' && !envPins()[s.role]) return null;
  if (s.uid === 'env' || s.uid === 'setup') return { ...s, name: `${s.role} (${s.uid === 'env' ? 'shared PIN' : 'setup PIN'})` };
  const [uid, ver] = s.uid.split('-');
  const u = D().users.find(x => x.id === uid);
  if (!u || !u.active || u.role !== s.role || String(u.sv || 0) !== (ver || '0')) return null; // PIN change / deactivation ends sessions
  return { ...s, uid, name: u.name };
}
function need(req, roles) {
  const w = who(req);
  if (!w || !roles.includes(w.role)) throw new OrderError('UNAUTHORIZED', 'Please sign in', 401);
  return w;
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const trust = process.env.TRUST_PROXY === '1';
  const proto = trust ? (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${(trust && req.headers['x-forwarded-host']) || req.headers.host}`;
}
// Client IP for rate limits. X-Forwarded-For is only trusted behind a proxy (TRUST_PROXY=1), and then only
// its LAST entry, which the proxy itself appended; earlier entries can be forged by the client.
function ip(req) {
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',').pop().trim();
  return req.socket.remoteAddress || '';
}
const now = () => new Date().toISOString();

// Simple fixed-window rate limiter.
const buckets = new Map();
const NO_LIMITS = process.env.LOADTEST_DISABLE_RATE_LIMITS === '1'; // load testing only, never in production
if (NO_LIMITS) console.warn('WARNING: rate limits disabled (LOADTEST_DISABLE_RATE_LIMITS=1). Never use this in production.');
function limited(key, max, windowMs) {
  if (NO_LIMITS) return false;
  key = (als.getStore()?.entry.id || '_') + ':' + key;
  const t = Date.now(); const b = buckets.get(key);
  if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return false; }
  b.n++; return b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---------- realtime (SSE) ----------
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of T().doc.clients) c.write(msg);
}
setInterval(() => { for (const d of platform.tenants.values()) for (const c of d.clients) c.write(': ping\n\n'); }, 25e3).unref();

// ---------- views ----------
function publicOrder(o) {
  return { id: o.id, no: o.no, tableId: o.tableId, status: o.status, lines: o.lines, subtotal: o.subtotal ?? o.total, tax: o.tax || 0, taxMode: o.taxMode || 'none', taxLabel: o.taxLabel, currency: o.currency, total: o.total, createdAt: o.createdAt, events: o.events };
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
    restaurant: d.restaurant, settings: d.settings, defaultPins: setupMode(), account: accountInfo(),
    tables: d.tables.map(t => ({ id: t.id, label: t.label })),
    orders: d.orders.filter(o => ACTIVE.includes(o.status) || Date.parse(o.createdAt) > since).map(publicOrder),
    requests: d.requests.filter(r => r.status !== 'closed' || Date.parse(r.createdAt) > since)
  };
}

function accountInfo() {
  const e = T().entry;
  const trialLeft = e.trialEndsAt ? Math.ceil((Date.parse(e.trialEndsAt) - Date.now()) / 864e5) : null;
  return { slug: e.slug, status: e.status, plan: e.plan, trialEndsAt: e.trialEndsAt || null, trialDaysLeft: trialLeft, paidUntil: e.paidUntil || null };
}
const isSuspended = () => T().entry.status === 'suspended';

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
  if (open >= 5 && !NO_LIMITS) throw new OrderError('TOO_MANY_OPEN', 'This table has several open orders. Please ask a waiter.', 429);
  const q = quote(d.menu, body.cart, d.restaurant.tax);
  d.counters.order++;
  const status = d.settings.requireApproval ? 'PendingApproval' : 'Accepted';
  const order = {
    id: crypto.randomUUID(), no: d.counters.order, tableId: table.id, idemKey: idem,
    status, lines: q.lines, subtotal: q.subtotal, tax: q.tax, taxMode: q.taxMode, taxLabel: d.restaurant.tax.label, total: q.total, menuVersion: q.menuVersion, currency: d.restaurant.currency,
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
// Requests under /r/<slug>/... ; p is the path inside the restaurant.
async function tenantHandle(req, res, url, p) {
  const M = req.method;
  const slug = T().entry.slug;

  // ----- pages -----
  const pages = { '/': 'index.html', '/kitchen': 'kitchen.html', '/staff': 'staff.html', '/admin': 'admin.html', '/login': 'login.html', '/guide': 'guide.html' };
  if (M === 'GET' && pages[p]) return serveFile(res, pages[p]);
  if (M === 'GET' && p.startsWith('/t/')) return serveFile(res, 'guest.html');
  if (M === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8));

  try {
    // ----- guest API -----
    const g = p.match(/^\/api\/guest\/([^/]+)(\/.*)?$/);
    if (g) {
      if (isSuspended()) throw new OrderError('SUSPENDED', 'This restaurant is not taking online orders right now. Please order with a waiter.', 423);
      const table = auth.verifyTableToken(secret(), D().tables, g[1]);
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
      if (isSuspended()) throw new OrderError('SUSPENDED', 'This restaurant account is suspended. Please contact MehmaanOS support.', 423);
      if (limited('login:' + ip(req), 8, 5 * 60e3)) throw new OrderError('RATE', 'Too many attempts. Try again in a few minutes.', 429);
      // Restaurant-wide brake: after many failures from anywhere, slow every attempt (stops distributed guessing
      // without locking real staff out mid-service).
      const fails = D().loginFails = (D().loginFails || []).filter(t => t > Date.now() - 15 * 60e3);
      if (fails.length >= 30 && limited('loginbrake', 1, 10e3)) throw new OrderError('RATE', 'Too many wrong PINs for this restaurant. Wait 10 seconds and try again.', 429);
      const { pin } = await readBody(req);
      const pinStr = String(pin || '');
      let found = null;
      const rank = { admin: 0, staff: 1, kitchen: 2 };
      const idx = auth.pinIndex(secret(), pinStr);
      const active = D().users.filter(u => u.active).sort((a, b) => rank[a.role] - rank[b.role]);
      const candidates = active.filter(u => u.pinIdx === idx).concat(active.filter(u => !u.pinIdx)); // old accounts without index: checked once, then indexed
      for (const u of candidates) {
        if (await auth.checkPinAsync(pinStr, u.pinHash)) { if (!u.pinIdx) { u.pinIdx = idx; } found = { role: u.role, uid: `${u.id}-${u.sv || 0}`, name: u.name }; break; }
      }
      if (!found) for (const r of ['admin', 'staff', 'kitchen']) if (envPins()[r] && auth.safeEq(envPins()[r], pinStr)) { found = { role: r, uid: 'env', name: `${r} (shared PIN)` }; break; }
      if (!found && setupMode()) for (const r of ['admin', 'staff', 'kitchen']) if (auth.safeEq(SETUP_PINS[r], pinStr)) { found = { role: r, uid: 'setup', name: `${r} (setup PIN)` }; break; }
      if (!found) { fails.push(Date.now()); store.audit('anon', 'login.fail', { ip: ip(req) }); store.save(); throw new OrderError('BAD_PIN', 'Wrong PIN', 401); }
      store.audit(found.name, 'login', { ip: ip(req), role: found.role }); store.save();
      const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
      return send(res, 200, { role: found.role, name: found.name }, { 'Set-Cookie': `mos=${auth.sessionCookie(secret(), found.role, found.uid)}; HttpOnly; SameSite=Strict; Path=/r/${slug}; Max-Age=50400${secure}` });
    }
    if (M === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': `mos=; Path=/r/${slug}; Max-Age=0` });
    if (M === 'GET' && p === '/api/me') { const w = who(req); return send(res, 200, { role: w?.role || null, name: w?.name || null }); }

    // ----- staff / kitchen -----
    if (M === 'GET' && p === '/api/stream') {
      need(req, ['kitchen', 'staff', 'admin']);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      const set = T().doc.clients; set.add(res); req.on('close', () => set.delete(res));
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
        const r = d.restaurant;
        if (b.preset) {
          const pr = PRESETS[b.preset]; if (!pr) throw new OrderError('BAD_PRESET', 'Unknown country preset');
          Object.assign(r, JSON.parse(JSON.stringify(pr))); r.defaultLang = 'en';
        }
        if (b.currency !== undefined) { if (!(b.currency in CURRENCIES)) throw new OrderError('BAD_CURRENCY', 'Unsupported currency'); r.currency = b.currency; }
        if (b.tax) {
          const t = b.tax, rate = Number(t.rate);
          if (!TAX_MODES.includes(t.mode) || !Number.isInteger(rate) || rate < 0 || rate > 5000) throw new OrderError('BAD_TAX', 'Tax rate must be between 0 and 50%');
          r.tax = { mode: t.mode, rate: t.mode === 'none' ? 0 : rate, label: String(t.label || 'Tax').trim().slice(0, 12) || 'Tax' };
        }
        if (Array.isArray(b.languages)) {
          const langs = [...new Set(['en', ...b.languages.filter(l => l in LANGS)])];
          r.languages = langs; if (!langs.includes(r.defaultLang)) r.defaultLang = 'en';
        }
        if (b.defaultLang && r.languages.includes(b.defaultLang)) r.defaultLang = b.defaultLang;
        store.audit(role, 'settings', b); store.save(); broadcast('settings', d.settings);
        return send(res, 200, { settings: d.settings, restaurant: d.restaurant });
      }
      if (M === 'GET' && p === '/api/admin/tables') {
        const base = baseUrl(req);
        return send(res, 200, { tables: d.tables.map(t => ({ ...t, url: `${base}/r/${slug}/t/${auth.tableToken(secret(), t)}` })) });
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
      const txt = (o, max, required) => {
        const out = {};
        for (const l of Object.keys(LANGS)) { const v = String((o && o[l]) || '').trim().slice(0, max); if (v || l === 'en') out[l] = v; }
        if (required && !out.en) throw new OrderError('BAD_NAME', 'English name is required');
        return out;
      };
      const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const bump = () => { d.menu.version++; d.menu.publishedAt = now(); };
      if (M === 'POST' && p === '/api/admin/items') {
        const b = await readBody(req);
        if (!d.menu.categories.some(c => c.id === b.cat)) throw new OrderError('BAD_CAT', 'Choose a category');
        const price = Number(b.price);
        if (!Number.isInteger(price) || price < 0 || price > 1e7) throw new OrderError('BAD_PRICE', 'Price must be a whole number');
        const allergens = [...new Set((Array.isArray(b.allergens) ? b.allergens : []).filter(a => ALLERGENS.includes(a)))];
        let taxRate = null;
        if (b.taxRate !== null && b.taxRate !== undefined && b.taxRate !== '') {
          taxRate = Number(b.taxRate); if (!Number.isInteger(taxRate) || taxRate < 0 || taxRate > 5000) throw new OrderError('BAD_TAX', 'Dish tax rate must be between 0 and 50%');
        }
        const fields = { cat: b.cat, price, spicy: !!b.spicy, taxRate, name: txt(b.name, 60, true), desc: txt(b.desc, 160, false), allergens };
        let it = b.id ? d.menu.items.find(i => i.id === b.id) : null;
        if (b.id && !it) throw new OrderError('NOT_FOUND', 'Item not found', 404);
        if (it) {
          // Any allergen change invalidates the manager's allergen sign-off.
          if ([...it.allergens].sort().join() !== [...allergens].sort().join()) d.menu.allergenReview = null;
          Object.assign(it, fields);
        } else {
          let id = slugOf(fields.name.en) || 'item'; while (d.menu.items.some(i => i.id === id)) id += '-2';
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
        else { let id = slugOf(name.en) || 'cat'; while (d.menu.categories.some(x => x.id === id)) id += '-2'; c = { id, name }; d.menu.categories.push(c); }
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
        return send(res, 200, { users: d.users.map(({ pinHash, ...u }) => u), envPins: Object.fromEntries(Object.entries(envPins()).map(([k, v]) => [k, !!v])), setupMode: setupMode() });
      }
      if (M === 'POST' && p === '/api/admin/users') {
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name) throw new OrderError('BAD_NAME', 'Name is required');
        if (!auth.ROLES.includes(b.role)) throw new OrderError('BAD_ROLE', 'Choose a role');
        if (!auth.validPin(b.pin)) throw new OrderError('BAD_PIN', 'PIN must be 4 to 8 digits');
        if (b.role === 'admin' && String(b.pin).length < 6) throw new OrderError('BAD_PIN', 'Manager PINs need at least 6 digits');
        const idx = auth.pinIndex(secret(), b.pin);
        if (d.users.some(u => u.active && (u.pinIdx ? u.pinIdx === idx : auth.checkPin(b.pin, u.pinHash))) || Object.values(envPins()).includes(String(b.pin))) throw new OrderError('PIN_TAKEN', 'That PIN is already used. Choose another.', 409);
        d.counters.user = (d.counters.user || 0) + 1;
        const u = { id: 'u' + d.counters.user, name, role: b.role, active: true, createdAt: now(), pinHash: auth.hashPin(b.pin), pinIdx: idx, sv: 0 };
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
          if (u.role === 'admin' && String(pin).length < 6) throw new OrderError('BAD_PIN', 'Manager PINs need at least 6 digits');
          const idx = auth.pinIndex(secret(), pin);
          if (d.users.some(x => x !== u && x.active && (x.pinIdx ? x.pinIdx === idx : auth.checkPin(pin, x.pinHash)))) throw new OrderError('PIN_TAKEN', 'That PIN is already used. Choose another.', 409);
          u.pinHash = auth.hashPin(pin); u.pinIdx = idx; u.sv = (u.sv || 0) + 1; // signs this person out everywhere
        } else {
          const me = need(req, ['admin']);
          if (ua[2] === 'deactivate' && me.uid === u.id) throw new OrderError('SELF', 'You cannot deactivate yourself', 409);
          if (ua[2] === 'deactivate' && u.role === 'admin' && !hasEnvPins() && d.users.filter(x => x.active && x.role === 'admin').length === 1) throw new OrderError('LAST_ADMIN', 'Keep at least one active admin', 409);
          u.active = ua[2] === 'activate'; u.sv = (u.sv || 0) + 1;
        }
        store.audit(role, 'user.' + ua[2], { id: u.id, name: u.name }); store.save();
        return send(res, 200, { ok: true });
      }

      // ----- reporting -----
      if (M === 'GET' && p === '/api/admin/report') {
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const tz = Number(url.searchParams.get('tz') || 0);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(tz)) throw new OrderError('BAD_DATE', 'Invalid date');
        const from = Date.parse(date + 'T00:00:00Z') + tz * 60e3;
        const span = await platform.ordersBetween(T().doc, from, from + 864e5);
        return send(res, 200, dailyReport({ ...d, orders: span.orders, requests: span.requests }, date, tz));
      }

      // ----- backup / restore -----
      if (M === 'GET' && p === '/api/admin/backup.json') {
        store.audit(role, 'backup.download', {}); store.save();
        const { secret: _s, loginFails: _f, ...doc } = d;
        doc.users = doc.users.map(({ pinHash, pinIdx, ...u }) => u);
        doc.archived = await platform.allArchived(T().doc);
        return send(res, 200, JSON.stringify(doc), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="mehmaanos-backup-${now().slice(0, 10)}.json"` });
      }
      if (M === 'GET' && p === '/api/admin/system') {
        return send(res, 200, { storage: platform.driver.name, lastSavedAt: store.lastSavedAt, error: store.lastError, backups: await store.listBackups(), node: process.version, uptimeSec: Math.round(process.uptime()) });
      }

      if (M === 'GET' && p === '/api/admin/audit') return send(res, 200, { audit: d.audit.slice(-300).reverse() });
      if (M === 'GET' && p === '/api/admin/export.csv') {
        // Neutralise spreadsheet formulas (=, +, -, @) in text written by guests or staff.
        const esc = v => { let t = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
        // Amounts in minor units (e.g. fils for AED, whole afghani for AFN): see currency_decimals.
        const rows = [['order_no', 'table', 'status', 'created_at', 'item', 'qty', 'unit_price', 'line_total', 'line_tax', 'tax_rate_pct', 'order_total', 'order_tax', 'tax_mode', 'currency', 'currency_decimals']];
        const arc = await platform.allArchived(T().doc);
        for (const o of [...arc.orders, ...d.orders]) for (const l of o.lines) rows.push([o.no, o.tableId, o.status, o.createdAt, l.name.en, l.qty, l.unitPrice, l.lineTotal, l.tax || 0, (l.taxRate || 0) / 100, o.total, o.tax || 0, o.taxMode || 'none', o.currency, CURRENCIES[o.currency] ?? 0]);
        return send(res, 200, rows.map(r => r.map(esc).join(',')).join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mehmaanos-orders.csv"' });
      }
    }
    throw new OrderError('NOT_FOUND', 'Not found', 404);
  } catch (e) { err(res, e); }
}

function serveFile(res, rel, status = 200) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) return send(res, 404, 'Not found');
  fs.readFile(file, (e, buf) => {
    if (e) return send(res, 404, 'Not found');
    res.writeHead(status, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=300' });
    res.end(buf);
  });
}


// =====================================================================
// Platform: landing, signup, routing to restaurants, owner console
// =====================================================================
const RESERVED = new Set(['api', 'static', 'platform', 'signup', 'admin', 'www', 'app', 'r', 't', 'login', 'staff', 'kitchen', 'guide', 'healthz', 'help', 'support', 'mehmaanos', 'aria', 'test', 'demo-admin']);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 60);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const platformSecret = () => process.env.APP_SECRET ? hmacHex(process.env.APP_SECRET, 'platform') : platform.registry.data.secret;

function security(res, req) {
  if (req && (req.socket.encrypted || (process.env.TRUST_PROXY === '1' && /^https/.test(req.headers['x-forwarded-proto'] || '')))) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
}
const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

async function handle(req, res) {
  security(res, req);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, M = req.method;

  if (p === '/healthz') {
    const e = platform.registry.lastError;
    return send(res, e ? 503 : 200, { ok: !e, storage: platform.driver.name, restaurants: platform.list().length, error: e || undefined });
  }
  if (M === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8));

  // ----- a restaurant -----
  const m = p.match(/^\/r\/([a-z0-9-]{2,40})(\/.*)?$/);
  if (m) {
    const entry = platform.find(m[1]);
    if (!entry) return (m[2] || '').startsWith('/api') ? send(res, 404, { error: 'NO_RESTAURANT', message: 'Restaurant not found' }) : serveFile(res, 'notfound.html', 404);
    if (!m[2]) return redirect(res, `/r/${entry.slug}/`);
    const doc = await platform.open(entry);
    if (!doc.data.secret) { doc.data.secret = crypto.randomBytes(32).toString('hex'); await doc.flush(); }
    return als.run({ entry, doc }, () => tenantHandle(req, res, url, m[2]));
  }

  // ----- v0.x single-restaurant links (printed QR codes, bookmarks) -----
  const legacy = platform.list().find(t => t.legacy);
  if (legacy && M === 'GET' && (/^\/(staff|kitchen|admin|login|guide)$/.test(p) || p.startsWith('/t/'))) return redirect(res, `/r/${legacy.slug}${p}${url.search}`);

  // ----- platform pages -----
  const pages = { '/': 'landing.html', '/signup': 'signup.html', '/platform': 'platform.html' };
  if (M === 'GET' && pages[p]) return serveFile(res, pages[p]);

  try {
    if (M === 'GET' && p === '/api/signup/check') {
      const slug = String(url.searchParams.get('slug') || '').toLowerCase();
      const ok = SLUG_RE.test(slug) && !RESERVED.has(slug) && !platform.find(slug);
      return send(res, 200, { slug, available: ok, inviteRequired: !!process.env.SIGNUP_CODE });
    }
    if (M === 'POST' && p === '/api/signup') return await signup(req, res);
    if (p.startsWith('/api/platform/')) return await platformApi(req, res, url, p);
    throw new OrderError('NOT_FOUND', 'Not found', 404);
  } catch (e) { err(res, e); }
}

async function signup(req, res) {
  if (process.env.SIGNUP_DISABLED === '1') throw new OrderError('CLOSED', 'New sign-ups are closed right now.', 403);
  if (limited('signup:' + ip(req), Number(process.env.SIGNUP_LIMIT || 5), 3600e3)) throw new OrderError('RATE', 'Too many sign-ups from this network. Try again later.', 429);
  const b = await readBody(req);
  if (process.env.SIGNUP_CODE && !auth.safeEq(process.env.SIGNUP_CODE, String(b.code || ''))) throw new OrderError('BAD_CODE', 'The invite code is not valid.', 403);
  const name = String(b.restaurantName || '').trim().slice(0, 80);
  const owner = String(b.ownerName || '').trim().slice(0, 40);
  const contact = String(b.contact || '').trim().slice(0, 120);
  const slug = String(b.slug || '').trim().toLowerCase();
  if (!name) throw new OrderError('BAD_NAME', 'Restaurant name is required');
  if (!owner) throw new OrderError('BAD_NAME', 'Your name is required');
  if (contact.length < 5) throw new OrderError('BAD_CONTACT', 'Email or phone is required so we can reach you');
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new OrderError('BAD_SLUG', 'Web address: 3–40 lowercase letters, numbers or dashes');
  if (platform.find(slug)) throw new OrderError('SLUG_TAKEN', 'That web address is taken. Try another.', 409);
  if (!auth.validPin(b.pin) || String(b.pin).length < 6) throw new OrderError('BAD_PIN', 'Manager PIN must be 6 to 8 digits');
  if (b.terms !== true) throw new OrderError('TERMS', 'Please accept the terms to continue');

  const data = seed();
  data.secret = crypto.randomBytes(32).toString('hex');
  data.restaurant.name = name;
  if (PRESETS[b.country]) Object.assign(data.restaurant, JSON.parse(JSON.stringify(PRESETS[b.country])), { defaultLang: 'en' });
  data.restaurant.demo = !!b.demoMenu;
  if (!b.demoMenu) data.menu.items = [];
  // The sample menu is priced in afghani; give 2-decimal currencies sensible round sample prices (~20 AFN = 1 unit).
  else if ((CURRENCIES[data.restaurant.currency] ?? 0) === 2) for (const it of data.menu.items) it.price = Math.max(1, Math.round(it.price / 20)) * 100;
  data.users = [{ id: 'u1', name: owner, role: 'admin', active: true, createdAt: now(), pinHash: auth.hashPin(b.pin), pinIdx: null, sv: 0 }];
  data.counters.user = 1;
  data.audit = [{ at: now(), actor: owner, action: 'restaurant.signup', detail: { slug, country: b.country || 'custom' } }];
  const entry = {
    id: 't_' + crypto.randomBytes(6).toString('hex'), slug, name, status: 'trial', plan: 'trial',
    createdAt: now(), trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString(),
    owner, contact, country: PRESETS[b.country] ? b.country : 'custom'
  };
  try { await platform.create(entry, data); } catch (e) { if (/slug taken/.test(e.message)) throw new OrderError('SLUG_TAKEN', 'That web address is taken. Try another.', 409); throw e; }
  console.log(`signup: ${slug} (${name})`);
  const doc = platform.tenants.get(entry.id);
  const cookie = als.run({ entry, doc }, () => { doc.data.users[0].pinIdx = auth.pinIndex(secret(), b.pin); doc.save(); return auth.sessionCookie(secret(), 'admin', 'u1-0'); });
  const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
  return send(res, 201, { slug, url: `/r/${slug}/admin` }, { 'Set-Cookie': `mos=${cookie}; HttpOnly; SameSite=Strict; Path=/r/${slug}; Max-Age=50400${secure}` });
}

// ----- owner console (you / Aria). Enabled only when PLATFORM_PIN is set. -----
function platformAuth(req) {
  const v = cookies(req).mosp || '';
  const [exp, sig] = v.split('.');
  return exp && Number(exp) > Date.now() && auth.safeEq(hmacHex(platformSecret(), 'plat:' + exp).slice(0, 32), sig || '');
}
async function tenantStats(entry) {
  const d = (await platform.open(entry)).data;
  const since = Date.now() - 30 * 864e5;
  const recent = d.orders.filter(o => Date.parse(o.createdAt) > since);
  const last = d.orders[d.orders.length - 1];
  return {
    ...entry, currency: d.restaurant.currency,
    ordersTotal: d.orders.length, orders30d: recent.length,
    value30d: recent.filter(o => !['Rejected', 'Canceled'].includes(o.status)).reduce((a, o) => a + o.total, 0),
    lastOrderAt: last ? last.createdAt : null, staff: d.users.filter(u => u.active).length, tables: d.tables.length, dishes: d.menu.items.length
  };
}
async function platformApi(req, res, url, p) {
  const M = req.method;
  if (!process.env.PLATFORM_PIN || process.env.PLATFORM_PIN.length < 10) throw new OrderError('DISABLED', 'Owner console is disabled. Set PLATFORM_PIN (at least 10 characters) on the server to enable it.', 404);
  if (M === 'POST' && p === '/api/platform/login') {
    if (limited('plogin:' + ip(req), 5, 15 * 60e3)) throw new OrderError('RATE', 'Too many attempts. Try again later.', 429);
    const { pin } = await readBody(req);
    if (!auth.safeEq(process.env.PLATFORM_PIN, String(pin || ''))) throw new OrderError('BAD_PIN', 'Wrong PIN', 401);
    const exp = Date.now() + 8 * 3600e3;
    const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `mosp=${exp}.${hmacHex(platformSecret(), 'plat:' + exp).slice(0, 32)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
  }
  if (M === 'POST' && p === '/api/platform/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'mosp=; Path=/; Max-Age=0' });
  if (!platformAuth(req)) throw new OrderError('UNAUTHORIZED', 'Please sign in', 401);

  if (M === 'GET' && p === '/api/platform/tenants') {
    const list = [];
    for (const e of platform.list()) list.push(await tenantStats(e));
    return send(res, 200, { tenants: list, trialDays: TRIAL_DAYS, signup: { inviteRequired: !!process.env.SIGNUP_CODE, disabled: process.env.SIGNUP_DISABLED === '1' } });
  }
  const tm = p.match(/^\/api\/platform\/tenants\/([\w-]+)(?:\/(export|delete|reset-pin))?$/);
  if (tm) {
    const entry = platform.list().find(t => t.id === tm[1]);
    if (!entry) throw new OrderError('NOT_FOUND', 'Restaurant not found', 404);
    if (M === 'GET' && tm[2] === 'export') {
      const live = await platform.open(entry);
      const { secret: _s, loginFails: _f, ...doc } = live.data;
      doc.users = doc.users.map(({ pinHash, pinIdx, ...u }) => u);
      doc.archived = await platform.allArchived(live);
      return send(res, 200, JSON.stringify({ restaurant: entry, data: doc }), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="mehmaanos-${entry.slug}-${now().slice(0, 10)}.json"` });
    }
    if (M === 'POST' && tm[2] === 'reset-pin') {
      const doc = await platform.open(entry);
      const pin = String(crypto.randomInt(100000, 1000000));
      return await als.run({ entry, doc }, async () => {
        const d = D();
        let u = d.users.find(x => x.active && x.role === 'admin');
        if (!u) { d.counters.user = (d.counters.user || 0) + 1; u = { id: 'u' + d.counters.user, name: entry.owner || 'Manager', role: 'admin', active: true, createdAt: now() }; d.users.push(u); }
        u.pinHash = auth.hashPin(pin); u.pinIdx = auth.pinIndex(secret(), pin); u.sv = (u.sv || 0) + 1;
        store.audit('platform', 'user.pin_reset', { id: u.id, name: u.name }); await store.flush();
        return send(res, 200, { name: u.name, pin, note: 'Give this temporary PIN to the manager by phone and ask them to change it in Admin → Staff.' });
      });
    }
    if (M === 'POST' && tm[2] === 'delete') {
      const { confirm } = await readBody(req);
      if (confirm !== entry.slug) throw new OrderError('CONFIRM', `Type the web address "${entry.slug}" to confirm`, 400);
      await platform.remove(entry);
      console.log(`deleted restaurant ${entry.slug}`);
      return send(res, 200, { ok: true });
    }
    if (M === 'POST' && !tm[2]) {
      const b = await readBody(req);
      if (b.status !== undefined) { if (!['trial', 'active', 'suspended'].includes(b.status)) throw new OrderError('BAD_STATUS', 'Unknown status'); entry.status = b.status; }
      if (b.plan !== undefined) entry.plan = String(b.plan).slice(0, 30);
      if (b.extendTrialDays) { const base = Math.max(Date.now(), Date.parse(entry.trialEndsAt || 0)); entry.trialEndsAt = new Date(base + Number(b.extendTrialDays) * 864e5).toISOString(); }
      if (b.paidUntil !== undefined) entry.paidUntil = b.paidUntil ? new Date(b.paidUntil).toISOString() : null;
      if (b.note !== undefined) entry.note = String(b.note).slice(0, 300);
      await platform.registry.save();
      if (b.status === 'suspended') for (const c of platform.tenants.get(entry.id)?.clients || []) c.end();
      return send(res, 200, { tenant: entry });
    }
  }
  throw new OrderError('NOT_FOUND', 'Not found', 404);
}

const server = http.createServer((req, res) => { handle(req, res).catch(e => err(res, e)); });

async function start() {
  await platform.init();
  if (!platform.registry.data.secret) { platform.registry.data.secret = crypto.randomBytes(32).toString('hex'); await platform.registry.flush(); }
  // Escalate guest requests nobody has claimed for 2 minutes, in every open restaurant.
  setInterval(() => {
    const cutoff = Date.now() - 120e3;
    for (const [id, doc] of platform.tenants) {
      const entry = platform.list().find(e => e.id === id);
      if (!entry) continue;
      als.run({ entry, doc }, () => {
        for (const r of D().requests) if (r.status === 'open' && !r.escalated && Date.parse(r.createdAt) < cutoff) {
          r.escalated = true; store.audit('system', 'request.escalate', { no: r.no, table: r.tableId }); store.save(); broadcast('request', r);
        }
      });
    }
  }, 15e3).unref();
  // Daily: archive old finished orders in every loaded restaurant.
  setInterval(async () => { for (const doc of platform.tenants.values()) await platform.archive(doc).catch(e => console.error('archive failed', doc.id, e.message)); }, 24 * 3600e3).unref();
  await new Promise(r => server.listen(PORT, r));
  console.log(`MehmaanOS listening on :${PORT} · storage=${platform.driver.name} · restaurants=${platform.list().length}${process.env.PLATFORM_PIN ? ' · owner console on' : ''}${process.env.SIGNUP_CODE ? ' · invite-only signup' : ''}`);
}
const shutdown = async () => { server.close(); await platform.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) start().catch(e => { console.error('Failed to start', e); process.exit(1); });

module.exports = { server, start, platform };
