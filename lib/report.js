'use strict';
// Daily reconciliation report: the pilot KPIs named in the business proposal (section 8).
// tz = the browser's getTimezoneOffset() in minutes (e.g. -270 for Kabul, -60 for Luxembourg).

const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const firstAt = (o, st) => { const e = o.events.find(e => e.status === st); return e ? Date.parse(e.at) : null; };
const secs = (a, b) => (a != null && b != null && b >= a ? (b - a) / 1000 : null);

function dailyReport(d, date, tz = 0) {
  const start = Date.parse(date + 'T00:00:00Z') + tz * 60e3;
  const end = start + 24 * 3600e3;
  const inDay = iso => { const t = Date.parse(iso); return t >= start && t < end; };
  const orders = d.orders.filter(o => inDay(o.createdAt));
  const requests = d.requests.filter(r => inDay(r.createdAt));

  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const valid = orders.filter(o => !['Rejected', 'Canceled'].includes(o.status));
  const lost = orders.filter(o => ['Rejected', 'Canceled'].includes(o.status));

  const toAccept = [], toReady = [], toServe = [];
  for (const o of orders) {
    const c = Date.parse(o.createdAt), a = firstAt(o, 'Accepted'), r = firstAt(o, 'Ready'), s = firstAt(o, 'Served');
    const x = secs(c, a); if (x != null) toAccept.push(x);
    const y = secs(a, r); if (y != null) toReady.push(y);
    const z = secs(r, s); if (z != null) toServe.push(z);
  }
  const claim = requests.map(r => secs(Date.parse(r.createdAt), r.claimedAt ? Date.parse(r.claimedAt) : null)).filter(v => v != null);

  const items = {};
  for (const o of valid) for (const l of o.lines) {
    const k = l.itemId; items[k] = items[k] || { itemId: k, name: l.name.en, qty: 0, revenue: 0 };
    items[k].qty += l.qty; items[k].revenue += l.lineTotal;
  }
  const tables = {};
  for (const o of valid) { tables[o.tableId] = tables[o.tableId] || { tableId: o.tableId, orders: 0, total: 0 }; tables[o.tableId].orders++; tables[o.tableId].total += o.total; }

  return {
    date, currency: d.restaurant.currency, tax: d.restaurant.tax, restaurant: d.restaurant.name, generatedAt: new Date().toISOString(),
    orders: {
      total: orders.length, byStatus,
      valueAccepted: valid.reduce((a, o) => a + o.total, 0),
      taxAccepted: valid.reduce((a, o) => a + (o.tax || 0), 0),
      taxClosed: orders.filter(o => o.status === 'Closed').reduce((a, o) => a + (o.tax || 0), 0),
      valueClosed: orders.filter(o => o.status === 'Closed').reduce((a, o) => a + o.total, 0),
      stillOpen: orders.filter(o => ['PendingApproval', 'Accepted', 'InPreparation', 'Ready', 'Served'].includes(o.status)).length
    },
    exceptions: lost.map(o => {
      const e = [...o.events].reverse().find(e => e.status === o.status) || {};
      return { no: o.no, tableId: o.tableId, status: o.status, total: o.total, by: e.actor, reason: e.reason || '' };
    }),
    timesSec: {
      submitToAccept: { avg: avg(toAccept), median: median(toAccept), n: toAccept.length },
      acceptToReady: { avg: avg(toReady), median: median(toReady), n: toReady.length },
      readyToServed: { avg: avg(toServe), median: median(toServe), n: toServe.length },
      requestToClaim: { avg: avg(claim), median: median(claim), n: claim.length }
    },
    requests: { total: requests.length, unclaimed: requests.filter(r => r.status === 'open').length, escalated: requests.filter(r => r.escalated).length },
    topItems: Object.values(items).sort((a, b) => b.qty - a.qty),
    tables: Object.values(tables).sort((a, b) => a.tableId.localeCompare(b.tableId, undefined, { numeric: true }))
  };
}

module.exports = { dailyReport };
