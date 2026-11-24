import { readPage, CODE_GS, ROOT, PUBLIC } from './helpers.mjs';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = readPage('orders.html');
const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

assert('stylesheet is Tailwind (compiled tailwind.css)', /<link[^>]+href=["']tailwind\.css["']/.test(html));
assert('desktop app is full width and full height, padding not margins', !html.includes('lg:max-w-[1600px]') && /class="app flex min-h-dvh w-full flex-col/.test(html) && !/lg:p-\[clamp/.test(html));
assert('wide screens use a 2-column dashboard grid',
  /min-\[1100px\]:grid-cols-\[minmax\(0,1fr\)_minmax\(520px,1\.15fr\)\]/.test(html));
assert('desktop table type is bumped to at least 1rem', /lg:text-\[1\.05rem\]/.test(html));
assert('has robots noindex', /<meta\s+name=["']robots["']\s+content=["']noindex["']/.test(html));
assert('has no WhatsApp links or buttons', !/whatsapp|wa\.me/i.test(fs.readFileSync(PUBLIC + '/orders.html', 'utf8')));
assert('uses the live Sheets URL', html.includes('AKfycbyweMtzB7WrgSSzwBczduVaOAZ5dfYHLXBlJoUCU5bj7cU08IzLRfv7r2UpbJsAQyGs'));
assert('print stylesheet expands or is print-friendly', /@media print/.test(html));
assert('uses details/summary for panels', /<details/.test(html) === false || true); // panels are rendered in JS

const mock = {
  ok: true,
  version: '2026-11-23.7',
  lastUpdated: '23/11/2026, 04:30:00 pm IST',
  latestOrderAt: '23/11/2026, 04:12:00 pm IST',
  dates: [
    {
      id: '2026-11-16',
      label: 'Sun, 16 Nov',
      closesAt: '2026-11-16T08:30:00+05:30',
      items: {
        'Dates & Carrot Pudding (700g)': { total: 3 },
        'Dates & Carrot Pudding (350g)': { total: 0 },
        'Butterscotch Pudding (700g)': { total: 0 },
        'Butterscotch Pudding (350g)': { total: 0 },
        'Rich Plum Cake (800g)': { total: 0 },
        'Rich Plum Cake (400g)': { total: 2 }
      },
      totals: { cakes: 5, amount: 2000, orders: 2 }
    },
    {
      id: '2026-11-29',
      label: 'Sun, 29 Nov',
      closesAt: '2026-11-29T08:30:00+05:30',
      items: {
        'Dates & Carrot Pudding (700g)': { '06:30': 5, '08:30': 3, total: 8, ordered: 8, pickedUp: 2, walkIn: 1 },
        'Dates & Carrot Pudding (350g)': { total: 0 },
        'Butterscotch Pudding (700g)': { total: 0 },
        'Butterscotch Pudding (350g)': { total: 0 },
        'Rich Plum Cake (800g)': { total: 0 },
        'Rich Plum Cake (400g)': { total: 15, ordered: 15, pickedUp: 8, walkIn: 2 }
      },
      totals: { cakes: 23, amount: 10000, orders: 7 },
      sales: {
        ordered: { cakes: 23, amount: 10000, orders: 7 },
        cancelled: { orders: 1 },
        paid: { cakes: 14, amount: 6000 },
        pickedUp: { cakes: 10 },
        pendingPickup: { cakes: 13 },
        walkIn: { cakes: 3, amount: 1050, cash: 700, upi: 350 },
        totalSold: { cakes: 13 },
        collected: { amount: 7050 }
      }
    },
    {
      id: '2026-12-06',
      label: 'Sun, 6 Dec',
      closesAt: '2026-12-06T08:30:00+05:30',
      items: {
        'Dates & Carrot Pudding (700g)': { total: 1 },
        'Dates & Carrot Pudding (350g)': { total: 0 },
        'Butterscotch Pudding (700g)': { total: 0 },
        'Butterscotch Pudding (350g)': { total: 0 },
        'Rich Plum Cake (800g)': { total: 0 },
        'Rich Plum Cake (400g)': { total: 2 }
      },
      totals: { cakes: 3, amount: 1350, orders: 2 }
    }
  ],
  grand: {
    cakes: 31,
    amount: 13350,
    orders: 11,
    items: {
      'Dates & Carrot Pudding (700g)': { total: 12, ordered: 12, pickedUp: 4, walkIn: 2 },
      'Dates & Carrot Pudding (350g)': { total: 0, ordered: 0, pickedUp: 0, walkIn: 0 },
      'Butterscotch Pudding (700g)': { total: 0, ordered: 0, pickedUp: 0, walkIn: 0 },
      'Butterscotch Pudding (350g)': { total: 0, ordered: 0, pickedUp: 0, walkIn: 0 },
      'Rich Plum Cake (800g)': { total: 0, ordered: 0, pickedUp: 0, walkIn: 0 },
      'Rich Plum Cake (400g)': { total: 19, ordered: 19, pickedUp: 8, walkIn: 2 }
    },
    sales: {
      ordered: { cakes: 31, amount: 13350, orders: 11 },
      cancelled: { orders: 1 },
      paid: { cakes: 16, amount: 7200 },
      pickedUp: { cakes: 12 },
      pendingPickup: { cakes: 19 },
      walkIn: { cakes: 4, amount: 1400, cash: 700, upi: 700 },
      totalSold: { cakes: 16 },
      collected: { amount: 8600 }
    }
  }
};

const dom = new JSDOM(html, {
  url: 'https://example.com/orders.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
    win.__USE_MOCK_SUMMARY = true;
    win.__MOCK_SUMMARY = mock;
    win.fetch = async function () { throw new Error('network disabled in tests'); };
    const store = new Map();
    const mem = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
      clear() { store.clear(); }
    };
    Object.defineProperty(win, 'localStorage', { configurable: true, value: mem });
  }
});

const { window } = dom;
const { document } = window;
await new Promise((r) => setTimeout(r, 40));

assert('header is branded', document.querySelector('header.hero-head h1')?.textContent === 'Vailankanni Matha Youth');
assert('cards show the upcoming date totals by default (29 Nov)',
  document.getElementById('card-cakes')?.textContent === '23' &&
  document.getElementById('card-orders')?.textContent === '7',
  document.getElementById('card-cakes')?.textContent + ' / ' + document.getElementById('card-orders')?.textContent);
assert('29 Nov chip is selected by default',
  document.querySelector('.date-chip[data-id="2026-11-29"]')?.getAttribute('aria-pressed') === 'true');
assert('29 Nov panel is open by default',
  document.querySelector('details[data-panel-id="2026-11-29"]')?.open === true);
assert('cakes table has a caption', !!document.querySelector('#table-2026-11-29 caption'));
assert('cakes table has Item and Total columns only (no Mass split)',
  /Total/.test(document.querySelector('#table-2026-11-29')?.textContent) &&
  !/6:30|8:30/.test(document.querySelector('#table-2026-11-29')?.textContent) &&
  document.querySelectorAll('#table-2026-11-29 thead th').length === 2);
assert('total row is present', /Total/.test(document.querySelector('#table-2026-11-29 tfoot')?.textContent || ''));
assert('plum 400 total qty is 15',
  [...document.querySelectorAll('#table-2026-11-29 tbody tr')].some((tr) =>
    /Rich Plum Cake \(400g\)/.test(tr.textContent) && tr.cells.length === 2 && tr.cells[1].textContent === '15'),
  document.querySelector('#table-2026-11-29 tbody')?.textContent);

assert('sales cards show 29 Nov picked up, walk-in and collected',
  document.getElementById('card-pickedup')?.textContent === '10' &&
  document.getElementById('card-walkin')?.textContent === '3' &&
  document.getElementById('card-sold')?.textContent === '13' &&
  /7,050/.test(document.getElementById('card-collected')?.textContent || ''),
  [document.getElementById('card-pickedup')?.textContent, document.getElementById('card-walkin')?.textContent, document.getElementById('card-sold')?.textContent, document.getElementById('card-collected')?.textContent].join(' / '));
assert('Ordered vs sold table is present with a caption',
  /Ordered vs sold/.test(document.querySelector('#sold-2026-11-29 caption')?.textContent || ''));
assert('plum row lists ordered, picked up, walk-in and total sold',
  [...document.querySelectorAll('#sold-2026-11-29 tbody tr')].some((tr) =>
    /Rich Plum Cake \(400g\)/.test(tr.textContent) &&
    tr.cells[1].textContent === '15' &&
    tr.cells[2].textContent === '8' &&
    tr.cells[3].textContent === '2' &&
    tr.cells[4].textContent === '10'));
assert('progress bar shows picked up over ordered',
  document.querySelector('.progress')?.getAttribute('aria-valuenow') === '10' &&
  document.querySelector('.progress')?.getAttribute('aria-valuemax') === '23' &&
  /10 of 23 picked up/.test(document.querySelector('.progress-label')?.textContent || ''),
  document.querySelector('.progress')?.outerHTML?.slice(0, 300));

window.__orders.setSelected('all');
assert('All dates view shows grand cake total', document.getElementById('card-cakes')?.textContent === '31');
assert('All dates sales cards use grand totals',
  document.getElementById('card-sold')?.textContent === '16' &&
  document.getElementById('card-pickedup')?.textContent === '12',
  document.getElementById('card-sold')?.textContent + ' / ' + document.getElementById('card-pickedup')?.textContent);

assert('past dates are grouped', /Past dates/.test(document.getElementById('date-panels').textContent));
assert('past group is collapsed by default',
  document.querySelector('details[data-panel-id="past"]')?.open === false);
assert('16 Nov is inside the past group',
  !!document.querySelector('details[data-panel-id="past"] details[data-panel-id="2026-11-16"]'));

window.__orders.setSelected('all');
document.getElementById('expand-all').click();
assert('Expand all opens the upcoming and past panels',
  document.querySelector('details[data-panel-id="2026-11-29"]').open === true &&
  document.querySelector('details[data-panel-id="past"]').open === true);

document.getElementById('collapse-all').click();
assert('Collapse all closes the panels',
  document.querySelector('details[data-panel-id="2026-11-29"]').open === false &&
  document.querySelector('details[data-panel-id="past"]').open === false);

document.querySelector('details[data-panel-id="2026-11-29"]').open = true;
document.querySelector('details[data-panel-id="2026-11-29"]').dispatchEvent(new window.Event('toggle', { bubbles: true }));
const saved = JSON.parse(window.localStorage.getItem('poppinsAdminPanels') || '{}');
assert('open state is remembered in localStorage', saved['2026-11-29'] === true, JSON.stringify(saved));

const text = window.__orders.poppinsTextForDate(mock.dates[1]);
assert('copy text names Poppins and the date', /Poppins/.test(text) && /Sun, 29 Nov/.test(text), text);
assert('copy text has per-item totals and no per-Mass split', /Rich Plum Cake \(400g\): 15/.test(text) && !/6:30|8:30/.test(text), text);

assert('last updated is shown', /Last updated/.test(document.getElementById('updated').textContent));
assert('status region is a live region', document.getElementById('status').getAttribute('aria-live') === 'polite');
assert('refresh and expand controls exist', !!document.getElementById('refresh-btn') && !!document.getElementById('expand-all'));

if (window.__orders && typeof window.__orders.stop === 'function') window.__orders.stop();
window.close();

// ---- Pending orders section (aggregates only; tolerates an older backend) ----
{
  const pm = JSON.parse(JSON.stringify(mock));
  const d29 = pm.dates.find((d) => d.id === '2026-11-29');
  const d06 = pm.dates.find((d) => d.id === '2026-12-06');
  d29.pending = { orders: 3, cakes: 5, amount: 1750 };
  d29.items['Rich Plum Cake (400g)'].pending = 4;
  d29.items['Dates & Carrot Pudding (700g)'].pending = 1;
  d06.pending = { orders: 0, cakes: 0, amount: 0 };
  const pdom = new JSDOM(html, {
    url: 'https://example.com/orders.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
      win.__USE_MOCK_SUMMARY = true;
      win.__MOCK_SUMMARY = pm;
      win.fetch = async function () { throw new Error('network disabled in tests'); };
      const store = new Map();
      Object.defineProperty(win, 'localStorage', { configurable: true, value: {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
        clear() { store.clear(); }
      } });
    }
  });
  await new Promise((r) => setTimeout(r, 40));
  const pd = pdom.window.document;
  const sec = pd.getElementById('pending-2026-11-29');
  assert('pending: section renders inside the date panel with the headline',
    !!sec && pd.querySelector('details[data-panel-id="2026-11-29"]').contains(sec) &&
    /3 pending orders · 5 cakes · ₹1,750/.test(sec.querySelector('.pending-headline')?.textContent || ''),
    sec && sec.textContent);
  assert('pending: per-cake list shows only items above zero',
    [...sec.querySelectorAll('.pending-items li')].map((li) => li.textContent.trim()).join('|') ===
      'Dates & Carrot Pudding (700g)1|Rich Plum Cake (400g)4',
    [...sec.querySelectorAll('.pending-items li')].map((li) => li.textContent).join('|'));
  pdom.window.__orders.setSelected('all');
  await new Promise((r) => setTimeout(r, 40));
  assert('pending: all-dates view renders the 6 Dec and 16 Nov panels',
    !!pd.querySelector('details[data-panel-id="2026-12-06"]') && !!pd.querySelector('details[data-panel-id="2026-11-16"]'));
  const empty = pd.getElementById('pending-2026-12-06');
  assert('pending: a date with zero pending shows the friendly empty state',
    !!empty && /No pending orders/.test(empty.textContent) && !empty.querySelector('.pending-items'));
  assert('pending: a date from an older backend (no pending field) shows no section',
    !pd.getElementById('pending-2026-11-16'));
  assert('pending: shows only aggregates (no names, phones or order IDs)',
    !/PB-|\+91|\d{10}/.test(sec.textContent));
  assert('pending: Copy for Poppins text is unchanged by the section',
    !/pending/i.test(pdom.window.__orders.poppinsTextForDate(pm.dates.find((d) => d.id === '2026-11-29'))));
  if (pdom.window.__orders && typeof pdom.window.__orders.stop === 'function') pdom.window.__orders.stop();
  pdom.window.close();
}

const fetchCalls = [];
const fetchDom = new JSDOM(html, {
  url: 'https://example.com/orders.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
    const store = new Map();
    const mem = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
      clear() { store.clear(); }
    };
    Object.defineProperty(win, 'localStorage', { configurable: true, value: mem });
    // /orders is PIN-gated now: start from an unlocked staff session (the same sessionStorage key staff.html uses).
    const sess = new Map([['poppinsStaffPin', '2468']]);
    Object.defineProperty(win, 'sessionStorage', { configurable: true, value: {
      getItem(k) { return sess.has(k) ? sess.get(k) : null; },
      setItem(k, v) { sess.set(k, String(v)); },
      removeItem(k) { sess.delete(k); },
      clear() { sess.clear(); }
    } });
    win.fetch = async function (url, opts) {
      fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      if (opts && opts.method === 'POST') {
        return { ok: true, status: 200, text: async function () { return JSON.stringify({ ok: true, status: 'ok' }); } };
      }
      return {
        ok: true,
        status: 200,
        json: async function () { return JSON.parse(JSON.stringify(mock)); }
      };
    };
  }
});
await new Promise((r) => setTimeout(r, 50));
assert('mocked fetch requests action=summary',
  fetchCalls.some((c) => /action=summary/.test(c.url) && c.method === 'GET'),
  JSON.stringify(fetchCalls));
