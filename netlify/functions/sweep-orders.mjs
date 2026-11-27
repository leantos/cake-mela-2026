/**
 * Scheduled every 5 minutes: re-send any order still marked pending in
 * Netlify Blobs to the Google Sheet. Apps Script dedupes by Order ID, so
 * a repeat send never creates a second row.
 * (Scheduled functions run only on the published production deploy.)
 */
import { getStore } from '@netlify/blobs';
import { STORE_NAME, blobsConsistency, sweepPending, appsScriptUrl, refreshStockSnapshot } from '../lib/orders.mjs';

export default async () => {
  const store = getStore({ name: STORE_NAME, consistency: blobsConsistency() });
  const url = appsScriptUrl({ APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL });
  // Keep the stock snapshot warm (runs alongside the sweep, best effort): a
  // failure here must never slow or fail the order sweep.
  const stockWork = refreshStockSnapshot(store, { url, timeoutMs: 6000 })
    .then((d) => (d ? 'refreshed' : 'unavailable'))
    .catch(() => 'error');
  const [summary, stock] = await Promise.all([sweepPending(store, { url, budgetMs: 25000 }), stockWork]);
  console.log('sweep-orders', JSON.stringify(summary), 'stock-snapshot', stock);
};

export const config = {
  schedule: '*/5 * * * *'
};
