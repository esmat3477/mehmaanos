'use strict';
const crypto = require('crypto');

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function hmac(secret, s) { return crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Table QR token: tableId.nonce.signature. Rotating the nonce revokes old QR codes.
function tableToken(secret, table) {
  const body = `${table.id}.${table.nonce}`;
  return `${b64u(body)}.${hmac(secret, 'tbl:' + body)}`;
}
function verifyTableToken(secret, tables, token) {
  const [body64, sig] = String(token || '').split('.');
  if (!body64 || !sig) return null;
  let body;
  try { body = Buffer.from(body64, 'base64url').toString(); } catch { return null; }
  if (!safeEq(hmac(secret, 'tbl:' + body), sig)) return null;
  const [id, nonce] = body.split('.');
  const table = tables.find(t => t.id === id);
  if (!table || String(table.nonce) !== nonce) return null;
  return table;
}

// Staff session cookie: role.userId.expiry.signature
const ROLES = ['kitchen', 'staff', 'admin'];
function sessionCookie(secret, role, uid = 'env', hours = 14) {
  const exp = Date.now() + hours * 3600e3;
  const body = `${role}.${uid}.${exp}`;
  return `${body}.${hmac(secret, 'ses:' + body)}`;
}
function verifySession(secret, value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const [role, uid, exp, sig] = parts;
  if (!ROLES.includes(role) || Number(exp) < Date.now()) return null;
  if (!safeEq(hmac(secret, `ses:${role}.${uid}.${exp}`), sig)) return null;
  return { role, uid };
}

// Staff PINs are stored only as salted scrypt hashes.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
function checkPin(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  return safeEq(crypto.scryptSync(String(pin), salt, 32).toString('hex'), hash);
}
const validPin = pin => /^\d{4,8}$/.test(String(pin));

module.exports = { tableToken, verifyTableToken, sessionCookie, verifySession, hashPin, checkPin, validPin, safeEq, ROLES };
