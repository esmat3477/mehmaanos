'use strict';
// Shared helpers for all MehmaanOS screens.
window.MOS = (() => {
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.message || 'Request failed'); e.code = data.error; e.status = res.status; throw e; }
    return data;
  }
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  // Amounts are integer minor units (fils, cents; whole afghani for AFN).
  const DEC = { AFN: 0, AED: 2, SAR: 2, QAR: 2, EUR: 2, GBP: 2, USD: 2, PKR: 0, INR: 0 };
  const LOCALE = { en: 'en-US', fa: 'fa-AF', ps: 'ps-AF', ar: 'ar-AE', ur: 'ur-PK', hi: 'hi-IN' };
  const RTL = ['fa', 'ps', 'ar', 'ur'];
  function money(minor, cur = 'AFN', lang = 'en') {
    const dec = DEC[cur] ?? 2, v = (minor || 0) / 10 ** dec;
    try { return new Intl.NumberFormat(LOCALE[lang] || 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v); }
    catch { return `${v.toFixed(dec)} ${cur}`; }
  }
  const toMinor = (major, cur) => Math.round(Number(major) * 10 ** (DEC[cur] ?? 2));
  const toMajor = (minor, cur) => ((minor || 0) / 10 ** (DEC[cur] ?? 2)).toFixed(DEC[cur] ?? 2);
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    const m = Math.floor(s / 60); return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }
  function toast(msg, ms = 2600) {
    const t = el('div', { class: 'toast', role: 'status' }, msg);
    document.body.append(t); setTimeout(() => t.remove(), ms);
  }
  // Realtime with automatic reconnect; on each (re)connect, refetch the full state so nothing is missed.
  function live(onChange) {
    let es;
    const connect = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => onChange('resync');
      ['order', 'request', 'menu', 'settings'].forEach(t => es.addEventListener(t, ev => onChange(t, JSON.parse(ev.data))));
      es.onerror = () => { setStatus(false); };
      es.addEventListener('open', () => setStatus(true));
    };
    connect();
    setInterval(() => onChange('poll'), 30000); // belt and braces
  }
  function setStatus(ok) {
    const s = document.getElementById('conn');
    if (s) { s.textContent = ok ? '● live' : '● reconnecting…'; s.style.color = ok ? '#2FA36B' : '#E5484D'; }
  }
  async function requireRole(roles) {
    const { role } = await api('GET', '/api/me');
    if (!role || !roles.includes(role)) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('redirect'); }
    return role;
  }
  async function logout() { await api('POST', '/api/logout'); location.href = '/login'; }
  const STATUS = {
    PendingApproval: 'Awaiting staff', Accepted: 'Accepted', InPreparation: 'Preparing',
    Ready: 'Ready', Served: 'Served', Closed: 'Closed', Rejected: 'Rejected', Canceled: 'Canceled'
  };
  function fill(node, ...kids) { node.replaceChildren(...kids.flat().filter(k => k != null && k !== false)); }
  return { fill, api, el, money, toMinor, toMajor, RTL, DEC, ago, toast, live, requireRole, logout, STATUS, setStatus };
})();
