/**
 * Order queue logic shared by netlify/functions/order.mjs and
 * netlify/functions/sweep-orders.mjs. Pure functions with an injected
 * Blobs store + fetch so tests can run without Netlify.
 *
 * Blobs keys (store "orders"):
 *   order/<orderId>    full record { order, contact, sent, attempts, ... }
 *   pending/<orderId>  marker for "not yet confirmed by the Sheet"
 *   meta/counter       { next } — round-robin pointer for contacts
 */
import SITE_CONFIG from '../../public/site-config.js';

export const STORE_NAME = 'orders';
export const ORDER_ID_RE = /^PB-[A-Z0-9-]{4,40}$/;
const MAX_BODY_BYTES = 20000;
const SHEET_TIMEOUT_MS = 20000;

/**
 * Strong consistency (read-your-writes) needs the uncached edge URL that
 * Netlify provides in production; fall back to eventual where it's missing
 * (e.g. some local setups).
 */
export function blobsConsistency() {
  try {
    let ctx = globalThis.netlifyBlobsContext;
    if (!ctx && typeof process !== 'undefined' && process.env.NETLIFY_BLOBS_CONTEXT) {
      ctx = process.env.NETLIFY_BLOBS_CONTEXT;
    }
    if (!ctx) return 'strong';
    const data = typeof ctx === 'string' ? JSON.parse(Buffer.from(ctx, 'base64').toString('utf8')) : ctx;
    return data && data.uncachedEdgeURL ? 'strong' : 'eventual';
  } catch (err) {
    return 'strong';
  }
}

export function getConfig() {
  return SITE_CONFIG;
}

export function appsScriptUrl(env) {
  const fromEnv = env && env.APPS_SCRIPT_URL;
  return String(fromEnv || SITE_CONFIG.appsScriptUrl || '').trim();
}

export function publicContact(c) {
  return c ? { id: c.id, name: c.name, number: c.number, display: c.display } : null;
}

