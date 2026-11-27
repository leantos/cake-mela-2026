/**
 * GET /api/summary — the Apps Script ?action=summary payload (aggregates only:
 * cakes, amounts and counts per date, never names or phone numbers), served
 * from a durable snapshot in Netlify Blobs so /orders never waits on Google.
 *
 *   /api/summary           the snapshot, INSTANTLY. Headers: X-Summary-Age
 *                          (seconds) and X-Summary-Stale: 1 when older than 20s,
 *                          in which case a refresh runs in the background.
 *                          Only the very first call (no snapshot yet) waits for
 *                          the live fetch and stores it.
 *   /api/summary?fresh=1   waits up to ~6s for live numbers (never cached); if
 *                          Apps Script doesn't answer it serves the snapshot with
 *                          X-Summary-Fallback: 1.
 *
 * sweep-orders also refreshes the snapshot every 5 minutes. On total failure:
 * 502 {ok:false}, never cached.
 */
import { getStore } from '@netlify/blobs';
import {
  STORE_NAME, SUMMARY_STALE_MS, blobsConsistency, appsScriptUrl,
  readSummarySnapshot, writeSummarySnapshot, refreshSummarySnapshot, fetchSummary
} from '../lib/orders.mjs';

const BACKGROUND_TIMEOUT_MS = 5000;
const FRESH_TIMEOUT_MS = 6000;

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
  refreshInFlight = refreshSummarySnapshot(store, { url, timeoutMs: BACKGROUND_TIMEOUT_MS })
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
  const snap = await readSummarySnapshot(store);
  const ageSeconds = (s) => String(Math.max(0, Math.round((Date.now() - s.at) / 1000)));

  if (fresh) {
    const live = await fetchSummary({ url, timeoutMs: FRESH_TIMEOUT_MS });
    if (live) {
      const work = writeSummarySnapshot(store, live);
      if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
      else await work;
      return json(200, live, Object.assign({ 'X-Summary-Age': '0' }, NO_STORE));
    }
    if (snap) {
      return json(200, snap.data, Object.assign({ 'X-Summary-Age': ageSeconds(snap), 'X-Summary-Fallback': '1' }, NO_STORE));
    }
    return json(502, { ok: false, error: 'summary unavailable' }, NO_STORE);
  }

  if (snap) {
    const stale = Date.now() - snap.at > SUMMARY_STALE_MS;
    const headers = Object.assign({ 'X-Summary-Age': ageSeconds(snap) }, CDN_HEADERS);
    if (stale) {
      headers['X-Summary-Stale'] = '1';
      kickRefresh(store, url, context);
    }
    return json(200, snap.data, headers);
  }

  // First ever call: nothing stored yet, so fetch live and keep the result.
  const live = await fetchSummary({ url, timeoutMs: FRESH_TIMEOUT_MS });
  if (!live) return json(502, { ok: false, error: 'summary unavailable' }, NO_STORE);
  const work = writeSummarySnapshot(store, live);
  if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
  else await work;
  return json(200, live, Object.assign({ 'X-Summary-Age': '0' }, CDN_HEADERS));
};

export const config = {
  path: '/api/summary'
};
