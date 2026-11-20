'use strict';
(async () => {
  const { api, el, money, ago, toast, live, requireRole, logout, STATUS } = MOS;
  const role = await requireRole(['staff', 'admin']);
  document.getElementById('logout').onclick = logout;
  const app = document.getElementById('app');
  let S = null;

  async function load() { try { S = await api('GET', '/api/state'); draw(); } catch (e) { if (e.status === 401) location.href = '/login?next=/staff'; } }
  async function act(fn) { try { await fn(); } catch (e) { toast(e.message); } load(); }
  const move = (o, to, reason) => act(() => api('POST', `/api/orders/${o.id}/status`, { to, reason }));
  const reqAct = (r, a) => act(() => api('POST', `/api/requests/${r.id}/${a}`));

  function orderCard(o) {
    const btns = {
      PendingApproval: [['Accepted', 'Accept → kitchen', 'ok'], ['Rejected', 'Reject', 'bad']],
      Accepted: [['Canceled', 'Cancel', 'bad']],
      InPreparation: [['Canceled', 'Cancel', 'bad']],
      Ready: [['Served', 'Mark served', 'primary']],
      Served: [['Closed', 'Close (paid)', '']]
    }[o.status] || [];
    return el('div', { class: 'card', style: 'margin-bottom:10px' },
      el('div', { class: 'row between' }, el('b', {}, `#${o.no} · Table ${o.tableId}`), el('span', { class: 'pill ' + o.status }, STATUS[o.status])),
      el('div', { class: 'small muted' }, ago(o.createdAt), ' ago'),
      el('ul', { style: 'margin:.4rem 0;padding-inline-start:1.1rem' }, ...o.lines.map(l => el('li', {}, `${l.qty}× ${l.name.en}`, l.spice ? ` (${l.spice})` : '', l.note ? el('div', { class: 'small muted' }, '📝 ' + l.note) : null))),
      el('div', { class: 'row between' }, el('b', {}, money(o.total, S.restaurant.currency)),
        el('div', { class: 'row' }, ...btns.map(([to, label, cls]) => el('button', { class: cls, onclick: () => {
          if (to === 'Rejected' || to === 'Canceled') { const r = prompt(`Reason for ${label.toLowerCase()} order #${o.no}?`); if (r === null) return; move(o, to, r || 'no reason given'); }
          else move(o, to);
        } }, label)))));
  }

  function draw() {
    const active = s => S.orders.filter(o => s.includes(o.status)).sort((a, b) => a.no - b.no);
    const reqs = S.requests.filter(r => r.status !== 'closed').sort((a, b) => a.no - b.no);
    const tableStatus = id => {
      const os = S.orders.filter(o => o.tableId === id && ['PendingApproval', 'Accepted', 'InPreparation', 'Ready', 'Served'].includes(o.status));
      const rq = reqs.filter(r => r.tableId === id);
      return { n: os.length, ready: os.some(o => o.status === 'Ready'), pending: os.some(o => o.status === 'PendingApproval'), rq: rq.length };
    };
    MOS.fill(app,
      S.defaultPins && role === 'admin' ? el('div', { class: 'banner bad' }, 'Default PINs are in use. Set ADMIN_PIN, STAFF_PIN and KITCHEN_PIN in Aria Run before real service.') : null,
      S.settings.orderingPaused ? el('div', { class: 'banner warn' }, 'QR ordering is paused. Guests cannot send orders.') : null,
      el('h2', {}, 'Tables'),
      el('div', { class: 'row wrapflex' }, ...S.tables.map(t => {
        const s = tableStatus(t.id);
        const bg = s.rq ? '#FFF4DB' : s.ready ? '#E3F4EA' : s.pending ? '#FDEBDD' : s.n ? '#E6EEFB' : '#fff';
        return el('div', { class: 'card', style: `background:${bg};min-width:110px;text-align:center;padding:10px` },
          el('div', { style: 'font-weight:800;font-size:1.2rem' }, t.label),
          el('div', { class: 'small muted' }, s.n ? `${s.n} open` : 'free'),
          s.rq ? el('div', { class: 'small', style: 'font-weight:700;color:#8A5A00' }, `🛎 ${s.rq} request`) : null,
          s.ready ? el('div', { class: 'small', style: 'font-weight:700;color:var(--ok)' }, 'food ready') : null);
      })),
      el('div', { class: 'grid cols3', style: 'margin-top:8px' },
        el('section', {}, el('h2', {}, `Guest requests (${reqs.length})`),
          reqs.length ? null : el('p', { class: 'muted' }, 'No open requests.'),
          ...reqs.map(r => el('div', { class: 'card req ' + r.status + (r.escalated && r.status === 'open' ? ' late' : ''), style: 'margin-bottom:10px' },
            r.escalated && r.status === 'open' ? el('div', { class: 'small', style: 'color:var(--bad);font-weight:700' }, '⚠ Waiting over 2 minutes') : null,
            el('div', { class: 'row between' }, el('b', {}, `Table ${r.tableId}: ${r.type}`), el('span', { class: 'small muted' }, ago(r.createdAt))),
            el('div', { class: 'row', style: 'margin-top:8px' },
              r.status === 'open' ? el('button', { class: 'primary', onclick: () => reqAct(r, 'claim') }, "I'm on it") : el('span', { class: 'small' }, 'Claimed ' + ago(r.claimedAt) + ' ago'),
              el('button', { class: 'ok', onclick: () => reqAct(r, 'close') }, 'Done'))))),
        el('section', {}, el('h2', {}, `Needs approval (${active(['PendingApproval']).length})`), ...active(['PendingApproval']).map(orderCard),
          el('h2', {}, `Ready to serve (${active(['Ready']).length})`), ...active(['Ready']).map(orderCard)),
        el('section', {}, el('h2', {}, 'In kitchen'), ...active(['Accepted', 'InPreparation']).map(orderCard),
          el('h2', {}, 'Served, awaiting payment'), ...active(['Served']).map(orderCard)))
    );
  }
  live((type, p) => {
    if ((type === 'order' && p.status === 'PendingApproval') || (type === 'request' && p.status === 'open')) {
      if (type === 'request' && p.escalated) { toast(`⚠ Table ${p.tableId} has waited over 2 minutes`, 6000); load(); return; }
      try { navigator.vibrate && navigator.vibrate(200); } catch {}
      toast(type === 'order' ? `New order from table ${p.tableId}` : `Table ${p.tableId} needs: ${p.type}`);
    }
    load();
  });
  setInterval(() => S && draw(), 15000);
  load();
})();
