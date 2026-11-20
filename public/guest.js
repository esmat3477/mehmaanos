'use strict';
(() => {
  const { api, el, money, toast } = MOS;
  const token = location.pathname.split('/')[2] || '';
  const base = `/api/guest/${encodeURIComponent(token)}`;

  // UI strings. Dari (fa) and Pashto (ps) need native-speaker review before live use.
  const T = {
    en: { add: 'Add', cart: 'Your order', view: 'Review order', send: 'Send order to restaurant', sending: 'Sending…', total: 'Total',
      note: 'Note for the kitchen (optional)', spice: 'Spice level', mild: 'Mild', medium: 'Medium', hot: 'Hot', close: 'Close',
      orders: 'Your orders', waiter: 'Call waiter', bill: 'Ask for the bill', water: 'Water please', called: 'Request sent. A staff member will come.',
      claimed: 'A staff member is on the way.', paused: 'Online ordering is paused. Please ask a waiter.', items: 'items',
      allergens: 'Contains', unreviewed: 'Allergen information has not yet been confirmed by the restaurant. Please ask staff if you have an allergy.',
      confirm: 'Please check your order. Prices are confirmed by the restaurant when you send.', invalid: 'This table code is not valid. Please ask a waiter.',
      unavailable: 'Not available', payNote: 'Payment is made with staff, as usual.', tableLbl: 'Table',
      st: { PendingApproval: 'Waiting for staff to confirm', Accepted: 'Confirmed, sent to kitchen', InPreparation: 'Being prepared', Ready: 'Ready, coming to your table', Served: 'Served', Closed: 'Closed', Rejected: 'Not accepted, please ask staff', Canceled: 'Canceled, please ask staff' },
      al: { gluten: 'Gluten', crustaceans: 'Crustaceans', egg: 'Egg', fish: 'Fish', peanuts: 'Peanuts', soy: 'Soy', milk: 'Milk', nuts: 'Tree nuts', celery: 'Celery', mustard: 'Mustard', sesame: 'Sesame', sulphites: 'Sulphites', lupin: 'Lupin', molluscs: 'Molluscs' }, spicy: 'Spicy', offline: 'Connection problem. Your order was not sent yet. Try again.' },
    fa: { add: 'افزودن', cart: 'سفارش شما', view: 'دیدن سفارش', send: 'فرستادن سفارش به رستورانت', sending: 'در حال فرستادن…', total: 'مجموع',
      note: 'یادداشت برای آشپزخانه (اختیاری)', spice: 'میزان تندی', mild: 'کم‌تند', medium: 'متوسط', hot: 'تند', close: 'بستن',
      orders: 'سفارش‌های شما', waiter: 'صدا کردن پیشخدمت', bill: 'درخواست حساب', water: 'آب لطفاً', called: 'درخواست فرستاده شد. یکی از کارمندان می‌آید.',
      claimed: 'یکی از کارمندان در راه است.', paused: 'سفارش آنلاین فعلاً متوقف است. لطفاً از پیشخدمت بپرسید.', items: 'قلم',
      allergens: 'دارای', unreviewed: 'معلومات حساسیت‌زا هنوز از سوی رستورانت تأیید نشده است. اگر حساسیت دارید، از کارمندان بپرسید.',
      confirm: 'لطفاً سفارش خود را بررسی کنید. قیمت‌ها هنگام فرستادن از سوی رستورانت تأیید می‌شوند.', invalid: 'کد این میز معتبر نیست. لطفاً از پیشخدمت بپرسید.',
      unavailable: 'موجود نیست', payNote: 'پرداخت مانند همیشه نزد کارمندان انجام می‌شود.', tableLbl: 'میز',
      st: { PendingApproval: 'در انتظار تأیید کارمندان', Accepted: 'تأیید شد، به آشپزخانه رفت', InPreparation: 'در حال آماده‌سازی', Ready: 'آماده است، به میز شما می‌آید', Served: 'سرو شد', Closed: 'بسته شد', Rejected: 'پذیرفته نشد، لطفاً از کارمندان بپرسید', Canceled: 'لغو شد، لطفاً از کارمندان بپرسید' },
      al: { gluten: 'گلوتن', crustaceans: 'خرچنگ و میگو', egg: 'تخم مرغ', fish: 'ماهی', peanuts: 'مومپلی', soy: 'سویا', milk: 'شیر', nuts: 'مغزها', celery: 'کرفس', mustard: 'خردل', sesame: 'کنجد', sulphites: 'سولفیت', lupin: 'لوپین', molluscs: 'صدف' }, spicy: 'تند', offline: 'مشکل اتصال. سفارش هنوز فرستاده نشده. دوباره کوشش کنید.' },
    ps: { add: 'زیاتول', cart: 'ستاسو فرمایش', view: 'فرمایش وګورئ', send: 'فرمایش رستورانت ته ولېږئ', sending: 'لېږل کېږي…', total: 'ټول',
      note: 'د پخلنځي لپاره یادښت (اختیاري)', spice: 'د تریخوالي کچه', mild: 'لږ تریخ', medium: 'منځنی', hot: 'تریخ', close: 'بندول',
      orders: 'ستاسو فرمایشونه', waiter: 'ګارسون راوبلئ', bill: 'حساب وغواړئ', water: 'اوبه، مهرباني', called: 'غوښتنه ولېږل شوه. یو کارکوونکی به راشي.',
      claimed: 'یو کارکوونکی په لاره کې دی.', paused: 'آنلاین فرمایش اوس ودرول شوی. مهرباني وکړئ له ګارسون پوښتنه وکړئ.', items: 'توکي',
      allergens: 'لري', unreviewed: 'د حساسیت معلومات لا د رستورانت لخوا نه دي تایید شوي. که حساسیت لرئ، له کارکوونکو وپوښتئ.',
      confirm: 'مهرباني وکړئ خپل فرمایش وګورئ. بیې د لېږلو پر مهال د رستورانت لخوا تاییدېږي.', invalid: 'د دې مېز کوډ سم نه دی. له ګارسون پوښتنه وکړئ.',
      unavailable: 'نشته', payNote: 'تادیه د تل په څېر له کارکوونکو سره کېږي.', tableLbl: 'مېز',
      st: { PendingApproval: 'د کارکوونکو تایید ته انتظار', Accepted: 'تایید شو، پخلنځي ته لاړ', InPreparation: 'چمتو کېږي', Ready: 'چمتو دی، ستاسو مېز ته راځي', Served: 'وړاندې شو', Closed: 'بند شو', Rejected: 'ونه منل شو، له کارکوونکو وپوښتئ', Canceled: 'لغوه شو، له کارکوونکو وپوښتئ' },
      al: { gluten: 'ګلوټن', crustaceans: 'چنګاښ او مېګو', egg: 'هګۍ', fish: 'کب', peanuts: 'مومپلي', soy: 'سویا', milk: 'شیدې', nuts: 'مغزیات', celery: 'کرفس', mustard: 'شړشم', sesame: 'کونجد', sulphites: 'سلفایټ', lupin: 'لوپین', molluscs: 'صدف' }, spicy: 'تریخ', offline: 'د اړیکې ستونزه. فرمایش لا نه دی لېږل شوی. بیا هڅه وکړئ.' }
  };

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const S = {
    lang: store.get('mos.lang', null) || ((navigator.language || '').startsWith('fa') ? 'fa' : (navigator.language || '').startsWith('ps') ? 'ps' : 'en'),
    data: null, cat: null, cart: [], orderIds: store.get('mos.orders.' + token, []), orders: [], requests: [],
    pendingKey: null, sending: false
  };
  const t = k => T[S.lang][k] ?? T.en[k];
  const nm = o => (o && (o[S.lang] || o.en)) || '';
  const app = document.getElementById('app');

  function setLang(l) {
    S.lang = l; store.set('mos.lang', l);
    document.documentElement.lang = l; document.documentElement.dir = l === 'en' ? 'ltr' : 'rtl';
    render();
  }
  function renderLangs() {
    const box = document.getElementById('langs'); box.replaceChildren();
    [['en', 'EN'], ['fa', 'دری'], ['ps', 'پښتو']].forEach(([k, lbl]) =>
      box.append(el('button', { class: S.lang === k ? 'on' : '', onclick: () => setLang(k), 'aria-pressed': S.lang === k }, lbl)));
  }

  const cartCount = () => S.cart.reduce((a, l) => a + l.qty, 0);
  const itemById = id => S.data.menu.items.find(i => i.id === id);
  const cartTotal = () => S.cart.reduce((a, l) => a + (itemById(l.itemId)?.price || 0) * l.qty, 0);
  const cur = () => S.data.restaurant.currency;

  function addToCart(item, spice) {
    const key = item.id + '|' + (spice || '');
    const line = S.cart.find(l => l.key === key);
    if (line) line.qty = Math.min(20, line.qty + 1); else S.cart.push({ key, itemId: item.id, qty: 1, spice: spice || null, note: '' });
    S.pendingKey = null; // cart changed, a new submission gets a new idempotency key
    render();
  }

  function spiceSheet(item) {
    let choice = 'medium';
    const seg = el('div', { class: 'seg' });
    const paint = () => { seg.replaceChildren(...['mild', 'medium', 'hot'].map(s => el('button', { class: s === choice ? 'on' : '', onclick: () => { choice = s; paint(); } }, t(s)))); };
    paint();
    const sheet = el('div', { class: 'sheet', onclick: e => { if (e.target === sheet) sheet.remove(); } },
      el('div', { class: 'card' },
        el('h2', {}, nm(item.name)), el('p', { class: 'muted' }, t('spice')), seg,
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('button', { class: 'ghost', onclick: () => sheet.remove() }, t('close')),
          el('button', { class: 'primary', style: 'flex:1', onclick: () => { sheet.remove(); addToCart(item, choice); } }, `${t('add')} · ${money(item.price, cur(), S.lang)}`))));
    document.body.append(sheet);
  }

  function cartSheet() {
    const body = el('div', { class: 'card' });
    const sheet = el('div', { class: 'sheet', onclick: e => { if (e.target === sheet) sheet.remove(); } }, body);
    const draw = () => {
      body.replaceChildren(
        el('div', { class: 'row between' }, el('h2', { style: 'margin:0' }, t('cart')), el('button', { class: 'ghost', onclick: () => sheet.remove() }, t('close'))),
        ...S.cart.map(l => {
          const it = itemById(l.itemId);
          return el('div', { class: 'item' },
            el('div', { style: 'flex:1' },
              el('h3', {}, nm(it.name)), l.spice ? el('p', {}, `${t('spice')}: ${t(l.spice)}`) : null,
              el('input', { placeholder: t('note'), value: l.note, maxlength: 140, oninput: e => { l.note = e.target.value; S.pendingKey = null; } })),
            el('div', { style: 'text-align:end' },
              el('div', { class: 'price' }, money(it.price * l.qty, cur(), S.lang)),
              el('div', { class: 'qty', style: 'margin-top:6px' },
                el('button', { 'aria-label': '-', onclick: () => { l.qty--; if (l.qty < 1) S.cart = S.cart.filter(x => x !== l); S.pendingKey = null; if (!S.cart.length) { sheet.remove(); render(); } else { draw(); render(); } } }, '−'),
                el('b', {}, l.qty),
                el('button', { 'aria-label': '+', onclick: () => { l.qty = Math.min(20, l.qty + 1); S.pendingKey = null; draw(); render(); } }, '+'))));
        }),
        el('div', { class: 'row between', style: 'margin:12px 0' }, el('b', {}, t('total')), el('b', { class: 'price' }, money(cartTotal(), cur(), S.lang))),
        el('p', { class: 'small muted' }, t('confirm'), ' ', t('payNote')),
        el('button', { class: 'primary', style: 'width:100%', disabled: S.sending, onclick: () => submit(sheet) }, S.sending ? t('sending') : `${t('send')} · ${t('tableLbl')} ${S.data.table.label}`)
      );
    };
    draw(); document.body.append(sheet);
  }

  async function submit(sheet) {
    if (S.sending) return;
    S.sending = true;
    // One key per cart attempt: retries after a network error reuse it, so the kitchen never gets a duplicate.
    S.pendingKey = S.pendingKey || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
    try {
      const r = await api('POST', base + '/orders', { idemKey: S.pendingKey.replace(/[^A-Za-z0-9_-]/g, ''), cart: S.cart.map(({ itemId, qty, spice, note }) => ({ itemId, qty, spice, note })) });
      if (!S.orderIds.includes(r.order.id)) S.orderIds.unshift(r.order.id);
      store.set('mos.orders.' + token, S.orderIds.slice(0, 20));
      S.cart = []; S.pendingKey = null; sheet.remove();
      await refresh(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      toast(e.status ? e.message : t('offline'), 4000);
      if (e.code === 'UNAVAILABLE' || e.code === 'UNKNOWN_ITEM') { S.pendingKey = null; await loadMenu(); }
    } finally { S.sending = false; if (document.body.contains(sheet)) { sheet.remove(); cartSheet(); } }
  }

  async function callStaff(type) {
    try { await api('POST', base + '/requests', { type }); toast(t('called')); refresh(); }
    catch (e) { toast(e.message); }
  }

  const STEP = { PendingApproval: 1, Accepted: 2, InPreparation: 3, Ready: 4, Served: 5, Closed: 5 };
  function ordersView() {
    if (!S.orders.length && !S.requests.length) return null;
    return el('section', { class: 'card', style: 'margin:12px 0' },
      el('h2', { style: 'margin-top:0' }, t('orders')),
      ...S.requests.map(r => el('div', { class: 'banner ' + (r.status === 'claimed' ? 'ok' : 'warn') }, `${t(r.type)}: ${r.status === 'claimed' ? t('claimed') : t('called')}`)),
      ...S.orders.map(o => el('div', { style: 'padding:8px 0;border-top:1px solid var(--line)' },
        el('div', { class: 'row between' }, el('b', {}, `#${o.no}`), el('span', { class: 'pill ' + o.status }, T[S.lang].st[o.status])),
        el('div', { class: 'steps', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map(i => el('div', { class: (STEP[o.status] || 0) >= i ? 'on' : '' }))),
        el('div', { class: 'small muted' }, o.lines.map(l => `${l.qty}× ${nm(l.name)}`).join(' · ')),
        el('div', { class: 'small' }, `${t('total')}: ${money(o.total, cur(), S.lang)}`))));
  }

  function render() {
    renderLangs();
    if (!S.data) return;
    document.getElementById('rname').textContent = S.data.restaurant.name;
    document.getElementById('tlabel').textContent = `${t('tableLbl')} ${S.data.table.label}`;
    const m = S.data.menu;
    S.cat = S.cat || m.categories[0]?.id;
    const items = m.items.filter(i => i.cat === S.cat);
    MOS.fill(app,
      S.data.orderingPaused ? el('div', { class: 'banner warn' }, t('paused')) : null,
      ordersView(),
      el('div', { class: 'fab', style: 'margin:8px 0' },
        el('button', { class: 'ghost', onclick: () => callStaff('waiter') }, '🛎 ', t('waiter')),
        el('button', { class: 'ghost', onclick: () => callStaff('bill') }, '🧾 ', t('bill')),
        el('button', { class: 'ghost', onclick: () => callStaff('water') }, '💧 ', t('water'))),
      m.allergenReview ? null : el('div', { class: 'banner warn small' }, t('unreviewed')),
      el('nav', { class: 'tabs', 'aria-label': 'Menu categories' }, ...m.categories.map(c =>
        el('button', { class: c.id === S.cat ? 'on' : '', onclick: () => { S.cat = c.id; render(); } }, nm(c.name)))),
      el('section', { class: 'card' }, ...items.map(it => {
        const inCart = S.cart.filter(l => l.itemId === it.id).reduce((a, l) => a + l.qty, 0);
        return el('article', { class: 'item' },
          el('div', { style: 'flex:1' },
            el('h3', {}, nm(it.name)), el('p', {}, nm(it.desc)),
            el('div', { class: 'tags' },
              it.spicy ? el('span', { class: 'tag spicy' }, '🌶 ', t('spicy')) : null,
              ...(it.allergens || []).map(a => el('span', { class: 'tag' }, `${t('allergens')}: ${T[S.lang].al[a] || a}`)))),
          el('div', { style: 'text-align:end;min-width:96px' },
            el('div', { class: 'price' }, money(it.price, cur(), S.lang)),
            it.available
              ? el('button', { class: 'primary', style: 'margin-top:8px', disabled: S.data.orderingPaused, onclick: () => it.spicy ? spiceSheet(it) : addToCart(it) }, inCart ? `${t('add')} (${inCart})` : t('add'))
              : el('div', { class: 'small muted', style: 'margin-top:8px' }, t('unavailable'))));
      }))
    );
    let bar = document.querySelector('.cartbar');
    if (cartCount() && !S.data.orderingPaused) {
      if (!bar) { bar = el('div', { class: 'cartbar' }); document.body.append(bar); }
      bar.replaceChildren(el('div', { class: 'wrap narrow row between', style: 'padding:0' },
        el('div', {}, el('b', {}, money(cartTotal(), cur(), S.lang)), el('div', { class: 'small' }, `${cartCount()} ${t('items')}`)),
        el('button', { onclick: cartSheet }, t('view'))));
    } else if (bar) bar.remove();
  }

  async function loadMenu() {
    try {
      S.data = await api('GET', base + '/menu');
      // drop cart lines for items that disappeared or became unavailable
      S.cart = S.cart.filter(l => { const it = itemById(l.itemId); return it && it.available; });
      render();
    } catch (e) {
      app.replaceChildren(el('div', { class: 'banner bad' }, e.status === 403 ? t('invalid') : t('offline')));
      renderLangs();
    }
  }
  async function refresh() {
    if (!S.data) return;
    try {
      const r = await api('GET', `${base}/orders?ids=${S.orderIds.join(',')}`);
      S.orders = r.orders.sort((a, b) => b.no - a.no); S.requests = r.requests;
      render();
    } catch {}
  }

  document.documentElement.lang = S.lang; document.documentElement.dir = S.lang === 'en' ? 'ltr' : 'rtl';
  loadMenu().then(refresh);
  setInterval(refresh, 7000);
  setInterval(loadMenu, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadMenu().then(refresh); } });
})();
