'use strict';
// Pure order logic: pricing, validation and the order state machine.
// No I/O here so it can be unit-tested in isolation.

const TRANSITIONS = {
  PendingApproval: ['Accepted', 'Rejected', 'Canceled'],
  Accepted: ['InPreparation', 'Canceled'],
  InPreparation: ['Ready', 'Canceled'],
  Ready: ['Served'],
  Served: ['Closed'],
  Rejected: [],
  Canceled: [],
  Closed: []
};

// Which role may perform which transition.
const ROLE_RULES = {
  Accepted: ['staff', 'admin'],
  Rejected: ['staff', 'admin'],
  InPreparation: ['kitchen', 'staff', 'admin'],
  Ready: ['kitchen', 'staff', 'admin'],
  Served: ['staff', 'admin'],
  Closed: ['staff', 'admin'],
  Canceled: ['staff', 'admin']
};

const ACTIVE = ['PendingApproval', 'Accepted', 'InPreparation', 'Ready', 'Served'];
const SPICE = ['mild', 'medium', 'hot'];
const MAX_QTY = 20;
const MAX_LINES = 30;

class OrderError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function canTransition(from, to, role) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) return false;
  return (ROLE_RULES[to] || []).includes(role);
}

// Build a priced, snapshotted order from a client cart.
// The client only sends item ids, quantities and options; every price comes from the server menu.
function quote(menu, cart) {
  if (!Array.isArray(cart) || cart.length === 0) throw new OrderError('EMPTY_CART', 'Cart is empty');
  if (cart.length > MAX_LINES) throw new OrderError('TOO_MANY_LINES', 'Too many lines in one order');
  const byId = new Map(menu.items.map(i => [i.id, i]));
  let total = 0;
  const lines = cart.map(raw => {
    const item = byId.get(String(raw.itemId));
    if (!item) throw new OrderError('UNKNOWN_ITEM', 'An item is no longer on the menu');
    if (!item.available) throw new OrderError('UNAVAILABLE', `${item.name.en} is not available right now`);
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new OrderError('BAD_QTY', 'Invalid quantity');
    let spice = null;
    if (item.spicy) {
      spice = SPICE.includes(raw.spice) ? raw.spice : 'medium';
    }
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 140) : '';
    if (!Number.isInteger(item.price) || item.price < 0) throw new OrderError('BAD_PRICE', 'Menu price misconfigured', 500);
    const lineTotal = item.price * qty; // integer currency units, no floats
    total += lineTotal;
    return {
      itemId: item.id,
      name: { ...item.name },          // snapshot: later menu edits do not change history
      unitPrice: item.price,
      qty, spice, note, lineTotal,
      allergens: [...(item.allergens || [])]
    };
  });
  return { lines, total, menuVersion: menu.version };
}

module.exports = { TRANSITIONS, ROLE_RULES, ACTIVE, SPICE, OrderError, canTransition, quote };
