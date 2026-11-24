/**
 * Netlify function tests against a real local Blobs server
 * (@netlify/blobs/server) and a mock Apps Script endpoint on localhost.
 * Never touches the live Apps Script URL.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BlobsServer } from '@netlify/blobs/server';
import { getStore } from '@netlify/blobs';

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

// ---- local Blobs server ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-'));
const token = 'test-token';
const blobs = new BlobsServer({ directory: dir, port: 0, token });
const { port: blobsPort } = await blobs.start();
const edge = 'http://localhost:' + blobsPort;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
  edgeURL: edge, uncachedEdgeURL: edge, siteID: 'test-site', token
})).toString('base64');

// ---- mock Apps Script: dedupes by orderId like Code.gs ----
const sheetRows = new Map();
let sheetMode = 'ok'; // ok | fail | invalid_date
const sheetHits = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const data = JSON.parse(body || '{}');
    sheetHits.push(data);
    res.setHeader('Content-Type', 'application/json');
    if (sheetMode === 'fail') { res.statusCode = 500; return res.end('{"ok":false}'); }
    if (sheetMode === 'invalid_date' && !data.fallback) {
      return res.end(JSON.stringify({ ok: false, status: 'invalid_date', orderId: data.orderId }));
    }
    if (sheetRows.has(data.orderId)) return res.end(JSON.stringify({ ok: true, status: 'duplicate', orderId: data.orderId }));
    sheetRows.set(data.orderId, data);
    res.end(JSON.stringify({ ok: true, status: 'saved', orderId: data.orderId }));
  });
});
await new Promise((r) => mock.listen(0, r));
const mockUrl = 'http://localhost:' + mock.address().port + '/exec';
process.env.APPS_SCRIPT_URL = mockUrl;

const lib = await import('../netlify/lib/orders.mjs');
const { default: orderFn, config: orderCfg } = await import('../netlify/functions/order.mjs');
const { default: sweepFn, config: sweepCfg } = await import('../netlify/functions/sweep-orders.mjs');
const store = getStore({ name: lib.STORE_NAME, consistency: 'strong' });


function makeAtomicStore() {
  const map = new Map();
  let ver = 0;
  const lag = () => new Promise((r) => setTimeout(r, Math.random() * 15));
  return {
    async get(key) { await lag(); const e = map.get(key); return e ? JSON.parse(e.v) : null; },
    async getWithMetadata(key) { await lag(); const e = map.get(key); return e ? { data: JSON.parse(e.v), etag: e.etag, metadata: {} } : null; },
    async setJSON(key, value, opts = {}) {
      await lag();
      const e = map.get(key);
      if (opts.onlyIfNew && e) return { modified: false };
      if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = '"' + (++ver) + '"';
      map.set(key, { v: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    async delete(key) { await lag(); map.delete(key); },
    async list({ prefix = '' } = {}) { await lag(); return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] }; }
  };
}

let n = 0;
function order(over = {}) {
  n++;
  return Object.assign({
    timestamp: '23/11/2026, 09:00:00 pm IST',
    orderId: 'PB-261123-T' + String(n).padStart(3, '0'),
    name: 'Asha Rao',
    phone: '9876543210',
    pickupDate: '2026-11-29',
    pickupDateLabel: 'Sun, 29 Nov',
    pickupDateShort: 'Sun, 29 Nov',
    mass: '06:30',
    massLabel: '6:30 AM Mass',
    items: [{ id: 'rich-plum-cake-400', name: 'Rich Plum Cake (400g)', qty: 2, price: 350, lineTotal: 700 }],
    totalItems: 2,
    totalAmount: 700
  }, over);
}

async function call(body, method = 'POST') {
  const pending = [];
  const req = new Request('http://localhost/api/order', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  const t = Date.now();
  const res = await orderFn(req, { waitUntil: (p) => pending.push(p) });
  const ms = Date.now() - t;
  const json = await res.json();
  return { status: res.status, json, ms, settle: () => Promise.all(pending) };
}

assert('config: function path is /api/order', orderCfg.path === '/api/order');
assert('config: sweep is scheduled every 5 minutes', sweepCfg.schedule === '*/5 * * * *');

// ---- validation ----
{
  const r1 = await call('not json');
  assert('rejects invalid JSON with 400', r1.status === 400);
  const r2 = await call(order({ phone: '12345' }));
  assert('rejects a bad phone with 400', r2.status === 400 && r2.json.fields.includes('phone'), JSON.stringify(r2.json));
  const r3 = await call(order({ items: [] }));
  assert('rejects an empty cart', r3.status === 400 && r3.json.fields.includes('items'));
  const r4 = await call(order({ totalAmount: 1 }));
  assert('rejects totals that do not add up', r4.status === 400 && r4.json.fields.includes('totalAmount'));
  const r5 = await call(order({ orderId: 'hello' }));
  assert('rejects a malformed orderId', r5.status === 400 && r5.json.fields.includes('orderId'));
  const r6 = await call(null, 'PUT');
  assert('only POST/GET allowed', r6.status === 405);
}

// ---- alternate contacts + fast reply + background forward ----
const placed = [];
for (let i = 0; i < 4; i++) {
  const o = order();
  const r = await call(o);
  placed.push({ o, r });
}
assert('accepts valid orders with ok + orderId + contact',
  placed.every(({ o, r }) => r.status === 200 && r.json.ok && r.json.orderId === o.orderId && r.json.contact && r.json.contact.number));
assert('alternates Cyril, Aashwin, Cyril, Aashwin',
  placed.map(({ r }) => r.json.contact.id).join(',') === 'cyril,aashwin,cyril,aashwin',
  placed.map(({ r }) => r.json.contact.id).join(','));
