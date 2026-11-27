/**
 * Order queue logic shared by netlify/functions/order.mjs and
 * netlify/functions/sweep-orders.mjs. Pure functions with an injected
 * Blobs store + fetch so tests can run without Netlify.
 *
 * Blobs keys (store "orders"):
 *   order/<orderId>    full record { order, sent, attempts, ... }
 *   pending/<orderId>  marker for "not yet confirmed by the Sheet"
 */
import SITE_CONFIG from '../../public/site-config.js';

export const STORE_NAME = 'orders';
export const ORDER_ID_RE = /^PB-[A-Z0-9-]{4,40}$/;
/**
 * Bulk discount rule from site-config.js (poster: 10% off orders of 50 cakes
 * and above). Falls back to the same defaults if the config has no usable value.
 */
export function bulkDiscountRule(config = SITE_CONFIG) {
  const b = (config && config.bulkDiscount) || {};
  const minCakes = Number.isInteger(Number(b.minCakes)) && Number(b.minCakes) > 0 ? Number(b.minCakes) : 50;
  const percent = Number(b.percent) > 0 && Number(b.percent) < 100 ? Number(b.percent) : 10;
  return { minCakes, percent };
}

/** Subtotal -> { discountPercent, discountAmount, totalAmount } (whole rupees). */
export function priceOrder(subtotal, totalCakes, config = SITE_CONFIG) {
  const rule = bulkDiscountRule(config);
  const discountPercent = totalCakes >= rule.minCakes ? rule.percent : 0;
  const discountAmount = Math.round(subtotal * discountPercent / 100);
  return { discountPercent, discountAmount, totalAmount: subtotal - discountAmount };
}

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

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Validate + whitelist the page payload. Returns { ok, order } or { ok:false, errors }. */
export function validateOrder(raw, config = SITE_CONFIG) {
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
  // Mass time is no longer collected; legacy raw.mass / raw.massLabel are ignored.

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
  const subtotal = items.reduce((s, l) => s + l.lineTotal, 0);
  // The server decides the discount; the page's numbers must agree with it.
  const priced = priceOrder(subtotal, totalItems, config);
  let discountPercent = priced.discountPercent;
  let discountAmount = priced.discountAmount;
  let totalAmount = priced.totalAmount;
  // A retry from the phone's outbox (or a fallback) may have been queued before
  // the bulk offer existed: the customer already saw the undiscounted total, so
  // keep it as sent instead of losing the order.
  const lenient = raw.retry === true || raw.fallback === true;
  if (!errors.length) {
    if (raw.totalItems != null && Number(raw.totalItems) !== totalItems) errors.push('totalItems');
    if (raw.totalAmount != null) {
      const sent = Number(raw.totalAmount);
      if (sent === priced.totalAmount) {
        // correct: the discount fields, when present, must agree too
        if (raw.subtotal != null && Number(raw.subtotal) !== subtotal) errors.push('subtotal');
        if (raw.discountPercent != null && Number(raw.discountPercent) !== discountPercent) errors.push('discountPercent');
        if (raw.discountAmount != null && Number(raw.discountAmount) !== discountAmount) errors.push('discountAmount');
      } else if (lenient && sent === subtotal) {
        discountPercent = 0;
        discountAmount = 0;
        totalAmount = subtotal;
      } else {
        errors.push('totalAmount');
      }
    }
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
      items,
      totalItems,
      subtotal,
      discountPercent,
      discountAmount,
      totalAmount
    },
    // A retry from the page's outbox (or an older page that still sends
    // assignedContactId) was already confirmed to the customer, so the stock
    // check must not reject it. Everything else in the payload is dropped.
    skipStockCheck: raw.retry === true || raw.fallback === true || !!str(raw.assignedContactId, 40)
  };
}

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

/* ---------- durable stock snapshot (so nobody waits on Apps Script) ---------- */

export const STOCK_SNAPSHOT_KEY = 'stock/latest';
/** Older than this and /api/stock refreshes the snapshot in the background. */
export const STOCK_STALE_MS = 10000;
/** An order check may lean on a snapshot this young when the live fetch fails. */
export const STOCK_SNAPSHOT_ORDER_MAX_AGE_MS = 5 * 60 * 1000;

/** {at, data} or null. Never throws. */
export async function readStockSnapshot(store) {
  try {
    const v = await store.get(STOCK_SNAPSHOT_KEY, { type: 'json' });
    if (v && v.data && Array.isArray(v.data.dates) && Number.isFinite(Number(v.at))) {
      return { at: Number(v.at), data: v.data };
    }
  } catch (err) { /* treat as no snapshot */ }
  return null;
}

/** Best effort. Returns true when written. */
export async function writeStockSnapshot(store, data, now = Date.now) {
  try {
    await store.setJSON(STOCK_SNAPSHOT_KEY, { at: now(), data });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fetch the live stock (bypassing the in-memory cache) and store it as the
 * snapshot. Returns the data, or null when Apps Script didn't answer in time.
 */
export async function refreshStockSnapshot(store, opts = {}) {
  const data = await fetchStock({
    url: opts.url,
    fetch: opts.fetch,
    now: opts.now,
    timeoutMs: opts.timeoutMs || 4000,
    ttlMs: 0
  });
  if (!data) return null;
  await writeStockSnapshot(store, data, opts.now || Date.now);
  return data;
}

/* ---------- durable summary snapshot (aggregates only, for /orders) ---------- */

export const SUMMARY_SNAPSHOT_KEY = 'summary/latest';
/** Older than this and /api/summary refreshes the snapshot in the background. */
export const SUMMARY_STALE_MS = 20000;
const SUMMARY_TIMEOUT_MS = 5000;

/**
 * The summary is aggregates only (cakes, amounts, counts). Keep just the keys
 * the dashboard reads, so a customer name or phone number can never end up in
 * the stored snapshot even if the backend sent one by mistake.
 */
export function sanitizeSummary(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.dates)) return null;
  const out = {};
  ['ok', 'version', 'lastUpdated', 'latestOrderAt', 'dates', 'grand'].forEach((k) => {
    if (k in data) out[k] = data[k];
  });
  return JSON.parse(JSON.stringify(out));
}

