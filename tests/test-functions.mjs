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
let stockMode = 'ok'; // ok | fail | slow
let stockDates = []; // [{id, label, closesAt, remaining}]
let stockGets = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET') {
      stockGets++;
      res.setHeader('Content-Type', 'application/json');
      if (stockMode === 'fail') { res.statusCode = 500; return res.end('{"ok":false}'); }
      const payload = JSON.stringify({ ok: true, version: 'test', dates: stockDates });
      if (stockMode === 'slow') return setTimeout(() => res.end(payload), 3500);
      return res.end(payload);
    }
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
const { default: stockFn, config: stockCfg } = await import('../netlify/functions/stock.mjs');
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

// ---- Mass time is no longer collected ----
{
  const noMass = lib.validateOrder(order());
  assert('an order without any Mass fields validates', noMass.ok === true, JSON.stringify(noMass));
  const legacy = lib.validateOrder(order({ mass: '06:30', massLabel: '6:30 AM Mass' }));
  assert('a legacy order that still sends Mass (old cached page / outbox) is accepted', legacy.ok === true, JSON.stringify(legacy));
  assert('legacy Mass is dropped from the stored order and the Sheet payload',
    !('mass' in legacy.order) && !('massLabel' in legacy.order) &&
    !('mass' in lib.sheetPayload({ order: legacy.order })), JSON.stringify(legacy.order));
  const badMass = lib.validateOrder(order({ mass: 'garbage' }));
  assert('a bogus legacy Mass value no longer rejects the order', badMass.ok === true, JSON.stringify(badMass));
}

// ---- no contact assignment: fast reply + background forward ----
const placed = [];
for (let i = 0; i < 4; i++) {
  const o = order();
  const r = await call(o);
  placed.push({ o, r });
}
assert('accepts valid orders with ok + status + orderId and no contact',
  placed.every(({ o, r }) => r.status === 200 && r.json.ok && r.json.status === 'queued' && r.json.orderId === o.orderId && !('contact' in r.json)),
  JSON.stringify(placed.map(({ r }) => r.json)));
assert('the response is exactly {ok, status, orderId}',
  placed.every(({ r }) => Object.keys(r.json).sort().join(',') === 'ok,orderId,status'), JSON.stringify(placed[0].r.json));
assert('responds fast (before the Sheet write)', placed.every(({ r }) => r.ms < 1500), placed.map(({ r }) => r.ms).join(','));
await Promise.all(placed.map(({ r }) => r.settle()));
assert('background forward wrote every order to the (mock) Sheet', placed.every(({ o }) => sheetRows.has(o.orderId)));
const firstRow = sheetRows.get(placed[1].o.orderId);
assert('Sheet payload has no assignedTo / assignedContactId / assignedNumber and keeps source',
  firstRow && !('assignedTo' in firstRow) && firstRow.source === 'netlify', JSON.stringify(firstRow));
const rec0 = await store.get('order/' + placed[0].o.orderId, { type: 'json' });
assert('Blobs record marked sent', rec0 && rec0.sent === true && rec0.sheetStatus === 'saved', JSON.stringify(rec0));
assert('Blobs record carries no contact', rec0 && !('contact' in rec0), JSON.stringify(rec0));
assert('no round-robin counter blob is ever written', (await store.get('meta/counter', { type: 'json' })) == null);
assert('pending marker removed after success', (await lib.countPending(store)) === 0);
assert('the contact/alternation helpers are gone',
  typeof lib.nextContactIndex === 'undefined' && typeof lib.findContact === 'undefined' && typeof lib.publicContact === 'undefined');

// ---- idempotency ----
{
  const again = await call(placed[1].o);
  assert('resubmitting the same orderId answers duplicate with no contact',
    again.json.status === 'duplicate' && !('contact' in again.json) && again.json.orderId === placed[1].o.orderId, JSON.stringify(again.json));
  await again.settle();
}