export function findContact(id, config = SITE_CONFIG) {
  return config.contacts.find((c) => c.id === id) || null;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Validate + whitelist the page payload. Returns { ok, order } or { ok:false, errors }. */
export function validateOrder(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const orderId = str(raw.orderId, 60);
  if (!ORDER_ID_RE.test(orderId)) errors.push('orderId');
  const name = str(raw.name, 100);
  if (!name) errors.push('name');
  const phone = String(raw.phone || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) errors.push('phone');
  const pickupDate = str(raw.pickupDate, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) errors.push('pickupDate');
  const mass = str(raw.mass, 10);
  if (!/^\d{2}:\d{2}$/.test(mass)) errors.push('mass');

  const items = [];
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 30) {
    errors.push('items');
  } else {
    raw.items.forEach((line, i) => {
      const itemName = str(line && line.name, 120);
      const qty = Number(line && line.qty);
      const price = Number(line && line.price);
      if (!itemName || !Number.isInteger(qty) || qty < 1 || qty > 99 ||
          !Number.isFinite(price) || price < 0 || price > 100000) {
        errors.push('items[' + i + ']');
        return;
      }
      items.push({
        id: str(line.id, 80),
        name: itemName,
        qty,
        price,
        lineTotal: qty * price
      });
    });
  }
  const totalItems = items.reduce((s, l) => s + l.qty, 0);
  const totalAmount = items.reduce((s, l) => s + l.lineTotal, 0);
  if (!errors.length) {
    if (raw.totalItems != null && Number(raw.totalItems) !== totalItems) errors.push('totalItems');
    if (raw.totalAmount != null && Number(raw.totalAmount) !== totalAmount) errors.push('totalAmount');
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    order: {
      timestamp: str(raw.timestamp, 40),
      orderId,
      name,
      phone,
      pickupDate,
      pickupDateLabel: str(raw.pickupDateLabel, 40),
      pickupDateShort: str(raw.pickupDateShort, 40),
      mass,
      massLabel: str(raw.massLabel, 40),
      items,
      totalItems,
      totalAmount
    },
    contactHint: str(raw.assignedContactId, 40)
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- stock check (fails open) ---------- */

const STOCK_TIMEOUT_MS = 2000;
const STOCK_TTL_MS = 15000;
let stockCache = { url: '', at: 0, data: null };

export function resetStockCache() {
  stockCache = { url: '', at: 0, data: null };
}

function stockUrlFor(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'action=stock';
}

/**
 * GET ?action=stock from Apps Script ({dates:[{id, remaining:{item:n|null}}]}),
 * cached ~15s in memory. Returns null on ANY failure so callers fail open.
 */
export async function fetchStock(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const url = opts.url || appsScriptUrl(opts.env || {});
  const now = opts.now || Date.now;
  if (!/^https?:\/\//.test(url) || /PASTE_YOUR_/i.test(url)) return null;
  const ttl = opts.ttlMs == null ? STOCK_TTL_MS : opts.ttlMs;
  if (stockCache.data && stockCache.url === url && now() - stockCache.at < ttl) return stockCache.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || STOCK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(stockUrlFor(url), { method: 'GET', redirect: 'follow', signal: controller.signal });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    if (!data || !data.ok || !Array.isArray(data.dates)) return null;
    stockCache = { url, at: now(), data };
    return data;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Names of order lines that exceed the date's remaining stock. null / missing = unlimited. */
export function stockShortfalls(order, stock) {
  if (!stock || !Array.isArray(stock.dates)) return [];
  const date = stock.dates.find((d) => d && d.id === order.pickupDate);
  if (!date || !date.remaining || typeof date.remaining !== 'object') return [];
  const wanted = new Map();
  for (const line of order.items || []) wanted.set(line.name, (wanted.get(line.name) || 0) + line.qty);
  const short = [];
  for (const [name, qty] of wanted) {
    const rem = date.remaining[name];
    if (rem === null || typeof rem === 'undefined' || rem === '' || isNaN(Number(rem))) continue;
    if (qty > Number(rem)) short.push(name);
  }
  return short;
}

/**
 * Keep the cached remaining in step with orders we just accepted so a
 * burst inside the cache window doesn't all see the same stale numbers.
 */
export function noteOrderInStockCache(order) {
  const data = stockCache.data;
  const date = data && data.dates && data.dates.find((d) => d && d.id === order.pickupDate);
  if (!date || !date.remaining) return;
  for (const line of order.items || []) {
    const rem = date.remaining[line.name];
    if (rem === null || typeof rem === 'undefined' || isNaN(Number(rem))) continue;
    date.remaining[line.name] = Math.max(0, Number(rem) - line.qty);
  }
}

/**
 * Round-robin pointer with compare-and-swap (onlyIfNew / onlyIfMatch),
 * so two orders landing at the same moment don't both get the same slot.
 */
export async function nextContactIndex(store, count) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata('meta/counter', { type: 'json' });
    if (!cur || !cur.data) {
      const res = await store.setJSON('meta/counter', { next: 1 }, { onlyIfNew: true });
      if (res && res.modified) return 0;
    } else {
      const value = Number(cur.data.next) || 0;
      const res = await store.setJSON('meta/counter', { next: value + 1 }, { onlyIfMatch: cur.etag });
      if (res && res.modified) return value % count;
    }
    await sleep(20 + Math.floor(Math.random() * 60));
  }
  return Math.floor(Math.random() * count);
}

/**
 * Store the order (idempotent by orderId) and pick its WhatsApp contact.
 * Returns { status, body } for the HTTP response, plus `record`.
 */
export async function acceptOrder(store, raw, opts = {}) {
  const config = opts.config || SITE_CONFIG;
  const now = opts.now ? opts.now() : Date.now();
  const v = validateOrder(raw);
  if (!v.ok) return { status: 400, body: { ok: false, error: 'invalid', fields: v.errors } };
  const { order } = v;
  const key = 'order/' + order.orderId;

  const existing = await store.get(key, { type: 'json' });
  if (existing) {
    return {
      status: 200,
      record: existing,
      body: { ok: true, status: 'duplicate', orderId: order.orderId, contact: publicContact(existing.contact) }
    };
  }

  // Stock check for NEW orders only (duplicates answered above). A retry
  // from the page's outbox carries a contact hint: the customer was already
  // told "placed", so it is never rejected here (the Sheet flags OVERSOLD).
  if (!v.contactHint && typeof opts.stockCheck === 'function') {
    const short = await opts.stockCheck(order);
    if (short && short.length) {
      return { status: 409, body: { ok: false, error: 'out_of_stock', items: short } };
    }
  }

  // A client that already fell back to a random contact (function was
  // unreachable earlier) keeps that contact, since the customer already
  // messaged that person.
  let contact = v.contactHint ? findContact(v.contactHint, config) : null;
  if (!contact) {
    const idx = await nextContactIndex(store, config.contacts.length);
    contact = config.contacts[idx];
  }

  const record = {
    order,
    contact: publicContact(contact),
    receivedAt: new Date(now).toISOString(),
    sent: false,
    attempts: 0,
    // Give the immediate (waitUntil) forward a head start before the sweep.
    nextAttemptAt: now + 60 * 1000,
    lastError: ''
  };
  const res = await store.setJSON(key, record, { onlyIfNew: true });
  if (!res || !res.modified) {
    // Lost a race with an identical resubmit: answer with the winner.
    const winner = await store.get(key, { type: 'json' });
    if (winner) {
      return {
        status: 200,
        record: winner,
        body: { ok: true, status: 'duplicate', orderId: order.orderId, contact: publicContact(winner.contact) }
      };
    }
  }
  await store.setJSON('pending/' + order.orderId, { orderId: order.orderId, queuedAt: record.receivedAt });
  return {
    status: 200,
    record,
    body: { ok: true, status: 'queued', orderId: order.orderId, contact: record.contact }
  };
}

export function sheetPayload(record) {
  const c = record.contact || {};
  const payload = Object.assign({}, record.order, {
    assignedTo: c.name || '',
    assignedContactId: c.id || '',
    assignedNumber: c.display || c.number || '',
    source: 'netlify'
  });
  if (record.useFallback) payload.fallback = true;
  return payload;
}

export function backoffMs(attempts) {
  // 1, 2, 4, 8, 16, 30, 30... minutes
  return Math.min(30, Math.pow(2, Math.max(0, attempts - 1))) * 60 * 1000;
}

async function postToSheet(fetchImpl, url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('Non-JSON reply from Apps Script: ' + text.slice(0, 120));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push one stored order to the Apps Script web app. Marks it sent on
 * {ok, status: saved|duplicate}; otherwise schedules a retry.
 */
export async function forwardOrder(store, orderId, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const url = opts.url || appsScriptUrl(opts.env || {});
  const now = opts.now || Date.now;
  const key = 'order/' + orderId;
  const record = await store.get(key, { type: 'json' });
  if (!record) {
    await store.delete('pending/' + orderId);
    return { ok: false, status: 'missing' };
  }
  if (record.sent) {
    await store.delete('pending/' + orderId);
    return { ok: true, status: 'already-sent' };
  }
  if (!/^https?:\/\//.test(url) || /PASTE_YOUR_/i.test(url)) {
    return { ok: false, status: 'no-url' };
  }

  let result;
  let error = '';
  try {
    result = await postToSheet(fetchImpl, url, sheetPayload(record));
    if (result && result.status === 'invalid_date' && !record.useFallback) {
      // The order is already promised to the customer; save it anyway
      // with fallback:true so it lands in the Sheet for a human to sort.
      record.useFallback = true;
      result = await postToSheet(fetchImpl, url, sheetPayload(record));
    }
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }

  if (result && result.ok && (result.status === 'saved' || result.status === 'duplicate')) {
    record.sent = true;
    record.sentAt = new Date(now()).toISOString();
    record.sheetStatus = result.status;
    record.lastError = '';
    await store.setJSON(key, record);
    await store.delete('pending/' + orderId);
    return { ok: true, status: result.status };
  }

  // Another worker (sweep vs. immediate send) may have succeeded meanwhile.
  const latest = await store.get(key, { type: 'json' });
  if (latest && latest.sent) return { ok: true, status: 'already-sent' };
  if (latest && latest.attempts > (record.attempts || 0)) record.attempts = latest.attempts;
  record.attempts = (record.attempts || 0) + 1;
  record.lastAttemptAt = new Date(now()).toISOString();
  record.nextAttemptAt = now() + backoffMs(record.attempts);
  record.lastError = error || JSON.stringify(result || {}).slice(0, 300);
  await store.setJSON(key, record);
  return { ok: false, status: 'retry', error: record.lastError, attempts: record.attempts };
}

/** Retry every pending order whose backoff has elapsed. */
export async function sweepPending(store, opts = {}) {
  const now = opts.now || Date.now;
  const budgetMs = opts.budgetMs || 25000;
  const started = now();
  const { blobs } = await store.list({ prefix: 'pending/' });
  const summary = { pending: blobs.length, tried: 0, sent: 0, failed: 0, skipped: 0 };
  for (const blob of blobs) {
    if (now() - started > budgetMs) break;
    const orderId = blob.key.slice('pending/'.length);
    const record = await store.get('order/' + orderId, { type: 'json' });
    if (record && !record.sent && !opts.force && record.nextAttemptAt && record.nextAttemptAt > now()) {
      summary.skipped++;
      continue;
    }
    summary.tried++;
    const r = await forwardOrder(store, orderId, opts);
    if (r.ok) summary.sent++;
    else summary.failed++;
  }
  return summary;
}

export async function countPending(store) {
  const { blobs } = await store.list({ prefix: 'pending/' });
  return blobs.length;
}