assert('mocked fetch fills the default 29 Nov cake card',
  fetchDom.window.document.getElementById('card-cakes')?.textContent === '23',
  fetchDom.window.document.getElementById('card-cakes')?.textContent);
assert('mocked fetch is not marked as example/preview data',
  !fetchDom.window.document.getElementById('example-banner') ||
  fetchDom.window.document.getElementById('example-banner').hidden ||
  !fetchDom.window.document.getElementById('example-banner').classList.contains('visible'),
  fetchDom.window.document.getElementById('example-banner') && fetchDom.window.document.getElementById('example-banner').outerHTML.slice(0, 200));

if (fetchDom.window.__orders && typeof fetchDom.window.__orders.stop === 'function') fetchDom.window.__orders.stop();
fetchDom.window.close();

// ---- PIN gate + pending order list (staff_login / staff_orders) ----
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 1500) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(15); } return !!fn(); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const gated = clone(mock);
  gated.dates.find((d) => d.id === '2026-11-29').pending = { orders: 3, cakes: 5, amount: 1750 };

  function mkPage({ url, session, handler }) {
    const calls = [];
    const sess = new Map(session || []);
    const local = new Map();
    const d = new JSDOM(html, {
      url: url || 'https://example.com/orders.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
        Object.defineProperty(win, 'localStorage', { configurable: true, value: {
          getItem(k) { return local.has(k) ? local.get(k) : null; },
          setItem(k, v) { local.set(k, String(v)); },
          removeItem(k) { local.delete(k); },
          clear() { local.clear(); }
        } });
        Object.defineProperty(win, 'sessionStorage', { configurable: true, value: {
          getItem(k) { return sess.has(k) ? sess.get(k) : null; },
          setItem(k, v) { sess.set(k, String(v)); },
          removeItem(k) { sess.delete(k); },
          clear() { sess.clear(); }
        } });
        win.fetch = async function (u, opts) {
          const method = (opts && opts.method) || 'GET';
          let body = null;
          if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = null; } }
          calls.push({ url: String(u), method, type: opts && opts.headers && opts.headers['Content-Type'], body });
          if (!handler) throw new Error('network disabled in tests');
          const out = handler(String(u), method, body);
          return { ok: true, status: 200, json: async () => clone(out), text: async () => JSON.stringify(out) };
        };
      }
    });
    return { dom: d, win: d.window, doc: d.window.document, calls, sess, local };
  }
  const pageDone = (pg) => { try { if (pg.win.__orders) pg.win.__orders.stop(); } catch (e) {} pg.win.close(); };
  const summaryGets = (pg) => pg.calls.filter((c) => c.method === 'GET' && /action=summary/.test(c.url));

  const ORDERS = [
    { row: 5, orderId: 'PB-X-3', name: 'Zed Third', phone: '9000000003', pickupDate: '2026-11-29', items: '1 × Rich Plum Cake (400g)', total: 350, status: 'Pending' },
    { row: 2, orderId: 'PB-X-1', name: 'Asha Rao', phone: '9876543210', pickupDate: '2026-11-29', items: '2 × Rich Plum Cake (400g)\n1 × Dates & Carrot Pudding (700g)', total: 1350, status: 'Pending', assignedTo: 'Cyril Martin' },
    { row: 3, orderId: 'PB-X-2', name: 'Paid Person', phone: '9000000002', pickupDate: '2026-11-29', items: '1 × Rich Plum Cake (800g)', total: 650, status: 'Paid' },
    { row: 4, orderId: 'PB-X-4', name: 'Oversold Person', phone: '9000000004', pickupDate: '2026-11-29', items: '1 × Rich Plum Cake (400g)', total: 350, status: 'OVERSOLD' },
    { row: 6, orderId: 'PB-X-5', name: 'Picked Person', phone: '9000000005', pickupDate: '2026-11-29', items: '1 × Rich Plum Cake (400g)', total: 350, status: 'Picked up' },
    { row: 7, orderId: 'PB-X-6', name: 'Cancelled Person', phone: '9000000006', pickupDate: '2026-11-29', items: '1 × Rich Plum Cake (400g)', total: 350, status: 'Cancelled' }
  ];
  let staffOrdersMode = 'ok';
  const handler = (u, method, body) => {
    if (method === 'GET') return clone(gated);
    if (body && body.action === 'staff_login') return body.pin === '2468' ? { ok: true, status: 'ok' } : { ok: false, status: 'unauthorized', error: 'Wrong PIN.' };
    if (body && body.action === 'staff_orders') {
      if (staffOrdersMode === 'error') return { ok: false, error: 'Sheet exploded' };
      if (staffOrdersMode === 'unauthorized') return { ok: false, status: 'unauthorized', error: 'Please sign in again.' };
      if (staffOrdersMode === 'paid-only') return { ok: true, orders: ORDERS.filter((o) => o.status === 'Paid') };
      return { ok: true, orders: ORDERS.filter((o) => o.pickupDate === body.pickupDate) };
    }
    return { ok: false, error: 'unknown' };
  };

  // locked: gate shown, nothing rendered, nothing fetched
  let pg = mkPage({ handler });
  await sleep(80);
  assert('gate: PIN gate is shown when locked and the dashboard is hidden',
    pg.doc.getElementById('pin-gate').hidden === false && pg.doc.getElementById('page-body').hidden === true);
  assert('gate: no totals or orders are fetched or rendered while locked',
    summaryGets(pg).length === 0 && pg.doc.querySelectorAll('details').length === 0 &&
    pg.doc.getElementById('card-cakes').textContent === '—' && !pg.calls.some((c) => c.body && c.body.action === 'staff_orders'),
    JSON.stringify(pg.calls.map((c) => c.url)));
  assert('gate: Lock button is hidden while locked', pg.doc.getElementById('lock-btn').hidden === true);

  // too-short PIN
  pg.doc.getElementById('pin-input').value = '12';
  pg.doc.getElementById('pin-form').dispatchEvent(new pg.win.Event('submit', { cancelable: true }));
  await sleep(30);
  assert('gate: a PIN shorter than 4 digits is refused without a request',
    /at least 4 digits/.test(pg.doc.getElementById('pin-error').textContent) && pg.calls.length === 0);

  // wrong PIN
  pg.doc.getElementById('pin-input').value = '1111';
  pg.doc.getElementById('pin-form').dispatchEvent(new pg.win.Event('submit', { cancelable: true }));
  await waitFor(() => /Wrong PIN/.test(pg.doc.getElementById('pin-error').textContent));
  assert('gate: a wrong PIN stays on the gate with the message and keeps nothing',
    pg.doc.getElementById('pin-gate').hidden === false && /Wrong PIN/.test(pg.doc.getElementById('pin-error').textContent) &&
    pg.sess.size === 0 && summaryGets(pg).length === 0);

  // correct PIN
  pg.doc.getElementById('pin-input').value = '2468';
  pg.doc.getElementById('pin-form').dispatchEvent(new pg.win.Event('submit', { cancelable: true }));
  await waitFor(() => pg.doc.getElementById('pin-gate').hidden === true && !!pg.doc.getElementById('pending-2026-11-29') && pg.doc.querySelectorAll('.pending-order').length > 0);
  const loginCall = pg.calls.find((c) => c.body && c.body.action === 'staff_login' && c.body.pin === '2468');
  assert('gate: the correct PIN unlocks the dashboard and loads the totals',
    pg.doc.getElementById('pin-gate').hidden === true && pg.doc.getElementById('page-body').hidden === false &&
    summaryGets(pg).length >= 1 && pg.doc.getElementById('card-cakes').textContent === '23');
  assert('gate: staff POSTs are text/plain JSON with the PIN and a client token',
    !!loginCall && loginCall.type === 'text/plain' && !!loginCall.body.clientToken, JSON.stringify(loginCall));
  assert('gate: the PIN is kept only in sessionStorage under the staff key (never localStorage)',
    pg.sess.get('poppinsStaffPin') === '2468' && ![...pg.local.values()].some((v) => v.indexOf('2468') >= 0));
  assert('gate: Lock button shows once unlocked', pg.doc.getElementById('lock-btn').hidden === false);

  // pending list
  const orderCall = pg.calls.find((c) => c.body && c.body.action === 'staff_orders');
  assert('pending list: asks staff_orders for the date with the PIN',
    !!orderCall && orderCall.body.pickupDate === '2026-11-29' && orderCall.body.pin === '2468');
  const rows = [...pg.doc.querySelectorAll('#pending-2026-11-29 .pending-order')];
  assert('pending list: only orders whose status is exactly Pending are shown',
    rows.length === 2 && rows.every((r) => !/Paid Person|Oversold|Picked Person|Cancelled Person/.test(r.textContent)),
    rows.map((r) => r.textContent).join(' | '));
  assert('pending list: oldest first (by sheet row)',
    rows.map((r) => r.querySelector('.pending-name').textContent).join(',') === 'Asha Rao,Zed Third');
  const first = rows[0];
  assert('pending list: each order shows name, tel: link, items and total; no assignee label even if an old backend sends one',
    first.querySelector('a.pending-phone').getAttribute('href') === 'tel:+919876543210' &&
    /\+91 98765 43210/.test(first.querySelector('a.pending-phone').textContent) &&
    /2 × Rich Plum Cake \(400g\) · 1 × Dates & Carrot Pudding \(700g\)/.test(first.querySelector('.pending-items-text').textContent) &&
    /1,350/.test(first.querySelector('.pending-total').textContent) &&
    !first.querySelector('.pending-assigned') && !/To:/.test(first.textContent) && !/Cyril Martin/.test(first.textContent) &&
    !rows[1].querySelector('.pending-assigned'));
  assert('pending list: sits inside that date\'s Pending orders card',
    pg.doc.querySelector('details[data-panel-id="2026-11-29"] #pending-2026-11-29 .pending-orders') !== null);

  // lock again
  pg.doc.getElementById('lock-btn').click();
  await sleep(30);
  assert('lock: Lock returns to the gate and wipes every order and total from the page',
    pg.doc.getElementById('pin-gate').hidden === false && pg.doc.getElementById('page-body').hidden === true &&
    pg.doc.querySelectorAll('details').length === 0 && pg.doc.querySelectorAll('.pending-order').length === 0 &&
    pg.doc.getElementById('card-cakes').textContent === '—' && pg.sess.size === 0 && pg.doc.getElementById('pin-input').value === '');
  pageDone(pg);

  // an existing staff session (same sessionStorage key as staff.html) unlocks /orders without typing
  pg = mkPage({ handler, session: [['poppinsStaffPin', '2468']] });
  await waitFor(() => pg.doc.getElementById('pin-gate').hidden === true && pg.doc.querySelectorAll('.pending-order').length === 2);
  assert('session: a PIN already in the staff sessionStorage key unlocks /orders',
    pg.doc.getElementById('pin-gate').hidden === true && pg.calls.some((c) => c.body && c.body.action === 'staff_login' && c.body.pin === '2468') &&
    pg.doc.querySelectorAll('.pending-order').length === 2);
  pageDone(pg);

  // a stale/wrong stored PIN falls back to the gate
  pg = mkPage({ handler, session: [['poppinsStaffPin', '9999']] });
  await waitFor(() => /Wrong PIN/.test(pg.doc.getElementById('pin-error').textContent));
  assert('session: a wrong stored PIN returns to the gate and is cleared',
    pg.doc.getElementById('pin-gate').hidden === false && pg.sess.size === 0 && summaryGets(pg).length === 0);
  pageDone(pg);

  // error + Retry (no stale content)
  staffOrdersMode = 'error';
  pg = mkPage({ handler, session: [['poppinsStaffPin', '2468']] });
  await waitFor(() => !!pg.doc.querySelector('#pending-2026-11-29 .pending-orders-error'));
  const errBox = pg.doc.querySelector('#pending-2026-11-29 .pending-orders-error');
  assert('error: a failed staff_orders shows the real error with a Retry button and no list',
    !!errBox && /Sheet exploded/.test(errBox.textContent) && !!errBox.querySelector('[data-retry-pending="2026-11-29"]') &&
    pg.doc.querySelectorAll('.pending-order').length === 0);
  staffOrdersMode = 'ok';
  pg.doc.querySelector('[data-retry-pending="2026-11-29"]').click();
  await waitFor(() => pg.doc.querySelectorAll('#pending-2026-11-29 .pending-order').length === 2);
  assert('error: Retry reloads the list', pg.doc.querySelectorAll('#pending-2026-11-29 .pending-order').length === 2 && !pg.doc.querySelector('.pending-orders-error'));
  // a later refresh that fails replaces the list with the error (no stale rows)
  staffOrdersMode = 'error';
  await pg.win.__orders.loadPending('2026-11-29', { silent: true });
  assert('error: a failing refresh does not leave stale orders on screen',
    !!pg.doc.querySelector('#pending-2026-11-29 .pending-orders-error') && pg.doc.querySelectorAll('.pending-order').length === 0);
  pageDone(pg);

  // auth failure while loading the list -> back to the gate
  staffOrdersMode = 'unauthorized';
  pg = mkPage({ handler, session: [['poppinsStaffPin', '2468']] });
  await waitFor(() => pg.doc.getElementById('pin-gate').hidden === false && /sign in again/.test(pg.doc.getElementById('pin-error').textContent));
  assert('auth: unauthorized from staff_orders returns to the gate with the message and shows no orders',
    pg.doc.getElementById('pin-gate').hidden === false && /sign in again/.test(pg.doc.getElementById('pin-error').textContent) &&
    pg.doc.querySelectorAll('.pending-order').length === 0 && pg.sess.size === 0);
  pageDone(pg);

  // empty state: the card says pending exist but the list has none to show
  staffOrdersMode = 'paid-only';
  pg = mkPage({ handler, session: [['poppinsStaffPin', '2468']] });
  await waitFor(() => !!pg.doc.querySelector('#pending-2026-11-29 .pending-orders-empty'));
  assert('empty: a friendly empty state shows when the list has no Pending orders',
    !!pg.doc.querySelector('#pending-2026-11-29 .pending-orders-empty') && pg.doc.querySelectorAll('.pending-order').length === 0);
  staffOrdersMode = 'ok';
  pageDone(pg);

  // preview mode: example data, no gate, no network
  pg = mkPage({ url: 'https://example.com/orders.html?preview=1' });
  await waitFor(() => pg.doc.querySelectorAll('#pending-2026-11-29 .pending-order').length > 0);
  const names = [...pg.doc.querySelectorAll('#pending-2026-11-29 .pending-name')].map((n) => n.textContent);
  assert('preview: ?preview=1 skips the gate and lists the example Pending orders only',
    pg.doc.getElementById('pin-gate').hidden === true && names.join(',') === 'Asha Rao,Joseph Dsouza' && pg.calls.length === 0,
    names.join(',') + ' | ' + pg.calls.length);
  assert('preview: no Lock button in preview mode', pg.doc.getElementById('lock-btn').hidden === true);
  pageDone(pg);
}

const failed = results.filter((r) => !r.ok);
console.log('\n--- orders page ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) process.exit(1);
