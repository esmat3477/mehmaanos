'use strict';
(() => {
  const { api, el, money, toast, fill } = MOS;
  const app = document.getElementById('app');
  const day = iso => iso ? new Date(iso).toLocaleDateString() : '–';
  const go = async fn => { try { await fn(); } catch (e) { toast(e.message, 4000); } };
  let filter = 'all';

  function loginView(message) {
    const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'Owner PIN' });
    const msg = el('p', { class: 'small', style: 'color:var(--bad)' }, message || '');
    fill(app, el('form', { class: 'card narrow', style: 'margin-top:40px', onsubmit: e => { e.preventDefault(); go(async () => {
      try { await api('POST', '/api/platform/login', { pin: pin.value }); draw(); } catch (er) { msg.textContent = er.message; }
    }); } }, el('h1', { style: 'margin-top:0;font-size:1.2rem' }, 'Owner console'), el('label', { class: 'small muted' }, 'Owner PIN', pin), msg, el('button', { class: 'primary', style: 'width:100%' }, 'Sign in')));
    pin.focus();
  }

  function statusOf(t) {
    if (t.status === 'trial' && t.trialEndsAt && Date.parse(t.trialEndsAt) < Date.now()) return 'trial-ended';
    return t.status;
  }
  const PILL = { trial: 'Accepted', active: 'Ready', suspended: 'Rejected', 'trial-ended': 'PendingApproval' };

  async function draw() {
    let data;
    try { data = await api('GET', '/api/platform/tenants'); }
    catch (e) { return loginView(e.status === 401 ? '' : e.message); }
    document.getElementById('logout').classList.remove('hidden');
    const T = data.tenants;
    const count = s => T.filter(t => statusOf(t) === s).length;
    const shown = T.filter(t => filter === 'all' || statusOf(t) === filter).sort((a, b) => (b.lastOrderAt || b.createdAt).localeCompare(a.lastOrderAt || a.createdAt));
    const stat = (label, val) => el('div', { class: 'card' }, el('div', { class: 'small muted' }, label), el('div', { style: 'font-size:1.6rem;font-weight:800' }, val));
    fill(app,
      el('div', { class: 'grid cols3', style: 'margin-top:12px' },
        stat('Restaurants', T.length), stat('Paying (active)', count('active')), stat('On trial', count('trial')),
        stat('Trial ended', count('trial-ended')), stat('Suspended', count('suspended')), stat('Orders, last 30 days', T.reduce((a, t) => a + t.orders30d, 0))),
      el('p', { class: 'small muted' }, `New restaurants get a ${data.trialDays}-day trial. Sign-up is ${data.signup.disabled ? 'CLOSED' : data.signup.inviteRequired ? 'invite-only (SIGNUP_CODE)' : 'open to everyone'}. Payment collection is not connected yet: mark restaurants as paid here.`),
      el('div', { class: 'tabs' }, ...[['all', 'All'], ['trial', 'Trial'], ['trial-ended', 'Trial ended'], ['active', 'Active'], ['suspended', 'Suspended']].map(([k, l]) =>
        el('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; draw(); } }, l))),
      shown.length ? null : el('p', { class: 'muted' }, 'No restaurants here yet.'),
      ...shown.map(t => {
        const st = statusOf(t);
        const set = body => go(async () => { await api('POST', `/api/platform/tenants/${t.id}`, body); toast('Saved'); draw(); });
        return el('div', { class: 'card', style: 'margin-bottom:10px' },
          el('div', { class: 'row between wrapflex' },
            el('div', {}, el('b', { style: 'font-size:1.1rem' }, t.name), ' ', el('span', { class: 'pill ' + PILL[st] }, st), ' ',
              el('a', { href: `/r/${t.slug}/`, target: '_blank', rel: 'noopener', class: 'small' }, `/r/${t.slug}`)),
            el('div', { class: 'small muted' }, `${t.country || ''} · since ${day(t.createdAt)}`)),
          el('div', { class: 'small', style: 'margin:6px 0' },
            `Owner: ${t.owner || '–'} · ${t.contact || '–'} · Plan: ${t.plan || '–'} · `,
            t.status === 'trial' ? `Trial until ${day(t.trialEndsAt)}` : t.paidUntil ? `Paid until ${day(t.paidUntil)}` : ''),
          el('div', { class: 'small muted' }, `Orders 30d: ${t.orders30d} (${money(t.value30d, t.currency)}) · total ${t.ordersTotal} · last order ${day(t.lastOrderAt)} · ${t.dishes} dishes · ${t.tables} tables · ${t.staff} staff`),
          t.note ? el('div', { class: 'small', style: 'margin-top:4px' }, '📝 ', t.note) : null,
          el('div', { class: 'row wrapflex', style: 'margin-top:8px' },
            t.status !== 'active' ? el('button', { class: 'ok', onclick: () => { const until = prompt('Mark as paying. Paid until (YYYY-MM-DD):', new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10)); if (until) set({ status: 'active', plan: 'standard', paidUntil: until }); } }, 'Mark paid / active') : null,
            el('button', { class: 'ghost', onclick: () => set({ status: t.status === 'active' ? 'active' : 'trial', extendTrialDays: 30 }) }, '+30 days trial'),
            t.status !== 'suspended' ? el('button', { class: 'bad', onclick: () => confirm(`Suspend ${t.name}? Guests and staff will be locked out until you reactivate.`) && set({ status: 'suspended' }) }, 'Suspend')
              : el('button', { onclick: () => set({ status: 'trial' }) }, 'Reactivate'),
            el('button', { class: 'ghost', onclick: () => confirm(`Give ${t.name}'s manager a new temporary PIN? Their current manager PIN stops working.`) && go(async () => {
              const r = await api('POST', `/api/platform/tenants/${t.id}/reset-pin`, {}); alert(`New PIN for ${r.name}: ${r.pin}\n\n${r.note}`); }) }, 'Reset manager PIN'),
            el('button', { class: 'ghost', onclick: () => { const n = prompt('Note (only you see this):', t.note || ''); if (n !== null) set({ note: n }); } }, 'Note'),
            el('a', { href: `/api/platform/tenants/${t.id}/export` }, el('button', { class: 'ghost' }, 'Export data')),
            el('button', { class: 'bad', onclick: () => { const c = prompt(`Permanently delete ${t.name} and all its data? Type its web address "${t.slug}" to confirm:`); if (c) go(async () => { await api('POST', `/api/platform/tenants/${t.id}/delete`, { confirm: c }); toast('Deleted'); draw(); }); } }, 'Delete')));
      }));
  }
  document.getElementById('logout').onclick = () => go(async () => { await api('POST', '/api/platform/logout'); location.reload(); });
  draw();
})();
