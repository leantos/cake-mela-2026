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
let stockMode = 'ok'; // ok | fail | slow (3.5s) | hang (4.8s, past the 4s cap)
let stockDates = []; // [{id, label, closesAt, remaining}]
let stockGets = 0;
let summaryMode = 'ok'; // ok | fail | slow (3.5s) | hang (7s, past the 6s cap)
let summaryTotal = 5; // grand.cakes in the payload
let summaryGets = 0;
let summaryExtra = null; // extra (private) keys a misbehaving backend might send
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && /action=summary/.test(req.url || '')) {
      summaryGets++;
      res.setHeader('Content-Type', 'application/json');
      if (summaryMode === 'fail') { res.statusCode = 500; return res.end('{"ok":false}'); }
      const payload = JSON.stringify(Object.assign({
        ok: true, version: 'test', lastUpdated: 'now', latestOrderAt: '',
        dates: [{ id: '2026-11-29', label: 'Sun, 29 Nov', items: {}, totals: { cakes: summaryTotal, amount: summaryTotal * 320, orders: 1 }, sales: {}, pending: { orders: 1, cakes: summaryTotal, amount: summaryTotal * 320 } }],
        grand: { cakes: summaryTotal, amount: summaryTotal * 320, orders: 1, items: {}, sales: {}, pending: { orders: 1, cakes: summaryTotal, amount: summaryTotal * 320 } }
      }, summaryExtra || {}));
      if (summaryMode === 'slow') return setTimeout(() => res.end(payload), 3500);
      if (summaryMode === 'hang') return setTimeout(() => res.end(payload), 7000);
      return res.end(payload);
    }
    if (req.method === 'GET') {
      stockGets++;
      res.setHeader('Content-Type', 'application/json');
      if (stockMode === 'fail') { res.statusCode = 500; return res.end('{"ok":false}'); }
      const payload = JSON.stringify({ ok: true, version: 'test', dates: stockDates });
      if (stockMode === 'slow') return setTimeout(() => res.end(payload), 3500);
      if (stockMode === 'hang') return setTimeout(() => res.end(payload), 4800);
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
const { default: summaryFn, config: summaryCfg } = await import('../netlify/functions/summary.mjs');
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
    totalItems: qty, totalAmount: lib.priceOrder(qty * 350, qty).totalAmount
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

// ---- /api/stock (durable snapshot: the order page never waits on Apps Script) ----
{
  const clearSnapshot = () => store.delete(lib.STOCK_SNAPSHOT_KEY);
  const getStockApi = (qs = '', method = 'GET', ctx) => stockFn(new Request('http://localhost/api/stock' + qs, { method }), ctx);
  await clearSnapshot(); // an earlier sweep test stored one; the first call below must find none
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

  await clearSnapshot();
  stockMode = 'fail'; lib.resetStockCache();
  const s3 = await getStockApi();
  const b3 = await s3.json();
  assert('stock api: 502 {ok:false} and no-store when Apps Script fails', s3.status === 502 && b3.ok === false && /no-store/.test(s3.headers.get('cache-control') || '') && !s3.headers.get('netlify-cdn-cache-control'), s3.status + ' ' + JSON.stringify(b3));

  const s4 = await getStockApi('', 'POST');
  assert('stock api: POST is 405', s4.status === 405);

  // ---- the snapshot: instant, stale-refresh, fresh fallback ----
  const PLUMK = 'Rich Plum Cake (400g)';
  const datesWith = (n) => [{ id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30', remaining: { [PLUMK]: n } }];
  const snapshotWith = async (n, ageMs) => lib.writeStockSnapshot(store, { ok: true, version: 'snap', dates: datesWith(n) }, () => Date.now() - ageMs);

  // first-ever call fetches live and stores the snapshot
  await clearSnapshot();
  stockMode = 'ok'; stockDates = datesWith(9); lib.resetStockCache();
  const gFirst = stockGets;
  const f1 = await getStockApi();
  const f1b = await f1.json();
  assert('snapshot: the first-ever call fetches live once and answers', f1.status === 200 && stockGets - gFirst === 1 && f1b.dates[0].remaining[PLUMK] === 9 && f1.headers.get('x-stock-age') === '0', String(stockGets - gFirst));
  const stored = await lib.readStockSnapshot(store);
  assert('snapshot: that live answer was stored in Blobs', !!stored && stored.data.dates[0].remaining[PLUMK] === 9, JSON.stringify(stored));

  // instant even while Apps Script hangs
  await snapshotWith(4, 2000);
  stockMode = 'slow'; lib.resetStockCache();
  const gInstant = stockGets;
  const t0 = Date.now();
  const i1 = await getStockApi();
  const i1b = await i1.json();
  assert('snapshot: served instantly while Apps Script is slow, with no live fetch',
    Date.now() - t0 < 600 && stockGets === gInstant && i1b.dates[0].remaining[PLUMK] === 4, (Date.now() - t0) + 'ms');
  assert('snapshot: reports its age and is not stale when young',
    Number(i1.headers.get('x-stock-age')) >= 1 && Number(i1.headers.get('x-stock-age')) <= 5 && !i1.headers.get('x-stock-stale') && /s-maxage=10/.test(i1.headers.get('netlify-cdn-cache-control') || ''),
    i1.headers.get('x-stock-age') + ' ' + i1.headers.get('x-stock-stale'));

  // stale: answered instantly with the old numbers, refresh runs in the background
  await snapshotWith(4, 30000);
  stockMode = 'ok'; stockDates = datesWith(1); lib.resetStockCache();
  const waits = [];
  const t1 = Date.now();
  const st = await getStockApi('', 'GET', { waitUntil: (p) => waits.push(p) });
  const stb = await st.json();
  assert('snapshot: a stale one is still answered at once with the old numbers',
    Date.now() - t1 < 600 && stb.dates[0].remaining[PLUMK] === 4 && st.headers.get('x-stock-stale') === '1' && Number(st.headers.get('x-stock-age')) >= 29,
    st.headers.get('x-stock-age') + ' ' + st.headers.get('x-stock-stale'));
  assert('snapshot: a stale one kicks off exactly one background refresh', waits.length === 1, String(waits.length));
  await Promise.all(waits);
  const refreshed = await lib.readStockSnapshot(store);
  assert('snapshot: the background refresh stored the new numbers for the next caller',
    refreshed.data.dates[0].remaining[PLUMK] === 1 && Date.now() - refreshed.at < 5000, JSON.stringify(refreshed));
  const next = await getStockApi();
  assert('snapshot: the next caller gets the refreshed numbers and no stale flag', (await next.json()).dates[0].remaining[PLUMK] === 1 && !next.headers.get('x-stock-stale'));

  // a failing refresh leaves the old snapshot alone
  await snapshotWith(4, 30000);
  stockMode = 'fail'; lib.resetStockCache();
  const waits2 = [];
  await getStockApi('', 'GET', { waitUntil: (p) => waits2.push(p) });
  await Promise.all(waits2);
  assert('snapshot: a failed background refresh keeps the old snapshot', (await lib.readStockSnapshot(store)).data.dates[0].remaining[PLUMK] === 4);

  // ?fresh=1: live when it can, the snapshot when it can't
  await snapshotWith(4, 60000);
  stockMode = 'ok'; stockDates = datesWith(2); lib.resetStockCache();
  const waits3 = [];
  const fr = await getStockApi('?fresh=1&t=1', 'GET', { waitUntil: (p) => waits3.push(p) });
  assert('fresh: waits for the live numbers, never cached, and updates the snapshot',
    (await fr.json()).dates[0].remaining[PLUMK] === 2 && /no-store/.test(fr.headers.get('cache-control') || '') && !fr.headers.get('x-stock-fallback') && waits3.length === 1);
  await Promise.all(waits3);
  assert('fresh: the live numbers are now the snapshot', (await lib.readStockSnapshot(store)).data.dates[0].remaining[PLUMK] === 2);

  await snapshotWith(5, 20000);
  stockMode = 'fail'; lib.resetStockCache();
  const fb = await getStockApi('?fresh=1&t=2');
  const fbb = await fb.json();
  assert('fresh: when Apps Script fails it serves the snapshot and says so',
    fb.status === 200 && fbb.dates[0].remaining[PLUMK] === 5 && fb.headers.get('x-stock-fallback') === '1' && /no-store/.test(fb.headers.get('cache-control') || '') && Number(fb.headers.get('x-stock-age')) >= 19);
  stockMode = 'hang'; lib.resetStockCache();
  const t2 = Date.now();
  const fb2 = await getStockApi('?fresh=1&t=3');
  assert('fresh: when Apps Script hangs it gives up at 4s and serves the snapshot',
    fb2.status === 200 && fb2.headers.get('x-stock-fallback') === '1' && Date.now() - t2 < 4600, (Date.now() - t2) + 'ms');
  await clearSnapshot();
  stockMode = 'fail'; lib.resetStockCache();
  const none = await getStockApi('?fresh=1&t=4');
  assert('fresh: with no snapshot and no Apps Script it is a 502', none.status === 502);

  // ---- keep it warm: the 5-minute sweep refreshes the snapshot ----
  await clearSnapshot();
  stockMode = 'ok'; stockDates = datesWith(6); lib.resetStockCache();
  await sweepFn();
  assert('sweep: also refreshes the stock snapshot', (await lib.readStockSnapshot(store))?.data.dates[0].remaining[PLUMK] === 6);
  await snapshotWith(7, 1000);
  stockMode = 'fail'; lib.resetStockCache();
  let sweepThrew = false;
  try { await sweepFn(); } catch (e) { sweepThrew = true; }
  assert('sweep: a stock failure never fails the sweep and keeps the old snapshot', !sweepThrew && (await lib.readStockSnapshot(store)).data.dates[0].remaining[PLUMK] === 7);

  // ---- order check: lean on a young snapshot when live stock fails ----
  const plumOrder = (qty) => order({
    items: [{ id: 'rich-plum-cake-400', name: PLUMK, qty, price: 320, lineTotal: qty * 320 }],
    totalItems: qty, totalAmount: lib.priceOrder(qty * 320, qty).totalAmount
  });
  await snapshotWith(0, 60 * 1000);
  stockMode = 'fail'; lib.resetStockCache();
  const young = await call(plumOrder(2)); await young.settle();
  assert('order check: live stock fails but a 1-minute-old snapshot says sold out -> rejected',
    young.status === 409 && young.json.error === 'out_of_stock' && young.json.items.includes(PLUMK), JSON.stringify(young.json));
  await snapshotWith(0, 10 * 60 * 1000);
  lib.resetStockCache();
  const old = await call(plumOrder(2)); await old.settle();
  assert('order check: a 10-minute-old snapshot is ignored and the order fails open', old.status === 200 && old.json.ok, JSON.stringify(old.json));
  await snapshotWith(10, 60 * 1000);
  lib.resetStockCache();
  const enough = await call(plumOrder(2)); await enough.settle();
  assert('order check: a young snapshot with enough stock lets the order through', enough.status === 200 && enough.json.ok, JSON.stringify(enough.json));
  await clearSnapshot();
  lib.resetStockCache();
  const noSnap = await call(plumOrder(2)); await noSnap.settle();
  assert('order check: no snapshot and no live stock fails open', noSnap.status === 200 && noSnap.json.ok, JSON.stringify(noSnap.json));

  await clearSnapshot();
  stockMode = 'ok'; stockDates = []; lib.resetStockCache();
}

// ---- bulk discount: 10% off orders of 50+ cakes ----
{
  stockMode = 'ok'; stockDates = []; lib.resetStockCache(); // no stock limits, so only the price rule is under test
  const mk = (qty, extra) => {
    const price = 320;
    const sub = qty * price;
    const p = lib.priceOrder(sub, qty);
    return order(Object.assign({
      items: [{ id: 'rich-plum-cake-400', name: 'Rich Plum Cake (400g)', qty, price, lineTotal: sub }],
      totalItems: qty, subtotal: sub,
      discountPercent: p.discountPercent, discountAmount: p.discountAmount, totalAmount: p.totalAmount
    }, extra || {}));
  };
  const hasField = (r, f) => r.status === 400 && Array.isArray(r.json.fields) && r.json.fields.includes(f);

  const p49 = lib.priceOrder(49 * 320, 49);
  const p50 = lib.priceOrder(50 * 320, 50);
  assert('discount rule: 49 cakes get no discount', p49.discountPercent === 0 && p49.discountAmount === 0 && p49.totalAmount === 15680, JSON.stringify(p49));
  assert('discount rule: 50 cakes get 10% (50 x 320 = 16000 -> 14400)', p50.discountPercent === 10 && p50.discountAmount === 1600 && p50.totalAmount === 14400, JSON.stringify(p50));
  assert('discount rule: rounds to whole rupees (12345 -> 1235 off -> 11110)', lib.priceOrder(12345, 50).discountAmount === 1235 && lib.priceOrder(12345, 50).totalAmount === 11110);
  assert('discount rule: reads site-config and falls back to 50 / 10',
    lib.bulkDiscountRule({}).minCakes === 50 && lib.bulkDiscountRule({}).percent === 10 &&
    lib.bulkDiscountRule({ bulkDiscount: { minCakes: 20, percent: 5 } }).minCakes === 20 && lib.bulkDiscountRule({ bulkDiscount: { minCakes: 20, percent: 5 } }).percent === 5 &&
    lib.bulkDiscountRule().minCakes === 50);
  assert('discount rule: the shipped config has the poster offer', JSON.stringify(lib.bulkDiscountRule()) === JSON.stringify({ minCakes: 50, percent: 10 }));

  const r49 = await call(mk(49));
  assert('discount: a 49-cake order at the full price is accepted', r49.status === 200 && r49.json.ok === true, JSON.stringify(r49.json));
  await r49.settle();

  const o50 = mk(50);
  const r50 = await call(o50);
  assert('discount: a 50-cake order with the discounted total is accepted', r50.status === 200 && r50.json.ok === true, JSON.stringify(r50.json));
  await r50.settle();
  const rec50 = await store.get('order/' + o50.orderId, { type: 'json' });
  assert('discount: the stored record carries subtotal, percent, amount and the discounted total',
    rec50.order.subtotal === 16000 && rec50.order.discountPercent === 10 && rec50.order.discountAmount === 1600 && rec50.order.totalAmount === 14400,
    JSON.stringify(rec50.order));
  const sent50 = sheetRows.get(o50.orderId);
  assert('discount: the payload sent to the Sheet has the same fields and the discounted total',
    sent50 && sent50.subtotal === 16000 && sent50.discountPercent === 10 && sent50.discountAmount === 1600 && sent50.totalAmount === 14400,
    JSON.stringify(sent50));

  // without the optional discount fields, a correct discounted total is still fine
  const bare = mk(50);
  delete bare.subtotal; delete bare.discountPercent; delete bare.discountAmount;
  const rBare = await call(bare); await rBare.settle();
  assert('discount: a 50-cake order with only the discounted total (no discount fields) is accepted', rBare.status === 200 && rBare.json.ok === true, JSON.stringify(rBare.json));

  // wrong totals are rejected and never stored
  const hitsBefore = sheetHits.length;
  const stale = mk(50, { totalAmount: 16000, discountAmount: 0, discountPercent: 0 });
  const rStale = await call(stale);
  assert('discount: 50 cakes at the old undiscounted total are rejected (totalAmount)', hasField(rStale, 'totalAmount'), JSON.stringify(rStale.json));
  assert('discount: a rejected order is not stored', (await store.get('order/' + stale.orderId, { type: 'json' })) == null && sheetHits.length === hitsBefore);
  const early = mk(49, { totalAmount: 14112, discountAmount: 1568, discountPercent: 10 });
  const rEarly = await call(early);
  assert('discount: 49 cakes claiming the discount are rejected (totalAmount)', hasField(rEarly, 'totalAmount'), JSON.stringify(rEarly.json));
  const greedy = mk(50, { totalAmount: 12000 });
  assert('discount: an even lower total is rejected too', hasField(await call(greedy), 'totalAmount'));
  const badAmt = mk(50, { discountAmount: 1 });
  assert('discount: the right total with a wrong discountAmount field is rejected', hasField(await call(badAmt), 'discountAmount'));
  const badPct = mk(50, { discountPercent: 25 });
  assert('discount: a wrong discountPercent field is rejected', hasField(await call(badPct), 'discountPercent'));
  const badSub = mk(50, { subtotal: 1 });
  assert('discount: a wrong subtotal field is rejected', hasField(await call(badSub), 'subtotal'));

  // an outbox retry queued before the offer existed keeps its undiscounted total
  const legacyRetry = mk(50, { totalAmount: 16000, retry: true });
  delete legacyRetry.subtotal; delete legacyRetry.discountPercent; delete legacyRetry.discountAmount;
  const rLegacy = await call(legacyRetry); await rLegacy.settle();
  const recLegacy = await store.get('order/' + legacyRetry.orderId, { type: 'json' });
  assert('discount: a retry with the old undiscounted total is accepted as sent (not lost)',
    rLegacy.status === 200 && recLegacy.order.totalAmount === 16000 && recLegacy.order.discountAmount === 0 && recLegacy.order.subtotal === 16000,
    JSON.stringify(rLegacy.json) + JSON.stringify(recLegacy && recLegacy.order));
  const legacyFallback = mk(50, { totalAmount: 16000, fallback: true });
  const rFb = await call(legacyFallback); await rFb.settle();
  assert('discount: a fallback order with the old total is accepted as sent too', rFb.status === 200 && rFb.json.ok === true);
  const retryWrong = mk(50, { totalAmount: 15000, retry: true });
  assert('discount: a retry is only lenient about the undiscounted total, not any total', hasField(await call(retryWrong), 'totalAmount'));

  // old payloads (no discount fields) under the threshold are unchanged
  const small = order();
  const rSmall = await call(small); await rSmall.settle();
  const recSmall = await store.get('order/' + small.orderId, { type: 'json' });
  assert('discount: a small order without discount fields is valid and priced at list price',
    rSmall.status === 200 && recSmall.order.totalAmount === 700 && recSmall.order.discountAmount === 0 && recSmall.order.subtotal === 700,
    JSON.stringify(recSmall && recSmall.order));
}

// ---- backoff ----
assert('backoff 1,2,4..30 min', lib.backoffMs(1) === 60000 && lib.backoffMs(3) === 240000 && lib.backoffMs(20) === 1800000);

// ---- /api/summary (aggregates only; snapshot served instantly, refreshed in the background) ----
{
  const clearSnap = () => store.delete(lib.SUMMARY_SNAPSHOT_KEY);
  const getSummaryApi = (qs = '', method = 'GET', ctx) => summaryFn(new Request('http://localhost/api/summary' + qs, { method }), ctx);
  const cakesOf = async (res) => (await res.json()).grand.cakes;
  assert('config: summary function path is /api/summary', summaryCfg.path === '/api/summary');
  await clearSnap();

  // first-ever call: live fetch, stored for the next caller
  summaryMode = 'ok'; summaryTotal = 5;
  const sg0 = summaryGets;
  const r1 = await getSummaryApi();
  assert('summary api: the first-ever call fetches live once and answers', r1.status === 200 && summaryGets - sg0 === 1 && (await cakesOf(r1)) === 5 && r1.headers.get('x-summary-age') === '0');
  assert('summary api: the CDN caches 10s and serves stale while revalidating',
    /s-maxage=10/.test(r1.headers.get('netlify-cdn-cache-control') || '') && /stale-while-revalidate=120/.test(r1.headers.get('netlify-cdn-cache-control') || ''), r1.headers.get('netlify-cdn-cache-control'));
  const stored = await lib.readSummarySnapshot(store);
  assert('summary api: that answer was stored as the snapshot', !!stored && stored.data.grand.cakes === 5);

  // instant while Apps Script is slow
  await lib.writeSummarySnapshot(store, { ok: true, dates: [], grand: { cakes: 4 } }, () => Date.now() - 3000);
  summaryMode = 'slow';
  const sg1 = summaryGets;
  const t0 = Date.now();
  const r2 = await getSummaryApi();
  assert('summary api: the snapshot is served instantly while Apps Script is slow, with no live fetch',
    Date.now() - t0 < 600 && summaryGets === sg1 && (await cakesOf(r2)) === 4 && !r2.headers.get('x-summary-stale'), (Date.now() - t0) + 'ms');

  // stale: old numbers at once, one background refresh
  await lib.writeSummarySnapshot(store, { ok: true, dates: [], grand: { cakes: 4 } }, () => Date.now() - 40000);
  summaryMode = 'ok'; summaryTotal = 9;
  const waits = [];
  const t1 = Date.now();
  const r3 = await getSummaryApi('', 'GET', { waitUntil: (p) => waits.push(p) });
  assert('summary api: a stale snapshot is answered at once with the old numbers and flagged stale',
    Date.now() - t1 < 600 && (await cakesOf(r3)) === 4 && r3.headers.get('x-summary-stale') === '1' && Number(r3.headers.get('x-summary-age')) >= 39);
  assert('summary api: a stale snapshot starts exactly one background refresh', waits.length === 1, String(waits.length));
  await Promise.all(waits);
  assert('summary api: the refresh stored the new numbers for the next caller', (await cakesOf(await getSummaryApi())) === 9);

  // ?fresh=1: waits for live, never cached; falls back to the snapshot when Apps Script is down or slow
  summaryTotal = 11;
  const r4 = await getSummaryApi('?fresh=1');
  assert('summary api: ?fresh=1 returns live numbers and is never cached',
    (await cakesOf(r4)) === 11 && /no-store/.test(r4.headers.get('cache-control') || '') && !r4.headers.get('netlify-cdn-cache-control'));
  summaryMode = 'fail';
  const r5 = await getSummaryApi('?fresh=1');
  assert('summary api: ?fresh=1 falls back to the snapshot (X-Summary-Fallback) when Apps Script fails',
    r5.status === 200 && r5.headers.get('x-summary-fallback') === '1' && (await cakesOf(r5)) === 11);

  // total failure: 502, never cached
  await clearSnap();
  const r6 = await getSummaryApi();
  assert('summary api: no snapshot and Apps Script down is a 502 {ok:false}, never cached',
    r6.status === 502 && (await r6.json()).ok === false && /no-store/.test(r6.headers.get('cache-control') || '') && !r6.headers.get('netlify-cdn-cache-control'));
  assert('summary api: POST is 405', (await getSummaryApi('', 'POST')).status === 405);

  // privacy: nothing but aggregates is ever stored or served, even if the backend misbehaves
  await clearSnap();
  summaryMode = 'ok'; summaryTotal = 3;
  summaryExtra = { orders: [{ name: 'Zed Third', phone: '9000000003' }], staff: { pin: '2468' }, raw: 'Asha 9876543210' };
  const rp = await getSummaryApi();
  const served = JSON.stringify(await rp.json());
  const snap = JSON.stringify(await lib.readSummarySnapshot(store));
  assert('summary api: names, phones and extra keys are stripped from the answer and the stored snapshot',
    !/Zed|9000000003|2468|9876543210|"orders":\[/.test(served) && !/Zed|9000000003|2468|9876543210|"orders":\[/.test(snap), served.slice(0, 160));
  summaryExtra = null;

  // the 5-minute sweep keeps the snapshot warm and a summary failure never fails the order sweep
  await clearSnap();
  summaryMode = 'ok'; summaryTotal = 6;
  await sweepFn();
  const warmed = await lib.readSummarySnapshot(store);
  assert('sweep: refreshes the summary snapshot', !!warmed && warmed.data.grand.cakes === 6 && Date.now() - warmed.at < 5000);
  summaryMode = 'fail';
  let sweepOk = true;
  try { await sweepFn(); } catch (e) { sweepOk = false; }
  assert('sweep: a failing summary refresh never fails the sweep and keeps the old snapshot',
    sweepOk && (await lib.readSummarySnapshot(store)).data.grand.cakes === 6);
  summaryMode = 'ok';
  assert('sanitizeSummary keeps only the aggregate keys', (() => {
    const out = lib.sanitizeSummary({ ok: true, dates: [], grand: {}, orders: [1], name: 'x' });
    return !('orders' in out) && !('name' in out) && out.ok === true && lib.sanitizeSummary({ nodates: 1 }) === null;
  })());
}

mock.close();
await blobs.stop();
fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log('\n--- functions ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
process.exit(failed.length ? 1 : 0);