function summaryUrlFor(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'action=summary';
}

/** GET ?action=summary from Apps Script. null on ANY failure. */
export async function fetchSummary(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const url = opts.url || appsScriptUrl(opts.env || {});
  if (!/^https?:\/\//.test(url) || /PASTE_YOUR_/i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || SUMMARY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(summaryUrlFor(url), { method: 'GET', redirect: 'follow', signal: controller.signal });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    if (!data || !data.ok) return null;
    return sanitizeSummary(data);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** {at, data} or null. Never throws. */
export async function readSummarySnapshot(store) {
  try {
    const v = await store.get(SUMMARY_SNAPSHOT_KEY, { type: 'json' });
    if (v && v.data && Array.isArray(v.data.dates) && Number.isFinite(Number(v.at))) {
      return { at: Number(v.at), data: v.data };
    }
  } catch (err) { /* treat as no snapshot */ }
  return null;
}

/** Best effort. Stores the sanitised aggregates only. Returns true when written. */
export async function writeSummarySnapshot(store, data, now = Date.now) {
  try {
    const clean = sanitizeSummary(data);
    if (!clean) return false;
    await store.setJSON(SUMMARY_SNAPSHOT_KEY, { at: now(), data: clean });
    return true;
  } catch (err) {
    return false;
  }
}

/** Fetch the live summary and store it. Returns the data, or null. */
export async function refreshSummarySnapshot(store, opts = {}) {
  const data = await fetchSummary({ url: opts.url, fetch: opts.fetch, timeoutMs: opts.timeoutMs || SUMMARY_TIMEOUT_MS });
  if (!data) return null;
  await writeSummarySnapshot(store, data, opts.now || Date.now);
  return data;
}

/**
 * Stock for an order check: live (2s cap, 15s memory cache), else a snapshot
 * younger than 5 minutes, else null (the caller then fails open).
 */
export async function stockForOrderCheck(store, opts = {}) {
  const live = await fetchStock({ url: opts.url, fetch: opts.fetch, now: opts.now });
  if (live) return live;
  const snap = await readStockSnapshot(store);
  const now = (opts.now || Date.now)();
  const maxAge = opts.maxAgeMs == null ? STOCK_SNAPSHOT_ORDER_MAX_AGE_MS : opts.maxAgeMs;
  if (snap && now - snap.at >= 0 && now - snap.at < maxAge) return snap.data;
  return null;
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
 * Store the order (idempotent by orderId) and queue it for the Sheet.
 * Returns { status, body } for the HTTP response, plus `record`.
 */
export async function acceptOrder(store, raw, opts = {}) {
  const now = opts.now ? opts.now() : Date.now();
  const v = validateOrder(raw, opts.config || SITE_CONFIG);
  if (!v.ok) return { status: 400, body: { ok: false, error: 'invalid', fields: v.errors } };
  const { order } = v;
  const key = 'order/' + order.orderId;

  const existing = await store.get(key, { type: 'json' });
  if (existing) {
    return {
      status: 200,
      record: existing,
      body: { ok: true, status: 'duplicate', orderId: order.orderId }
    };
  }

  // Stock check for NEW orders only (duplicates answered above). A retry
  // from the page's outbox is flagged (skipStockCheck): the customer was
  // already told "placed", so it is never rejected here (the Sheet flags OVERSOLD).
  if (!v.skipStockCheck && typeof opts.stockCheck === 'function') {
    const short = await opts.stockCheck(order);
    if (short && short.length) {
      return { status: 409, body: { ok: false, error: 'out_of_stock', items: short } };
    }
  }

  const record = {
    order,
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
        body: { ok: true, status: 'duplicate', orderId: order.orderId }
      };
    }
  }
  await store.setJSON('pending/' + order.orderId, { orderId: order.orderId, queuedAt: record.receivedAt });
  // A duplicate request may already have forwarded this order (and cleared
  // its marker) between the two writes above. forwardOrder marks the record
  // sent BEFORE deleting the marker, so if it is sent now, drop the marker
  // we just wrote instead of leaving an orphan behind.
  const fresh = await store.get(key, { type: 'json' });
  if (fresh && fresh.sent) await store.delete('pending/' + order.orderId);
  return {
    status: 200,
    record,
    body: { ok: true, status: 'queued', orderId: order.orderId }
  };
}

export function sheetPayload(record) {
  const payload = Object.assign({}, record.order, { source: 'netlify' });
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
  const blobs = await listPendingBlobs(store);
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

/**
 * Pending markers for real orders only. The Blobs store can briefly list its
 * own in-flight temp files (e.g. 'pending/.abc123'), which aren't orders.
 */
async function listPendingBlobs(store) {
  const { blobs } = await store.list({ prefix: 'pending/' });
  return blobs.filter((b) => ORDER_ID_RE.test(String(b.key).slice('pending/'.length)));
}

export async function countPending(store) {
  return (await listPendingBlobs(store)).length;
}
