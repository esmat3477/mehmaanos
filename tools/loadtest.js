'use strict';
// Load test: many restaurants, many simultaneous guest orders, plus one restaurant with a very large history.
// Usage: node tools/loadtest.js            (file storage)
//        DATABASE_URL=postgres://... node tools/loadtest.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const RESTAURANTS = 20, ORDERS = 2000, CONCURRENCY = 100, BIG = 20000;
const PORT = 3996, B = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-load-'));
const env = { PATH: process.env.PATH, PORT, DATA_DIR: dir, LOADTEST_DISABLE_RATE_LIMITS: '1', ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}) };
let srv;
const boot = async () => { srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' }); for (let i = 0; i < 100; i++) { try { await fetch(B + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('no start'); };
const call = async (m, u, body, cookie) => { const r = await fetch(B + u, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
async function run(label, jobs) {
  const lat = [], codes = {}; let errors = 0, i = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < jobs.length) { const job = jobs[i++]; const s = performance.now(); const r = await job(); lat.push(performance.now() - s); if (r.status >= 400) { errors++; const c = r.body.error || r.status; codes[c] = (codes[c] || 0) + 1; } } }));
  const secs = (Date.now() - t0) / 1000;
  console.log(`${label}: ${jobs.length} requests in ${secs.toFixed(1)}s = ${(jobs.length / secs).toFixed(0)}/s · p50 ${pct(lat, .5).toFixed(0)}ms · p95 ${pct(lat, .95).toFixed(0)}ms · p99 ${pct(lat, .99).toFixed(0)}ms · errors ${errors}${errors ? ' ' + JSON.stringify(codes) : ''}`);
  return { errors, p95: pct(lat, .95) };
}
(async () => {
  if (process.env.DATABASE_URL) { const { Pool } = require('pg'); const p = new Pool({ connectionString: process.env.DATABASE_URL }); await p.query('DROP TABLE IF EXISTS mos_state, mos_backups'); await p.end(); }
  await boot();
  console.log(`storage: ${(await call('GET', '/healthz')).body.storage}`);
  const R = [];
  for (let k = 0; k < RESTAURANTS; k++) {
    const slug = `load-${k}`;
    const s = await call('POST', '/api/signup', { restaurantName: 'Load ' + k, slug, country: k % 2 ? 'AE' : 'AF', ownerName: 'O', contact: 'o@example.com', pin: '600600', demoMenu: true, terms: true });
    for (let t = 0; t < 14; t++) await call('POST', `/r/${slug}/api/admin/tables`, { label: 'X' + t }, s.cookie);
    const tables = (await call('GET', `/r/${slug}/api/admin/tables`, null, s.cookie)).body.tables.map(x => x.url.split('/t/')[1]);
    R.push({ slug, cookie: s.cookie, tables });
  }
  const order = (r, n) => () => call('POST', `/r/${r.slug}/api/guest/${r.tables[Math.floor(n / RESTAURANTS) % r.tables.length]}/orders`, { idemKey: `load${n}x${r.slug}`.replace(/[^A-Za-z0-9]/g, ''), cart: [{ itemId: 'kabuli', qty: 1 + (n % 3) }, { itemId: 'naan', qty: 2 }] });
  const res1 = await run(`A) ${ORDERS} guest orders across ${RESTAURANTS} restaurants, ${CONCURRENCY} at once`, Array.from({ length: ORDERS }, (_, n) => order(R[n % RESTAURANTS], n)));
  const res2 = await run('B) mixed: guests polling + staff screens + kitchen state', Array.from({ length: 2000 }, (_, n) => { const r = R[n % RESTAURANTS]; return n % 2 ? () => call('GET', `/r/${r.slug}/api/state`, null, r.cookie) : () => call('GET', `/r/${r.slug}/api/guest/${r.tables[0]}/menu`); }));
  // C) one restaurant with a very large recent history (not yet archivable)
  srv.kill(); await new Promise(r => setTimeout(r, 500));
  if (!process.env.DATABASE_URL) {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, '__platform.json')));
    const id = reg.tenants.find(t => t.slug === 'load-0').id, f = path.join(dir, id + '.json');
    const doc = JSON.parse(fs.readFileSync(f)); const tmpl = doc.orders[0];
    for (let n = 0; n < BIG; n++) doc.orders.push({ ...tmpl, id: 'big' + n, no: 100000 + n, idemKey: 'big' + n, status: 'Closed', createdAt: new Date(Date.now() - (n % 30) * 864e5).toISOString() });
    fs.writeFileSync(f, JSON.stringify(doc));
    console.log(`restaurant load-0 now holds ${doc.orders.length} orders (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
  }
  await boot();
  const r0 = R[0];
  const res3 = await run(`C) 300 orders into the restaurant with ${process.env.DATABASE_URL ? 'normal' : BIG + '+'} orders`, Array.from({ length: 300 }, (_, n) => order(r0, 900000 + n)));
  const after = (await call('GET', `/r/${r0.slug}/api/state`, null, r0.cookie)).body;
  // D) realistic pace: one order at a time into the big restaurant
  const seq = [];
  for (let n = 0; n < 40; n++) { const s = performance.now(); await order(r0, 800000 + n)(); seq.push(performance.now() - s); }
  console.log(`D) single orders, one after another, big restaurant: p50 ${pct(seq, .5).toFixed(0)}ms · p95 ${pct(seq, .95).toFixed(0)}ms`);
  // integrity: every order number unique per restaurant
  let dupes = 0;
  for (const r of R.slice(0, 3)) { const st = (await call('GET', `/r/${r.slug}/api/state`, null, r.cookie)).body; const nos = st.orders.map(o => o.no); dupes += nos.length - new Set(nos).size; }
  console.log(`integrity: duplicate order numbers = ${dupes}`);
  srv.kill();
  process.exit(res1.errors || res2.errors || res3.errors || dupes ? 1 : 0);
})().catch(e => { console.error(e); srv && srv.kill(); process.exit(1); });
