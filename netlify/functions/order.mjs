/**
 * POST /api/order  — save the order to Netlify Blobs, answer immediately
 * ({ok, status, orderId}), then push it to the Google
 * Sheet in the background (context.waitUntil). Anything that fails is
 * retried by sweep-orders.mjs every 5 minutes.
 *
 * GET /api/order   — tiny health check: { ok, pending } (no personal data).
 */
import { getStore } from '@netlify/blobs';
import {
  STORE_NAME, blobsConsistency, acceptOrder, forwardOrder, countPending, appsScriptUrl,
  stockForOrderCheck, stockShortfalls, noteOrderInStockCache
} from '../lib/orders.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default async (req, context) => {
  const store = getStore({ name: STORE_NAME, consistency: blobsConsistency() });

  if (req.method === 'GET') {
    try {
      return reply(200, { ok: true, pending: await countPending(store) });
    } catch (err) {
      return reply(500, { ok: false, error: 'store unavailable' });
    }
  }
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let raw;
  try {
    const text = await req.text();
    if (text.length > 20000) return reply(413, { ok: false, error: 'too large' });
    raw = JSON.parse(text);
  } catch (err) {
    return reply(400, { ok: false, error: 'invalid JSON' });
  }

  let result;
  try {
    // Fails open: if the stock can't be read, the order is accepted.
    const url = appsScriptUrl({ APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL });
    result = await acceptOrder(store, raw, {
      // Live stock, else a snapshot under 5 minutes old, else fail open.
      stockCheck: async (order) => stockShortfalls(order, await stockForOrderCheck(store, { url }))
    });
    if (result.status === 200 && result.body.status === 'queued' && result.record) {
      noteOrderInStockCache(result.record.order);
    }
  } catch (err) {
    console.error('acceptOrder failed', err);
    // 503 tells the page to use its own fallback (direct to the Sheet).
    return reply(503, { ok: false, error: 'store unavailable' });
  }

  if (result.status === 200 && result.record && !result.record.sent) {
    const env = { APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL };
    const work = forwardOrder(store, result.body.orderId, { url: appsScriptUrl(env) })
      .then((r) => console.log('forward', result.body.orderId, JSON.stringify(r)))
      .catch((err) => console.error('forward failed', result.body.orderId, err));
    if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
  }
  return reply(result.status, result.body);
};

export const config = {
  path: '/api/order'
};