// ---- concurrency ----
{
  const fake = makeAtomicStore();
  const burst = await Promise.all(Array.from({ length: 10 }, () => lib.acceptOrder(fake, order())));
  assert('10 simultaneous orders are all queued without a contact',
    burst.every((r) => r.status === 200 && r.body.status === 'queued' && !('contact' in r.body)), JSON.stringify(burst.map((r) => r.body)));
  assert('and no counter is written', (await fake.get('meta/counter', { type: 'json' })) == null);
  const same = order();
  const twins = await Promise.all([call(same), call(same), call(same)]);
  assert('simultaneous resubmits of one order all succeed',
    twins.every((r) => r.status === 200 && r.json.ok && r.json.orderId === same.orderId), JSON.stringify(twins.map((r) => r.json)));
  await Promise.all(twins.map((r) => r.settle()));
  const rows = [...sheetRows.keys()].filter((k) => k === same.orderId).length;
  assert('…and only one Sheet row', rows === 1);
}

// ---- legacy clients still send assignedContactId ----
{
  const legacy = lib.validateOrder(order({ assignedContactId: 'aashwin', assignedTo: 'Aashwin Alfy' }));
  assert('an old page that still sends assignedContactId is accepted and the field is dropped',
    legacy.ok === true && !('assignedContactId' in legacy.order) && !('assignedTo' in legacy.order), JSON.stringify(legacy));
  const r = await call(order({ assignedContactId: 'aashwin' }));
  const r2 = await call(order({ assignedContactId: 'aashwin' }));
  assert('legacy contact hint is accepted with no contact in the reply',
    r.status === 200 && r2.status === 200 && !('contact' in r.json) && !('contact' in r2.json), JSON.stringify([r.json, r2.json]));
  await Promise.all([r.settle(), r2.settle()]);
  const row = sheetRows.get(r.json.orderId);
  assert('and the Sheet never receives the legacy contact fields', row && !('assignedTo' in row), JSON.stringify(row));
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
  const pendingNow = (await store.list({ prefix: 'pending/' })).blobs.map((b) => b.key);
  const pendingDetail = JSON.stringify(await Promise.all(pendingNow.map(async (k) => ({ k, rec: await store.get('order/' + k.slice(8), { type: 'json' }) }))));
  assert('pending count shows it', (await lib.countPending(store)) === 1, pendingDetail);
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

// ---- race: a duplicate forwards the order between the record and marker writes ----
{
  sheetMode = 'ok';
  const o = order();
  let raced = false;
  const racing = new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (prop === 'setJSON') {
        return async (key, ...rest) => {
          if (!raced && String(key).startsWith('pending/')) {
            raced = true;
            await lib.forwardOrder(target, String(key).slice('pending/'.length), { url: mockUrl });
          }
          return v.call(target, key, ...rest);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const res = await lib.acceptOrder(racing, o);
  assert('race: order accepted', res.status === 200 && res.body.ok && raced);
  assert('race: no orphan pending marker is left for an already-sent order',
    (await lib.countPending(store)) === 0 && sheetRows.has(o.orderId), String(await lib.countPending(store)));
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

// ---- stock limits ----
{
  const PLUM = 'Rich Plum Cake (400g)';
  const setStock = (remaining, date = '2026-11-29') => {
    stockDates = [{ id: date, label: 'Sun', closesAt: date + 'T08:30:00+05:30', remaining }];
    lib.resetStockCache();
  };
  const plum = (qty) => order({
    items: [{ id: 'rich-plum-cake-400', name: PLUM, qty, price: 350, lineTotal: qty * 350 }],
    totalItems: qty, totalAmount: qty * 350
  });

  // the 11th buyer: 10 left, order of 11 is rejected and not stored
  setStock({ [PLUM]: 10 });
  const tenOk = plum(10);
  const rOk = await call(tenOk); await rOk.settle();
  assert('stock: ordering exactly what is left is accepted', rOk.status === 200 && rOk.json.ok === true, JSON.stringify(rOk.json));

  setStock({ [PLUM]: 0 });
  const hitsBefore = sheetHits.length;
  const over = plum(1);
  const rOver = await call(over); await rOver.settle();
  assert('stock: sold-out item gets 409 out_of_stock with the item name',
    rOver.status === 409 && rOver.json.ok === false && rOver.json.error === 'out_of_stock' && rOver.json.items.join() === PLUM,
    JSON.stringify(rOver));
  assert('stock: rejected order is not stored or forwarded',
    (await store.get('order/' + over.orderId, { type: 'json' })) === null && sheetHits.length === hitsBefore && !sheetRows.has(over.orderId));

  setStock({ [PLUM]: 3 });
  const r4 = await call(plum(4)); await r4.settle();
  assert('stock: more than remaining is rejected', r4.status === 409, JSON.stringify(r4.json));

  // null / missing = unlimited; other dates unlimited
  setStock({ [PLUM]: null });
  const rNull = await call(plum(50)); await rNull.settle();
  assert('stock: null remaining is unlimited', rNull.status === 200, JSON.stringify(rNull.json));
  setStock({});
  const rMissing = await call(plum(50)); await rMissing.settle();
  assert('stock: item missing from remaining is unlimited', rMissing.status === 200);
  setStock({ [PLUM]: 0 }, '2026-12-06');
  const rOther = await call(plum(5)); await rOther.settle();
  assert('stock: a date with no limit entry is unlimited', rOther.status === 200);

  // a burst inside the cache window sees the accepted orders
  setStock({ [PLUM]: 3 });
  const a = await call(plum(2)); await a.settle();
  const b = await call(plum(2)); await b.settle();
  assert('stock: accepted orders use up the cached remaining', a.status === 200 && b.status === 409, a.status + '/' + b.status);

  // duplicates of an already-stored order still return the stored result, even if now sold out
  setStock({ [PLUM]: 5 });
  const dup = plum(2);
  const d1 = await call(dup); await d1.settle();
  setStock({ [PLUM]: 0 });
  const d2 = await call(dup);
  assert('stock: duplicate orderId returns the stored result, not 409',
    d1.status === 200 && d2.status === 200 && d2.json.status === 'duplicate' && !('contact' in d2.json), JSON.stringify(d2.json));

  // retry from the page's outbox (retry flag or legacy contact hint) was already promised: never rejected
  setStock({ [PLUM]: 0 });
  const hinted = plum(2); hinted.assignedContactId = 'aashwin';
  const rh = await call(hinted); await rh.settle();
  assert('stock: outbox retry with a legacy contact hint is accepted', rh.status === 200 && rh.json.ok && !('contact' in rh.json), JSON.stringify(rh.json));
  setStock({ [PLUM]: 0 });
  const flagged = plum(2); flagged.retry = true;
  const rf2 = await call(flagged); await rf2.settle();
  assert('stock: outbox retry flagged retry:true is accepted', rf2.status === 200 && rf2.json.ok, JSON.stringify(rf2.json));
  setStock({ [PLUM]: 0 });
  const fb = plum(2); fb.fallback = true;
  const rfb = await call(fb); await rfb.settle();
  assert('stock: a fallback:true order is accepted', rfb.status === 200 && rfb.json.ok, JSON.stringify(rfb.json));

  // fail open
  setStock({ [PLUM]: 0 });
  stockMode = 'fail'; lib.resetStockCache();
  const rf = await call(plum(2)); await rf.settle();
  assert('stock: fails open when Apps Script stock returns 500', rf.status === 200, JSON.stringify(rf.json));
  stockMode = 'slow'; lib.resetStockCache();
  const t0 = Date.now();
  const rs = await call(plum(2)); await rs.settle();
  assert('stock: fails open on a slow stock fetch (~2s timeout)', rs.status === 200 && Date.now() - t0 < 3400, rs.status + ' ' + (Date.now() - t0) + 'ms');
  stockMode = 'ok'; lib.resetStockCache();

  // cache: a second order inside the TTL does not refetch
  setStock({});
  const g0 = stockGets;
  const c1 = await call(plum(1)); await c1.settle();
  const c2 = await call(plum(1)); await c2.settle();
  assert('stock: fetched once per cache window', stockGets - g0 === 1, String(stockGets - g0));

  assert('stockShortfalls sums repeated lines',
    lib.stockShortfalls({ pickupDate: '2026-11-29', items: [{ name: PLUM, qty: 2 }, { name: PLUM, qty: 2 }] },
      { dates: [{ id: '2026-11-29', remaining: { [PLUM]: 3 } }] }).join() === PLUM);
  stockDates = [];
  lib.resetStockCache();
}

// ---- /api/stock (CDN-cached stock for the order page) ----
{
  const getStockApi = (qs = '', method = 'GET') => stockFn(new Request('http://localhost/api/stock' + qs, { method }));
  assert('config: stock function path is /api/stock', stockCfg.path === '/api/stock');

  stockDates = [{ id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30', remaining: { 'Rich Plum Cake (400g)': 0, 'Rich Plum Cake (800g)': null } }];
  stockMode = 'ok'; lib.resetStockCache();
  const s1 = await getStockApi();
  const b1 = await s1.json();
  assert('stock api: 200 with the Apps Script payload', s1.status === 200 && b1.ok && b1.dates[0].remaining['Rich Plum Cake (400g)'] === 0 && b1.dates[0].remaining['Rich Plum Cake (800g)'] === null, JSON.stringify(b1));
  assert('stock api: CDN caches 10s and serves stale while revalidating',
    /s-maxage=10/.test(s1.headers.get('netlify-cdn-cache-control') || '') && /stale-while-revalidate=120/.test(s1.headers.get('netlify-cdn-cache-control') || ''), s1.headers.get('netlify-cdn-cache-control'));
  assert('stock api: browser always revalidates', /max-age=0/.test(s1.headers.get('cache-control') || '') && /must-revalidate/.test(s1.headers.get('cache-control') || ''), s1.headers.get('cache-control'));

  const g0 = stockGets;
  await getStockApi();
  assert('stock api: repeat calls are served from the in-memory cache', stockGets === g0, String(stockGets - g0));

  stockDates[0].remaining['Rich Plum Cake (400g)'] = 7;
  await new Promise((r) => setTimeout(r, 2100));
  const s2 = await getStockApi('?fresh=1&t=1');
  const b2 = await s2.json();
  assert('stock api: ?fresh=1 re-reads Apps Script and is never cached',
    b2.dates[0].remaining['Rich Plum Cake (400g)'] === 7 && /no-store/.test(s2.headers.get('cache-control') || '') && !s2.headers.get('netlify-cdn-cache-control'),
    JSON.stringify(b2) + ' ' + s2.headers.get('cache-control'));

  stockMode = 'fail'; lib.resetStockCache();
  const s3 = await getStockApi();
  const b3 = await s3.json();
  assert('stock api: 502 {ok:false} and no-store when Apps Script fails', s3.status === 502 && b3.ok === false && /no-store/.test(s3.headers.get('cache-control') || '') && !s3.headers.get('netlify-cdn-cache-control'), s3.status + ' ' + JSON.stringify(b3));

  const s4 = await getStockApi('', 'POST');
  assert('stock api: POST is 405', s4.status === 405);

  stockMode = 'ok'; stockDates = []; lib.resetStockCache();
}

// ---- backoff ----
assert('backoff 1,2,4..30 min', lib.backoffMs(1) === 60000 && lib.backoffMs(3) === 240000 && lib.backoffMs(20) === 1800000);

mock.close();
await blobs.stop();
fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log('\n--- functions ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
process.exit(failed.length ? 1 : 0);
