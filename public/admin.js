'use strict';
(async () => {
  const { api, el, money, toast, requireRole, logout, fill } = MOS;
  await requireRole(['admin']);
  document.getElementById('logout').onclick = logout;
  const app = document.getElementById('app');
  let tab = (location.hash || '#menu').slice(1);
  const ALLERGENS = ['gluten', 'crustaceans', 'egg', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];
  const TABS = [['menu', 'Menu'], ['tables', 'Tables & QR'], ['staff', 'Staff'], ['report', 'Daily report'], ['settings', 'Settings'], ['system', 'System & audit']];
  const fmtS = s => s == null ? '–' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const go = async fn => { try { await fn(); } catch (e) { toast(e.message, 4000); } };

  function qrImg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return el('img', { src: q.createDataURL(6, 2), alt: 'QR code' }); }
  function modal(title, body, onSave, saveLabel = 'Save') {
    const box = el('div', { class: 'card', style: 'max-width:640px;margin:auto' });
    const sheet = el('div', { class: 'sheet', style: 'align-items:center;padding:12px', onclick: e => { if (e.target === sheet) sheet.remove(); } }, box);
    fill(box, el('div', { class: 'row between' }, el('h2', { style: 'margin:0' }, title), el('button', { class: 'ghost', onclick: () => sheet.remove() }, 'Close')),
      body, el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
        el('button', { class: 'primary', onclick: () => go(async () => { await onSave(); sheet.remove(); draw(); }) }, saveLabel)));
    box.style.borderRadius = '16px'; document.body.append(sheet);
  }
  const lbl = (t, ...kids) => el('label', { style: 'display:block;margin:8px 0' }, el('div', { class: 'small muted' }, t), ...kids);

  // ---------- menu ----------
  function itemForm(menu, it = {}) {
    const f = {
      en: el('input', { value: it.name?.en || '', maxlength: 60 }), fa: el('input', { value: it.name?.fa || '', dir: 'rtl', maxlength: 60 }), ps: el('input', { value: it.name?.ps || '', dir: 'rtl', maxlength: 60 }),
      den: el('input', { value: it.desc?.en || '', maxlength: 160 }), dfa: el('input', { value: it.desc?.fa || '', dir: 'rtl', maxlength: 160 }), dps: el('input', { value: it.desc?.ps || '', dir: 'rtl', maxlength: 160 }),
      price: el('input', { type: 'number', min: 0, step: 1, value: it.price ?? '' }),
      cat: el('select', {}, ...menu.categories.map(c => el('option', { value: c.id, selected: c.id === it.cat }, c.name.en))),
      spicy: el('input', { type: 'checkbox', checked: !!it.spicy }),
      al: ALLERGENS.map(a => el('input', { type: 'checkbox', value: a, checked: (it.allergens || []).includes(a) }))
    };
    const body = el('div', {},
      el('div', { class: 'grid cols2' }, lbl('Name (English) *', f.en), lbl('Price (whole AFN) *', f.price), lbl('Name (Dari)', f.fa), lbl('Name (Pashto)', f.ps)),
      lbl('Description (English)', f.den), el('div', { class: 'grid cols2' }, lbl('Description (Dari)', f.dfa), lbl('Description (Pashto)', f.dps)),
      el('div', { class: 'grid cols2' }, lbl('Category', f.cat), el('label', { class: 'switch', style: 'margin-top:28px' }, f.spicy, 'Spicy (guest picks mild / medium / hot)')),
      el('div', { class: 'small muted', style: 'margin-top:8px' }, 'Allergens (EU 14). Changing these requires a new manager sign-off.'),
      el('div', { class: 'row wrapflex small' }, ...ALLERGENS.map((a, i) => el('label', { class: 'switch', style: 'min-width:130px' }, f.al[i], a))));
    const save = () => api('POST', '/api/admin/items', {
      id: it.id, cat: f.cat.value, price: Number(f.price.value), spicy: f.spicy.checked,
      name: { en: f.en.value, fa: f.fa.value, ps: f.ps.value }, desc: { en: f.den.value, fa: f.dfa.value, ps: f.dps.value },
      allergens: f.al.filter(x => x.checked).map(x => x.value)
    });
    modal(it.id ? `Edit: ${it.name.en}` : 'Add dish', body, save);
  }
  function catForm(c = {}) {
    const f = { en: el('input', { value: c.name?.en || '' }), fa: el('input', { value: c.name?.fa || '', dir: 'rtl' }), ps: el('input', { value: c.name?.ps || '', dir: 'rtl' }) };
    modal(c.id ? 'Rename category' : 'Add category', el('div', {}, lbl('English *', f.en), lbl('Dari', f.fa), lbl('Pashto', f.ps)),
      () => api('POST', '/api/admin/categories', { id: c.id, name: { en: f.en.value, fa: f.fa.value, ps: f.ps.value } }));
  }
  async function menuTab(state) {
    const menu = await api('GET', '/api/admin/menu');
    const missing = menu.items.filter(i => !i.name.fa || !i.name.ps).length;
    return el('div', {},
      menu.allergenReview
        ? el('div', { class: 'banner ok' }, `Allergen info confirmed by ${menu.allergenReview.by} on ${new Date(menu.allergenReview.at).toLocaleString()} (menu v${menu.allergenReview.version}).`)
        : el('div', { class: 'banner warn' }, 'Allergen information is not confirmed. Guests see a warning until a manager checks every dish. ',
          el('button', { class: 'primary', onclick: () => { const by = prompt('Your full name (manager confirming allergen data for all dishes):'); if (by) go(async () => { await api('POST', '/api/admin/allergen-review', { by }); draw(); }); } }, 'I have checked all allergens')),
      missing ? el('div', { class: 'banner warn small' }, `${missing} dish(es) are missing a Dari or Pashto name. Guests will see English for those.`) : null,
      el('div', { class: 'row wrapflex noprint', style: 'margin:8px 0' },
        el('button', { class: 'primary', onclick: () => itemForm(menu) }, '+ Add dish'),
        el('button', { onclick: () => catForm() }, '+ Add category'),
        el('span', { class: 'small muted' }, `Menu version ${menu.version}. Edits apply to new orders only; past orders keep their prices.`)),
      ...menu.categories.map((c, ci) => el('section', { class: 'card', style: 'margin-bottom:12px' },
        el('div', { class: 'row between' },
          el('div', {}, el('b', {}, c.name.en), el('span', { class: 'small muted' }, `  ${c.name.fa || '—'} · ${c.name.ps || '—'}`)),
          el('div', { class: 'row small' },
            el('button', { class: 'ghost', disabled: ci === 0, onclick: () => go(async () => { await api('POST', '/api/admin/categories', { id: c.id, name: c.name, move: -1 }); draw(); }) }, '↑'),
            el('button', { class: 'ghost', disabled: ci === menu.categories.length - 1, onclick: () => go(async () => { await api('POST', '/api/admin/categories', { id: c.id, name: c.name, move: 1 }); draw(); }) }, '↓'),
            el('button', { class: 'ghost', onclick: () => catForm(c) }, 'Rename'),
            el('button', { class: 'bad', onclick: () => confirm(`Delete category "${c.name.en}"?`) && go(async () => { await api('POST', `/api/admin/categories/${c.id}/delete`, {}); draw(); }) }, 'Delete'))),
        el('table', { class: 'list' }, ...menu.items.filter(i => i.cat === c.id).map(it => el('tr', {},
          el('td', {}, el('b', {}, it.name.en), it.spicy ? ' 🌶' : '', el('div', { class: 'small muted' }, `${it.name.fa || '—'} · ${it.name.ps || '—'}`),
            it.allergens.length ? el('div', { class: 'small' }, 'Allergens: ', it.allergens.join(', ')) : null),
          el('td', { class: 'price' }, money(it.price, state.restaurant.currency)),
          el('td', {}, el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: it.available, onchange: e => go(async () => { await api('POST', '/api/admin/availability', { itemId: it.id, available: e.target.checked }); toast(e.target.checked ? 'Available' : 'Marked sold out'); }) }), 'available')),
          el('td', { style: 'text-align:end' },
            el('button', { class: 'ghost', onclick: () => itemForm(menu, it) }, 'Edit'), ' ',
            el('button', { class: 'bad', onclick: () => confirm(`Delete "${it.name.en}"? Past orders keep their record.`) && go(async () => { await api('POST', `/api/admin/items/${it.id}/delete`, {}); draw(); }) }, 'Delete'))))))));
  }

  // ---------- tables ----------
  async function tablesTab(state) {
    const { tables } = await api('GET', '/api/admin/tables');
    return el('div', {},
      el('div', { class: 'row noprint', style: 'margin-bottom:10px' },
        el('button', { class: 'primary', onclick: () => window.print() }, 'Print QR codes'),
        el('button', { onclick: () => { const label = prompt('Table label (e.g. T7 or Garden 1):'); if (label) go(async () => { await api('POST', '/api/admin/tables', { label }); draw(); }); } }, 'Add table')),
      el('p', { class: 'small muted noprint' }, '"New QR" makes the old printed code for that table stop working. Use it if a code is copied or misused.'),
      el('div', { class: 'qrgrid' }, ...tables.map(t => el('div', { class: 'qr' },
        el('div', { class: 'lbl' }, t.label), qrImg(t.url),
        el('div', { class: 'small' }, state.restaurant.name), el('div', { class: 'small muted' }, 'Scan for menu · مینو ببینید · مینو وګورئ'),
        el('div', { class: 'row noprint', style: 'justify-content:center;margin-top:6px' },
          el('a', { href: t.url, target: '_blank', rel: 'noopener' }, 'Open'),
          el('button', { class: 'bad', onclick: () => confirm(`Replace the QR for ${t.label}? The printed code will stop working.`) && go(async () => { await api('POST', `/api/admin/tables/${t.id}/rotate`); draw(); }) }, 'New QR'))))));
  }

  // ---------- staff ----------
  async function staffTab() {
    const { users, envPins, setupMode } = await api('GET', '/api/admin/users');
    const name = el('input', { placeholder: 'e.g. Farid' }), role = el('select', {}, el('option', { value: 'staff' }, 'Waiter / floor'), el('option', { value: 'kitchen' }, 'Kitchen'), el('option', { value: 'admin' }, 'Manager (admin)'));
    const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: '4–8 digits', autocomplete: 'new-password' });
    return el('div', {},
      setupMode ? el('div', { class: 'banner bad' }, 'Setup mode: the built-in PINs 1111 / 2222 / 3333 work until you create a Manager account below. Create your own Manager account first.') : null,
      el('p', { class: 'muted small' }, 'Give each person their own PIN so the audit log shows who accepted, cancelled or changed what. Deactivating someone signs them out immediately.'),
      el('div', { class: 'card', style: 'margin-bottom:12px' },
        el('div', { class: 'grid cols3' }, lbl('Name', name), lbl('Role', role), lbl('PIN', pin)),
        el('button', { class: 'primary', onclick: () => go(async () => {
          await api('POST', '/api/admin/users', { name: name.value, role: role.value, pin: pin.value });
          if (setupMode && role.value === 'admin') { alert('Manager account created. Setup PINs are now switched off. Sign in again with your new PIN.'); location.href = '/login?next=/admin'; return; }
          toast('Account created'); draw();
        }) }, 'Add person')),
      el('div', { class: 'card' }, el('table', { class: 'list' },
        el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Role'), el('th', {}, 'Status'), el('th', {}, '')),
        ...users.map(u => el('tr', {},
          el('td', {}, el('b', {}, u.name)), el('td', {}, u.role), el('td', {}, u.active ? 'active' : el('span', { class: 'muted' }, 'deactivated')),
          el('td', { style: 'text-align:end' },
            el('button', { class: 'ghost', onclick: () => { const p = prompt(`New PIN for ${u.name} (4–8 digits):`); if (p) go(async () => { await api('POST', `/api/admin/users/${u.id}/pin`, { pin: p }); toast('PIN changed'); }); } }, 'Reset PIN'), ' ',
            u.active ? el('button', { class: 'bad', onclick: () => go(async () => { await api('POST', `/api/admin/users/${u.id}/deactivate`); draw(); }) }, 'Deactivate')
              : el('button', { onclick: () => go(async () => { await api('POST', `/api/admin/users/${u.id}/activate`); draw(); }) }, 'Reactivate')))))),
      el('p', { class: 'small muted' }, 'Shared environment PINs set on the server: ', Object.entries(envPins).map(([k, v]) => `${k} ${v ? '✓' : '–'}`).join(' · ')));
  }

  // ---------- report ----------
  let reportDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
  async function reportTab() {
    const r = await api('GET', `/api/admin/report?date=${reportDate}&tz=${new Date().getTimezoneOffset()}`);
    const cur = r.currency;
    const dateIn = el('input', { type: 'date', value: reportDate, style: 'max-width:180px', onchange: e => { reportDate = e.target.value; draw(); } });
    const stat = (label, val, sub) => el('div', { class: 'card' }, el('div', { class: 'small muted' }, label), el('div', { style: 'font-size:1.5rem;font-weight:800' }, val), sub ? el('div', { class: 'small muted' }, sub) : null);
    const T = r.timesSec;
    return el('div', {},
      el('div', { class: 'row noprint', style: 'margin-bottom:10px' }, dateIn, el('button', { onclick: () => window.print() }, 'Print'), el('a', { href: '/api/admin/export.csv' }, el('button', {}, 'All orders CSV'))),
      el('h2', {}, `${r.restaurant} · ${r.date}`),
      el('div', { class: 'grid cols3' },
        stat('QR orders', r.orders.total, `${r.orders.stillOpen} still open`),
        stat('Value of accepted orders', money(r.orders.valueAccepted, cur), `Closed (paid): ${money(r.orders.valueClosed, cur)}`),
        stat('Rejected / canceled', r.exceptions.length, 'see exceptions below'),
        stat('Order → staff accepts', fmtS(T.submitToAccept.median), `median · n=${T.submitToAccept.n}`),
        stat('Accept → kitchen ready', fmtS(T.acceptToReady.median), `median · n=${T.acceptToReady.n}`),
        stat('Ready → served', fmtS(T.readyToServed.median), `median · n=${T.readyToServed.n}`),
        stat('Guest requests', r.requests.total, `${r.requests.escalated} waited > 2 min · ${r.requests.unclaimed} unclaimed`),
        stat('Request → staff responds', fmtS(T.requestToClaim.median), `median · n=${T.requestToClaim.n}`)),
      el('p', { class: 'small muted' }, 'Reconcile "Closed (paid)" against your till or POS at end of day. Payments are not processed by MehmaanOS.'),
      el('h2', {}, 'Exceptions'),
      r.exceptions.length ? el('div', { class: 'card' }, el('table', { class: 'list' }, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Table'), el('th', {}, 'Status'), el('th', {}, 'Value'), el('th', {}, 'By'), el('th', {}, 'Reason')),
        ...r.exceptions.map(x => el('tr', {}, el('td', {}, x.no), el('td', {}, x.tableId), el('td', {}, x.status), el('td', {}, money(x.total, cur)), el('td', {}, x.by || ''), el('td', {}, x.reason))))) : el('p', { class: 'muted' }, 'None.'),
      el('div', { class: 'grid cols2' },
        el('div', {}, el('h2', {}, 'Dishes sold'), el('div', { class: 'card' }, el('table', { class: 'list' }, ...r.topItems.map(i => el('tr', {}, el('td', {}, i.name), el('td', {}, `${i.qty}×`), el('td', { class: 'price' }, money(i.revenue, cur))))))),
        el('div', {}, el('h2', {}, 'By table'), el('div', { class: 'card' }, el('table', { class: 'list' }, ...r.tables.map(t => el('tr', {}, el('td', {}, t.tableId), el('td', {}, `${t.orders} orders`), el('td', { class: 'price' }, money(t.total, cur)))))))));
  }

  // ---------- settings ----------
  function settingsTab(state) {
    const name = el('input', { value: state.restaurant.name });
    const sw = (key, label, help) => el('label', { class: 'switch', style: 'margin:12px 0' },
      el('input', { type: 'checkbox', checked: state.settings[key], onchange: e => go(async () => { await api('POST', '/api/admin/settings', { [key]: e.target.checked }); toast('Saved'); }) }),
      el('div', {}, el('b', {}, label), el('div', { class: 'small muted' }, help)));
    return el('div', { class: 'card narrow' },
      lbl('Restaurant name', el('div', { class: 'row' }, name, el('button', { onclick: () => go(async () => { await api('POST', '/api/admin/settings', { restaurantName: name.value }); toast('Saved'); }) }, 'Save'))),
      sw('requireApproval', 'Staff must approve each QR order', 'Recommended for the pilot. Orders reach the kitchen only after a waiter accepts them.'),
      sw('orderingPaused', 'Pause QR ordering', 'Guests can still view the menu and call a waiter. Use during outages or rush hours.'));
  }

  // ---------- system ----------
  async function systemTab() {
    const [sys, { audit }] = await Promise.all([api('GET', '/api/admin/system'), api('GET', '/api/admin/audit')]);
    return el('div', {},
      el('div', { class: 'grid cols3' },
        el('div', { class: 'card' }, el('div', { class: 'small muted' }, 'Storage'), el('b', {}, sys.storage === 'postgres' ? 'PostgreSQL ✓' : 'Local file'),
          sys.storage === 'file' ? el('div', { class: 'small', style: 'color:var(--bad)' }, 'Data can be lost on redeploy. Set DATABASE_URL for live service.') : null),
        el('div', { class: 'card' }, el('div', { class: 'small muted' }, 'Last saved'), el('b', {}, sys.lastSavedAt ? new Date(sys.lastSavedAt).toLocaleString() : '–'),
          sys.error ? el('div', { class: 'small', style: 'color:var(--bad)' }, 'Save error: ', sys.error) : null),
        el('div', { class: 'card' }, el('div', { class: 'small muted' }, 'Automatic backups (every 6 h, last 28 kept)'), el('b', {}, sys.backups.length),
          el('div', {}, el('a', { href: '/api/admin/backup.json' }, el('button', { style: 'margin-top:6px' }, 'Download backup now'))))),
      el('h2', {}, 'Audit log (latest 300)'),
      el('div', { class: 'card' }, el('table', { class: 'list' },
        el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'Detail')),
        ...audit.map(a => el('tr', {}, el('td', { class: 'small' }, new Date(a.at).toLocaleString()), el('td', {}, a.actor), el('td', {}, a.action), el('td', { class: 'small muted' }, JSON.stringify(a.detail)))))));
  }

  async function draw() {
    location.hash = tab;
    const state = await api('GET', '/api/state');
    const nav = el('div', { class: 'tabs noprint' }, ...TABS.map(([k, l]) => el('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, l)));
    const views = { menu: menuTab, tables: tablesTab, staff: staffTab, report: reportTab, settings: settingsTab, system: systemTab };
    const body = await (views[tab] || menuTab)(state);
    fill(app, state.defaultPins && tab !== 'staff' ? el('div', { class: 'banner bad noprint' }, 'Setup mode: built-in PINs are active. ', el('a', { href: '#staff', onclick: () => { tab = 'staff'; draw(); } }, 'Create your Manager account')) : null, nav, body);
  }
  draw().catch(e => toast(e.message));
})();
