'use strict';
(async () => {
  const { api, el, money, toast, requireRole, logout, fill, toMinor, toMajor, RTL } = MOS;
  const LNAME = { ar: 'Arabic', fa: 'Dari', ps: 'Pashto', ur: 'Urdu', hi: 'Hindi' };
  let R = null; // restaurant settings (currency, tax, languages)
  const extra = () => R.languages.filter(l => l !== 'en');
  const dirOf = l => RTL.includes(l) ? 'rtl' : 'ltr';
  const others = o => extra().map(l => o && o[l]).filter(Boolean).join(' · ');
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
    const name = { en: el('input', { value: it.name?.en || '', maxlength: 60 }) }, desc = { en: el('input', { value: it.desc?.en || '', maxlength: 160 }) };
    for (const l of extra()) { name[l] = el('input', { value: it.name?.[l] || '', dir: dirOf(l), maxlength: 60 }); desc[l] = el('input', { value: it.desc?.[l] || '', dir: dirOf(l), maxlength: 160 }); }
    const f = {
      price: el('input', { type: 'number', min: 0, step: R.currency in MOS.DEC && MOS.DEC[R.currency] ? 0.01 : 1, value: it.price != null ? toMajor(it.price, R.currency) : '' }),
      cat: el('select', {}, ...menu.categories.map(c => el('option', { value: c.id, selected: c.id === it.cat }, c.name.en))),
      spicy: el('input', { type: 'checkbox', checked: !!it.spicy }),
      taxRate: el('input', { type: 'number', min: 0, max: 50, step: 0.01, placeholder: `default ${(R.tax.rate / 100)}%`, value: Number.isInteger(it.taxRate) ? it.taxRate / 100 : '' }),
      al: ALLERGENS.map(a => el('input', { type: 'checkbox', value: a, checked: (it.allergens || []).includes(a) }))
    };
    const body = el('div', {},
      el('div', { class: 'grid cols2' }, lbl('Name (English) *', name.en), lbl(`Price in ${R.currency}${R.tax.mode === 'inclusive' ? ` (incl. ${R.tax.label})` : ''} *`, f.price),
        ...extra().map(l => lbl(`Name (${LNAME[l]})`, name[l]))),
      lbl('Description (English)', desc.en), el('div', { class: 'grid cols2' }, ...extra().map(l => lbl(`Description (${LNAME[l]})`, desc[l]))),
      el('div', { class: 'grid cols2' }, lbl('Category', f.cat), el('label', { class: 'switch', style: 'margin-top:28px' }, f.spicy, 'Spicy (guest picks mild / medium / hot)')),
      R.tax.mode !== 'none' ? lbl(`${R.tax.label} rate for this dish, % (leave empty to use the default)`, f.taxRate) : null,
      el('div', { class: 'small muted', style: 'margin-top:8px' }, 'Allergens (EU 14). Changing these requires a new manager sign-off.'),
      el('div', { class: 'row wrapflex small' }, ...ALLERGENS.map((a, i) => el('label', { class: 'switch', style: 'min-width:130px' }, f.al[i], a))));
    const pick = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.value]));
    const save = () => api('POST', '/api/admin/items', {
      id: it.id, cat: f.cat.value, price: toMinor(f.price.value, R.currency), spicy: f.spicy.checked,
      taxRate: f.taxRate.value === '' ? null : Math.round(Number(f.taxRate.value) * 100),
      name: pick(name), desc: pick(desc), allergens: f.al.filter(x => x.checked).map(x => x.value)
    });
    modal(it.id ? `Edit: ${it.name.en}` : 'Add dish', body, save);
  }
  function catForm(c = {}) {
    const f = { en: el('input', { value: c.name?.en || '' }) };
    for (const l of extra()) f[l] = el('input', { value: c.name?.[l] || '', dir: dirOf(l) });
    modal(c.id ? 'Rename category' : 'Add category', el('div', {}, lbl('English *', f.en), ...extra().map(l => lbl(LNAME[l], f[l]))),
      () => api('POST', '/api/admin/categories', { id: c.id, name: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) }));
  }
  async function menuTab(state) {
    const menu = await api('GET', '/api/admin/menu');
    const missing = menu.items.filter(i => extra().some(l => !i.name[l])).length;
    return el('div', {},
      menu.allergenReview
        ? el('div', { class: 'banner ok' }, `Allergen info confirmed by ${menu.allergenReview.by} on ${new Date(menu.allergenReview.at).toLocaleString()} (menu v${menu.allergenReview.version}).`)
        : el('div', { class: 'banner warn' }, 'Allergen information is not confirmed. Guests see a warning until a manager checks every dish. ',
          el('button', { class: 'primary', onclick: () => { const by = prompt('Your full name (manager confirming allergen data for all dishes):'); if (by) go(async () => { await api('POST', '/api/admin/allergen-review', { by }); draw(); }); } }, 'I have checked all allergens')),
      missing ? el('div', { class: 'banner warn small' }, `${missing} dish(es) are missing a translation (${extra().map(l => LNAME[l]).join(', ')}). Guests will see English for those.`) : null,
      el('div', { class: 'row wrapflex noprint', style: 'margin:8px 0' },
        el('button', { class: 'primary', onclick: () => itemForm(menu) }, '+ Add dish'),
        el('button', { onclick: () => catForm() }, '+ Add category'),
        el('span', { class: 'small muted' }, `Menu version ${menu.version}. Prices in ${R.currency}${R.tax.mode === 'inclusive' ? `, ${R.tax.label} included` : R.tax.mode === 'exclusive' ? `, ${R.tax.label} added at the end` : ''}. Edits apply to new orders only.`)),
      ...menu.categories.map((c, ci) => el('section', { class: 'card', style: 'margin-bottom:12px' },
        el('div', { class: 'row between' },
          el('div', {}, el('b', {}, c.name.en), el('span', { class: 'small muted' }, '  ' + others(c.name))),
          el('div', { class: 'row small' },
            el('button', { class: 'ghost', disabled: ci === 0, onclick: () => go(async () => { await api('POST', '/api/admin/categories', { id: c.id, name: c.name, move: -1 }); draw(); }) }, '↑'),
            el('button', { class: 'ghost', disabled: ci === menu.categories.length - 1, onclick: () => go(async () => { await api('POST', '/api/admin/categories', { id: c.id, name: c.name, move: 1 }); draw(); }) }, '↓'),
            el('button', { class: 'ghost', onclick: () => catForm(c) }, 'Rename'),
            el('button', { class: 'bad', onclick: () => confirm(`Delete category "${c.name.en}"?`) && go(async () => { await api('POST', `/api/admin/categories/${c.id}/delete`, {}); draw(); }) }, 'Delete'))),
        el('table', { class: 'list' }, ...menu.items.filter(i => i.cat === c.id).map(it => el('tr', {},
          el('td', {}, el('b', {}, it.name.en), it.spicy ? ' 🌶' : '', el('div', { class: 'small muted' }, others(it.name)), Number.isInteger(it.taxRate) ? el('div', { class: 'small' }, `${R.tax.label} ${it.taxRate / 100}%`) : null,
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
      el('div', { class: 'row noprint', style: 'margin-bottom:10px' }, dateIn, el('button', { onclick: () => window.print() }, 'Print'), el('a', { href: MOS.base + '/api/admin/export.csv' }, el('button', {}, 'All orders CSV'))),
      el('h2', {}, `${r.restaurant} · ${r.date}`),
      el('div', { class: 'grid cols3' },
        stat('QR orders', r.orders.total, `${r.orders.stillOpen} still open`),
        stat('Value of accepted orders', money(r.orders.valueAccepted, cur), `Closed (paid): ${money(r.orders.valueClosed, cur)}`),
        r.tax && r.tax.mode !== 'none' ? stat(`${r.tax.label} in closed orders`, money(r.orders.taxClosed, cur), `${r.tax.mode === 'inclusive' ? 'included in' : 'added to'} prices · accepted: ${money(r.orders.taxAccepted, cur)}`) : null,
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
    const cur = el('select', {}, ...Object.keys(MOS.DEC).map(c => el('option', { value: c, selected: c === R.currency }, c)));
    const mode = el('select', {}, ...[['none', 'No tax on menu'], ['inclusive', 'Prices include tax (UAE, EU)'], ['exclusive', 'Tax added on top of prices']].map(([v, l]) => el('option', { value: v, selected: v === R.tax.mode }, l)));
    const rate = el('input', { type: 'number', min: 0, max: 50, step: 0.01, value: R.tax.rate / 100 });
    const tlabel = el('input', { value: R.tax.label, maxlength: 12 });
    const langBoxes = Object.entries({ ar: 'العربية Arabic', fa: 'دری Dari', ps: 'پښتو Pashto', ur: 'اردو Urdu', hi: 'हिन्दी Hindi' }).map(([k, l]) =>
      el('label', { class: 'switch', style: 'min-width:150px' }, el('input', { type: 'checkbox', value: k, checked: R.languages.includes(k) }), l));
    const preset = code => () => confirm(`Apply the ${code === 'AE' ? 'United Arab Emirates (AED, 5% VAT included, Arabic)' : 'Afghanistan (AFN, no tax, Dari + Pashto)'} preset? Existing prices are NOT converted. Re-check every price afterwards.`)
      && go(async () => { await api('POST', '/api/admin/settings', { preset: code }); toast('Country settings applied'); draw(); });
    return el('div', { class: 'grid cols2' },
      el('div', { class: 'card' },
        el('h2', { style: 'margin-top:0' }, 'Restaurant'),
        lbl('Name', el('div', { class: 'row' }, name, el('button', { onclick: () => go(async () => { await api('POST', '/api/admin/settings', { restaurantName: name.value }); toast('Saved'); }) }, 'Save'))),
        sw('requireApproval', 'Staff must approve each QR order', 'Recommended for the pilot. Orders reach the kitchen only after a waiter accepts them.'),
        sw('orderingPaused', 'Pause QR ordering', 'Guests can still view the menu and call a waiter. Use during outages or rush hours.')),
      el('div', { class: 'card' },
        el('h2', { style: 'margin-top:0' }, 'Country, currency & tax'),
        el('div', { class: 'row wrapflex' }, el('span', { class: 'small muted' }, 'Quick setup:'),
          el('button', { class: 'ghost', onclick: preset('AE') }, '🇦🇪 UAE / Dubai'), el('button', { class: 'ghost', onclick: preset('AF') }, '🇦🇫 Afghanistan')),
        el('p', { class: 'small muted' }, 'Other countries: set currency and tax below and confirm the rules with an accountant. Changing currency does not convert existing prices.'),
        el('div', { class: 'grid cols2' }, lbl('Currency', cur), lbl('Tax', mode), lbl('Default tax rate %', rate), lbl('Tax name on receipts', tlabel)),
        el('div', { class: 'small muted', style: 'margin-top:8px' }, 'Guest languages (English is always on):'),
        el('div', { class: 'row wrapflex' }, ...langBoxes),
        el('button', { class: 'primary', style: 'margin-top:12px', onclick: () => go(async () => {
          await api('POST', '/api/admin/settings', { currency: cur.value, tax: { mode: mode.value, rate: Math.round(Number(rate.value) * 100), label: tlabel.value }, languages: langBoxes.map(b => b.firstChild).filter(x => x.checked).map(x => x.value) });
          toast('Saved'); draw();
        }) }, 'Save country settings')));
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
          el('div', {}, el('a', { href: MOS.base + '/api/admin/backup.json' }, el('button', { style: 'margin-top:6px' }, 'Download backup now'))))),
      el('h2', {}, 'Audit log (latest 300)'),
      el('div', { class: 'card' }, el('table', { class: 'list' },
        el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'Detail')),
        ...audit.map(a => el('tr', {}, el('td', { class: 'small' }, new Date(a.at).toLocaleString()), el('td', {}, a.actor), el('td', {}, a.action), el('td', { class: 'small muted' }, JSON.stringify(a.detail)))))));
  }

  async function draw() {
    if (location.hash !== '#welcome') history.replaceState(null, '', '#' + tab);
    const state = await api('GET', '/api/state');
    R = state.restaurant;
    const nav = el('div', { class: 'tabs noprint' }, ...TABS.map(([k, l]) => el('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, l)));
    const views = { menu: menuTab, tables: tablesTab, staff: staffTab, report: reportTab, settings: settingsTab, system: systemTab };
    const body = await (views[tab] || menuTab)(state);
    const A = state.account || {};
    const acct = A.status === 'suspended' ? el('div', { class: 'banner bad noprint' }, 'This restaurant is suspended. Guests cannot order. Contact MehmaanOS support.')
      : A.status === 'trial' && A.trialDaysLeft != null ? el('div', { class: 'banner ' + (A.trialDaysLeft <= 7 ? 'bad' : 'ok') + ' noprint small' },
        A.trialDaysLeft > 0 ? `Free trial: ${A.trialDaysLeft} day(s) left.` : 'Your free trial has ended. Contact MehmaanOS to continue.', ` Your address: ${location.host}/r/${A.slug}`) : null;
    if (location.hash === '#welcome') { tab = 'menu'; history.replaceState(null, '', '#menu'); toast('Welcome! Next: check your menu, then add staff and print your QR codes.', 6000); }
    fill(app, acct, state.defaultPins && tab !== 'staff' ? el('div', { class: 'banner bad noprint' }, 'Setup mode: built-in PINs are active. ', el('a', { href: '#staff', onclick: () => { tab = 'staff'; draw(); } }, 'Create your Manager account')) : null, nav, body);
  }
  draw().catch(e => toast(e.message));
})();
