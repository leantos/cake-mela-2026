/**
 * GET /api/stock — the Apps Script ?action=stock payload, served through
 * Netlify's CDN so customers get it instantly instead of waiting 2-4s on
 * Google. The CDN keeps it for 10s and may serve a stale copy for up to
 * 120s while it refreshes in the background.
 *
 *   /api/stock            CDN-cached (stale-while-revalidate)
 *   /api/stock?fresh=1    never cached; used right before an order is placed
 *
 * On any failure: 502 {ok:false}, never cached. The page then falls back to
 * asking Apps Script directly, and ordering is never blocked by stock.
 */
import { appsScriptUrl, fetchStock } from '../lib/orders.mjs';

const STOCK_TIMEOUT_MS = 4000;
const FRESH_TTL_MS = 2000;
const SHARED_TTL_MS = 8000;

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json(405, { ok: false, error: 'GET only' }, { 'Cache-Control': 'no-store' });
  const fresh = new URL(req.url).searchParams.has('fresh');
  const url = appsScriptUrl({ APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL });
  const data = await fetchStock({
    url,
    timeoutMs: STOCK_TIMEOUT_MS,
    ttlMs: fresh ? FRESH_TTL_MS : SHARED_TTL_MS
  });
  if (!data) return json(502, { ok: false, error: 'stock unavailable' }, { 'Cache-Control': 'no-store' });
  if (fresh) return json(200, data, { 'Cache-Control': 'no-store' });
  return json(200, data, {
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=10, stale-while-revalidate=120'
  });
};

export const config = {
  path: '/api/stock'
};
