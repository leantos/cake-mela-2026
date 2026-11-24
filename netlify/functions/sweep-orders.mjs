/**
 * Scheduled every 5 minutes: re-send any order still marked pending in
 * Netlify Blobs to the Google Sheet. Apps Script dedupes by Order ID, so
 * a repeat send never creates a second row.
 * (Scheduled functions run only on the published production deploy.)
 */
import { getStore } from '@netlify/blobs';
import { STORE_NAME, blobsConsistency, sweepPending, appsScriptUrl } from '../lib/orders.mjs';

export default async () => {
  const store = getStore({ name: STORE_NAME, consistency: blobsConsistency() });
  const url = appsScriptUrl({ APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL });
  const summary = await sweepPending(store, { url, budgetMs: 25000 });
  console.log('sweep-orders', JSON.stringify(summary));
};

export const config = {
  schedule: '*/5 * * * *'
};