assert('responds fast (before the Sheet write)', placed.every(({ r }) => r.ms < 1500), placed.map(({ r }) => r.ms).join(','));
await Promise.all(placed.map(({ r }) => r.settle()));
assert('background forward wrote every order to the (mock) Sheet', placed.every(({ o }) => sheetRows.has(o.orderId)));
const firstRow = sheetRows.get(placed[1].o.orderId);
assert('Sheet payload carries assignedTo name', firstRow && firstRow.assignedTo === 'Aashwin Alfy' && firstRow.assignedNumber === '+91 80507 64341',
  JSON.stringify(firstRow));
const rec0 = await store.get('order/' + placed[0].o.orderId, { type: 'json' });
assert('Blobs record marked sent', rec0 && rec0.sent === true && rec0.sheetStatus === 'saved', JSON.stringify(rec0));
assert('pending marker removed after success', (await lib.countPending(store)) === 0);

// ---- idempotency ----
{
  const again = await call(placed[1].o);
  assert('resubmitting the same orderId returns the same contact', again.json.status === 'duplicate' && again.json.contact.id === 'aashwin', JSON.stringify(again.json));
  await again.settle();
  const next = await call(order());
  assert('a duplicate does not advance the alternation', next.json.contact.id === 'cyril', next.json.contact.id);
  await next.settle();
}

// ---- concurrency ----
// The local BlobsServer checks If-Match and then writes with an await in
// between, so it is not atomic under a burst. Netlify's hosted Blobs
// applies conditional writes atomically; model that with an in-memory
// store that has the same API and random latency.
{
  const fake = makeAtomicStore();
  const burst = await Promise.all(Array.from({ length: 10 }, () => lib.acceptOrder(fake, order())));
  const ids = burst.map((r) => r.body.contact.id);
  const c = ids.filter((x) => x === 'cyril').length;
  assert('10 simultaneous orders split 5/5 (atomic conditional writes)', c === 5, ids.join(','));
  const counter = await fake.get('meta/counter', { type: 'json' });
  assert('counter advanced exactly 10 times', counter.next === 10, JSON.stringify(counter));
  const same = order();
  const twins = await Promise.all([call(same), call(same), call(same)]);
  assert('simultaneous resubmits of one order all get one contact',
    new Set(twins.map((r) => r.json.contact.id)).size === 1, twins.map((r) => r.json.contact.id).join(','));
  await Promise.all(twins.map((r) => r.settle()));
  const rows = [...sheetRows.keys()].filter((k) => k === same.orderId).length;
  assert('…and only one Sheet row', rows === 1);
}

// ---- client fallback hint keeps its contact ----
{
  const r = await call(order({ assignedContactId: 'aashwin' }));
  const r2 = await call(order({ assignedContactId: 'aashwin' }));
  assert('assignedContactId hint from the page is honoured', r.json.contact.id === 'aashwin' && r2.json.contact.id === 'aashwin');
  await Promise.all([r.settle(), r2.settle()]);
}

// ---- Sheet down: retry via sweep ----
{
  sheetMode = 'fail';
  const o = order();
  const r = await call(o);
  assert('order still accepted while the Sheet is down', r.status === 200 && r.json.ok);
  await r.settle();
  let rec = await store.get('order/' + o.orderId, { type: 'json' });
  assert('failed forward is recorded with a retry time', rec.sent === false && rec.attempts === 1 && rec.nextAttemptAt > Date.now(), JSON.stringify(rec));
  assert('pending count shows it', (await lib.countPending(store)) === 1);
  const g = await call(null, 'GET');
  assert('GET /api/order reports the pending count only', g.json.ok && g.json.pending === 1 && Object.keys(g.json).length === 2, JSON.stringify(g.json));

  const early = await lib.sweepPending(store, { url: mockUrl });
  assert('sweep respects backoff', early.skipped === 1 && early.tried === 0, JSON.stringify(early));
  sheetMode = 'ok';
  const later = await lib.sweepPending(store, { url: mockUrl, now: () => Date.now() + 10 * 60 * 1000 });
  assert('sweep re-sends once the backoff passes', later.sent === 1, JSON.stringify(later));
  rec = await store.get('order/' + o.orderId, { type: 'json' });
  assert('record marked sent after sweep', rec.sent === true && sheetRows.has(o.orderId));

  // scheduled handler itself runs cleanly
  sheetMode = 'fail';
  const o2 = order();
  const r2 = await call(o2); await r2.settle();
  sheetMode = 'ok';
  await store.setJSON('order/' + o2.orderId, Object.assign(await store.get('order/' + o2.orderId, { type: 'json' }), { nextAttemptAt: 0 }));
  await sweepFn();
  assert('scheduled sweep-orders function sends due orders', sheetRows.has(o2.orderId) && (await lib.countPending(store)) === 0);
}

// ---- invalid_date from Apps Script → resend with fallback so the order isn't lost ----
{
  sheetMode = 'invalid_date';
  const o = order({ pickupDate: '2026-12-27' });
  const r = await call(o); await r.settle();
  const row = sheetRows.get(o.orderId);
  assert('invalid_date is re-sent with fallback:true and saved', row && row.fallback === true, JSON.stringify(row));
  sheetMode = 'ok';
}

// ---- backoff ----
assert('backoff 1,2,4..30 min', lib.backoffMs(1) === 60000 && lib.backoffMs(3) === 240000 && lib.backoffMs(20) === 1800000);

mock.close();
await blobs.stop();
fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log('\n--- functions ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
process.exit(failed.length ? 1 : 0);
