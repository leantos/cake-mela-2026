/**
 * GET /api/stock — the Apps Script ?action=stock payload, served from a
 * durable snapshot in Netlify Blobs so the order page never waits on Google
 * (Apps Script can take 2-10s on a cold start).
 *
 *   /api/stock            the snapshot, INSTANTLY. Headers: X-Stock-Age
 *                         (seconds) and X-Stock-Stale: 1 when older than 10s,
 *                         in which case a refresh runs in the background so
 *                         the next caller gets fresh numbers. Only when no
 *                         snapshot exists yet does it fetch live (and store it).
 *   /api/stock?fresh=1    waits for the live fetch (4s cap), never cached; used
 *                         right before an order. If Apps Script doesn't answer
 *                         it serves the snapshot with X-Stock-Fallback: 1.
 *
 * The 5-minute sweep-orders function also refreshes the snapshot, so it stays
 * warm. On total failure: 502 {ok:false}, never cached.
 */
import { getStore } from '@netlify/blobs';
import {
  STORE_NAME, STOCK_STALE_MS, blobsConsistency, appsScriptUrl,
  readStockSnapshot, writeStockSnapshot, refreshStockSnapshot, fetchStock
} from '../lib/orders.mjs';

const STOCK_TIMEOUT_MS = 4000;
const FRESH_TTL_MS = 2000;

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)
  });
}

const NO_STORE = { 'Cache-Control': 'no-store' };
const CDN_HEADERS = {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=10, stale-while-revalidate=120'
};

// One background refresh at a time per running instance.
let refreshInFlight = null;
function kickRefresh(store, url, context) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshStockSnapshot(store, { url, timeoutMs: STOCK_TIMEOUT_MS })
    .catch(() => null)
    .finally(() => { refreshInFlight = null; });
  if (context && typeof context.waitUntil === 'function') context.waitUntil(refreshInFlight);
  return refreshInFlight;
}

export default async (req, context) => {
  if (req.method !== 'GET') return json(405, { ok: false, error: 'GET only' }, NO_STORE);
  const fresh = new URL(req.url).searchParams.has('fresh');
  const url = appsScriptUrl({ APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL });
  const store = getStore({ name: STORE_NAME, consistency: blobsConsistency() });
  const snap = await readStockSnapshot(store);
  const ageSeconds = (s) => String(Math.max(0, Math.round((Date.now() - s.at) / 1000)));

  if (fresh) {
    const live = await fetchStock({ url, timeoutMs: STOCK_TIMEOUT_MS, ttlMs: FRESH_TTL_MS });
    if (live) {
      const work = writeStockSnapshot(store, live);
      if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
      else await work;
      return json(200, live, Object.assign({ 'X-Stock-Age': '0' }, NO_STORE));
    }
    if (snap) {
      return json(200, snap.data, Object.assign({ 'X-Stock-Age': ageSeconds(snap), 'X-Stock-Fallback': '1' }, NO_STORE));
    }
    return json(502, { ok: false, error: 'stock unavailable' }, NO_STORE);
  }

  if (snap) {
    const stale = Date.now() - snap.at > STOCK_STALE_MS;
    const headers = Object.assign({ 'X-Stock-Age': ageSeconds(snap) }, CDN_HEADERS);
    if (stale) {
      headers['X-Stock-Stale'] = '1';
      kickRefresh(store, url, context);
    }
    return json(200, snap.data, headers);
  }

  // First ever call: nothing stored yet, so fetch live and keep the result.
  const live = await fetchStock({ url, timeoutMs: STOCK_TIMEOUT_MS, ttlMs: FRESH_TTL_MS });
  if (!live) return json(502, { ok: false, error: 'stock unavailable' }, NO_STORE);
  const work = writeStockSnapshot(store, live);
  if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
  else await work;
  return json(200, live, Object.assign({ 'X-Stock-Age': '0' }, CDN_HEADERS));
};

export const config = {
  path: '/api/stock'
};
