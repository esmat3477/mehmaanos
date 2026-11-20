'use strict';
(async () => {
  const { api, el, money, toast, requireRole, logout } = MOS;
  await requireRole(['admin']);
  document.getElementById('logout').onclick = logout;
  const app = document.getElementById('app');
  let tab = 'menu';

  function qrImg(text) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    return el('img', { src: q.createDataURL(6, 2), alt: 'QR code' });
  }

  async function draw() {
    const [state, menu, tables] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/admin/menu'), api('GET', '/api/admin/tables')]);
    const nav = el('div', { class: 'tabs noprint' }, ...[['menu', 'Menu'], ['tables', 'Tables & QR'], ['settings', 'Settings'], ['audit', 'Audit log']].map(([k, l]) =>
      el('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, l)));
    let body;
    if (tab === 'menu') {
      body = el('div', {},
        menu.allergenReview
          ? el('div', { class: 'banner ok' }, `Allergen info confirmed by ${menu.allergenReview.by} on ${new Date(menu.allergenReview.at).toLocaleString()} (menu v${menu.allergenReview.version}).`)
          : el('div', { class: 'banner warn' }, 'Allergen information is DEMO data and not yet confirmed. Guests see a warning until a manager confirms it. ',
            el('button', { class: 'primary', onclick: async () => { const by = prompt('Your full name (manager confirming allergen data):'); if (by) { await api('POST', '/api/admin/allergen-review', { by }); draw(); } } }, 'I have checked it')),
        el('p', { class: 'small muted' }, `Menu version ${menu.version}. Prices are whole ${state.restaurant.currency}. Changing a price never changes orders already placed.`),
        el('div', { class: 'card' }, el('table', { class: 'list' },
          el('tr', {}, el('th', {}, 'Item'), el('th', {}, 'Category'), el('th', {}, 'Price'), el('th', {}, 'Available')),
          ...menu.items.map(it => {
            const price = el('input', { type: 'number', min: 0, step: 1, value: it.price, style: 'max-width:110px' });
            return el('tr', {},
              el('td', {}, el('b', {}, it.name.en), el('div', { class: 'small muted' }, it.name.fa, ' · ', it.name.ps)),
              el('td', {}, it.cat),
              el('td', {}, el('div', { class: 'row' }, price, el('button', { class: 'ghost', onclick: async () => {
                try { await api('POST', '/api/admin/price', { itemId: it.id, price: Number(price.value) }); toast('Price saved'); draw(); } catch (e) { toast(e.message); }
              } }, 'Save'))),
              el('td', {}, el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: it.available, onchange: async e => {
                await api('POST', '/api/admin/availability', { itemId: it.id, available: e.target.checked }); toast(e.target.checked ? 'Available' : 'Marked sold out');
              } }), it.available ? 'yes' : 'sold out')));
          }))));
    } else if (tab === 'tables') {
      body = el('div', {},
        el('div', { class: 'row noprint', style: 'margin-bottom:10px' },
          el('button', { class: 'primary', onclick: () => window.print() }, 'Print QR codes'),
          el('button', { onclick: async () => { const label = prompt('Table label (e.g. T7 or Garden 1):'); if (label) { await api('POST', '/api/admin/tables', { label }); draw(); } } }, 'Add table')),
        el('p', { class: 'small muted noprint' }, '"New QR" makes the old printed code for that table stop working. Use it if a code is copied or misused.'),
        el('div', { class: 'qrgrid' }, ...tables.tables.map(t => el('div', { class: 'qr' },
          el('div', { class: 'lbl' }, t.label), qrImg(t.url),
          el('div', { class: 'small' }, state.restaurant.name), el('div', { class: 'small muted' }, 'Scan to see the menu and order · منو · مینو'),
          el('div', { class: 'row noprint', style: 'justify-content:center;margin-top:6px' },
            el('a', { href: t.url, target: '_blank', rel: 'noopener' }, 'Open'),
            el('button', { class: 'bad', onclick: async () => { if (confirm(`Replace the QR for ${t.label}? The printed code will stop working.`)) { await api('POST', `/api/admin/tables/${t.id}/rotate`); draw(); } } }, 'New QR'))))));
    } else if (tab === 'settings') {
      const name = el('input', { value: state.restaurant.name });
      const sw = (key, label, help) => el('label', { class: 'switch', style: 'margin:10px 0' },
        el('input', { type: 'checkbox', checked: state.settings[key], onchange: async e => { await api('POST', '/api/admin/settings', { [key]: e.target.checked }); toast('Saved'); } }),
        el('div', {}, el('b', {}, label), el('div', { class: 'small muted' }, help)));
      body = el('div', { class: 'card narrow' },
        el('label', {}, 'Restaurant name'), el('div', { class: 'row' }, name, el('button', { onclick: async () => { await api('POST', '/api/admin/settings', { restaurantName: name.value }); toast('Saved'); } }, 'Save')),
        sw('requireApproval', 'Staff must approve each QR order', 'Recommended for the pilot. Orders go to the kitchen only after a waiter accepts them.'),
        sw('orderingPaused', 'Pause QR ordering', 'Guests can still view the menu and call a waiter.'),
        el('h2', {}, 'Export'), el('a', { href: '/api/admin/export.csv' }, el('button', {}, 'Download orders (CSV)')),
        state.defaultPins ? el('div', { class: 'banner bad' }, 'Default PINs in use. Set ADMIN_PIN, STAFF_PIN, KITCHEN_PIN as environment variables in Aria Run.') : el('div', { class: 'banner ok' }, 'Custom PINs are set.'));
    } else {
      const { audit } = await api('GET', '/api/admin/audit');
      body = el('div', { class: 'card' }, el('table', { class: 'list' },
        el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'Detail')),
        ...audit.map(a => el('tr', {}, el('td', { class: 'small' }, new Date(a.at).toLocaleString()), el('td', {}, a.actor), el('td', {}, a.action), el('td', { class: 'small muted' }, JSON.stringify(a.detail))))));
    }
    app.replaceChildren(nav, body);
  }
  draw().catch(e => toast(e.message));
})();
