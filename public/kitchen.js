'use strict';
(async () => {
  const { api, el, ago, toast, live, requireRole, logout } = MOS;
  await requireRole(['kitchen', 'staff', 'admin']);
  document.getElementById('logout').onclick = logout;
  const LATE_MIN = 20;
  let state = { orders: [] };
  const cols = document.getElementById('cols');
  const NEXT = { Accepted: ['InPreparation', 'Start cooking'], InPreparation: ['Ready', 'Mark ready'] };

  async function load() { try { state = await api('GET', '/api/state'); draw(); } catch (e) { if (e.status === 401) location.href = '/login?next=/kitchen'; } }
  async function move(o, to, btn) {
    btn.disabled = true;
    try { await api('POST', `/api/orders/${o.id}/status`, { to }); } catch (e) { toast(e.message); }
    load();
  }
  function ticket(o) {
    const acceptedAt = (o.events.find(e => e.status === 'Accepted') || o.events[0]).at;
    const mins = (Date.now() - Date.parse(acceptedAt)) / 60000;
    const next = NEXT[o.status];
    return el('div', { class: `ticket ${o.status} ${mins > LATE_MIN && o.status !== 'Ready' ? 'late' : ''}` },
      el('div', { class: 'row between' }, el('span', { class: 'no' }, `#${o.no}`), el('b', {}, `Table ${o.tableId}`), el('span', { class: 'timer', 'data-at': acceptedAt }, ago(acceptedAt))),
      el('ul', {}, ...o.lines.map(l => el('li', {}, el('b', {}, `${l.qty}× `), l.name.en,
        l.spice ? el('span', { class: 'pill', style: 'margin-inline-start:6px' }, l.spice) : null,
        l.note ? el('div', { class: 'note' }, '📝 ', l.note) : null))),
      next ? el('button', { class: next[0] === 'Ready' ? 'ok' : 'primary', onclick: e => move(o, next[0], e.target) }, next[1])
        : el('div', { class: 'small', style: 'color:#1F7A4D;font-weight:700' }, 'Waiting for waiter pickup'));
  }
  function draw() {
    const byS = s => state.orders.filter(o => o.status === s).sort((a, b) => a.no - b.no);
    cols.replaceChildren(
      el('section', { class: 'col' }, el('h2', {}, `New (${byS('Accepted').length})`), ...byS('Accepted').map(ticket)),
      el('section', { class: 'col' }, el('h2', {}, `Cooking (${byS('InPreparation').length})`), ...byS('InPreparation').map(ticket)),
      el('section', { class: 'col' }, el('h2', {}, `Ready (${byS('Ready').length})`), ...byS('Ready').map(ticket)));
  }
  let beep;
  function chime() {
    try { beep = beep || new AudioContext(); const o = beep.createOscillator(), g = beep.createGain(); o.frequency.value = 880; g.gain.value = .15; o.connect(g); g.connect(beep.destination); o.start(); o.stop(beep.currentTime + .25); } catch {}
  }
  live((type, p) => {
    if (type === 'order' && p.status === 'Accepted') chime();
    load();
  });
  setInterval(() => document.querySelectorAll('.timer').forEach(n => { n.textContent = ago(n.dataset.at); }), 1000);
  load();
})();
