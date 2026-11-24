import { readPage, CODE_GS, ROOT, PUBLIC } from './helpers.mjs';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const staffHtml = readPage('staff.html');
const adminHtml = readPage('admin.html');
const indexHtml = readPage('index.html');

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

const LIVE = 'AKfycbyweMtzB7WrgSSzwBczduVaOAZ5dfYHLXBlJoUCU5bj7cU08IzLRfv7r2UpbJsAQyGs';

assert('staff page has robots noindex', /<meta\s+name=["']robots["']\s+content=["']noindex/i.test(staffHtml));
assert('staff page uses the live Sheets URL', staffHtml.includes(LIVE));
assert('staff page has no WhatsApp links', !/whatsapp|wa\.me/i.test(fs.readFileSync(PUBLIC + '/staff.html', 'utf8')));
assert('admin.html links to Staff mode', /href=["']staff\.html["']/.test(adminHtml) && /Staff mode/.test(adminHtml));
assert('index.html does not link to staff.html', !/staff\.html/.test(fs.readFileSync(PUBLIC + '/index.html', 'utf8')));
assert('PIN is stored in sessionStorage, not localStorage',
  staffHtml.includes("sessionStorage.setItem(PIN_KEY") &&
  !/localStorage\.setItem\(PIN_KEY/.test(staffHtml));
assert('outbox uses localStorage and retries',
  staffHtml.includes("localStorage.setItem(OUTBOX_KEY") &&
  /flushOutbox/.test(staffHtml) &&
  /nextAttemptAt/.test(staffHtml));
assert('orders auto-refresh every 30s', /REFRESH_MS = 30000/.test(staffHtml));
assert('search is debounced', /SEARCH_DEBOUNCE_MS/.test(staffHtml));
assert('tap targets are at least 44px',
  /min-h-12/.test(staffHtml) &&
  /Mark Paid/.test(staffHtml) &&
  /Picked up/.test(staffHtml));

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), type: opts.headers && opts.headers['Content-Type'], body });
    const result = typeof handler === 'function' ? await handler({ url, opts, body, calls }) : handler;
    return {
      ok: true,
      text: async () => JSON.stringify(result)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(15);
  }
  return pred();
}

function load(search, fetchImpl) {
  const errors = [];
  const virtualConsole = new JSDOM().virtualConsole.constructor
    ? undefined
    : undefined;
  const dom = new JSDOM(staffHtml, {
    url: 'https://parish.test/staff.html' + (search || ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      if (fetchImpl) window.fetch = fetchImpl;
      window.alert = () => {};
    }
  });
  return { dom, window: dom.window, document: dom.window.document };
}

async function loadPreview() {
  const page = load('?preview=1');
  const ok = await waitFor(() => {
    const api = page.window.__staff;
    return api && api.getState().unlocked && api.getState().orders.length > 0;
  });
  assert('preview boot unlocks and loads example orders', ok && page.window.__staff.getState().orders.length >= 3,
    ok ? JSON.stringify(page.window.__staff.getState().orders.map((o) => o.orderId)) : 'timeout');
  return page;
}

{
  const page = await loadPreview();
  const { document, window } = page;
  assert('preview hides the PIN gate', document.getElementById('pin-gate').hidden === true);
  assert('preview shows the example-data banner', document.body.classList.contains('is-preview'));
  const names = Array.from(document.querySelectorAll('.order-name')).map((el) => el.textContent);
  assert('order cards show buyer names', names.includes("Anita D'Souza") && names.includes('Cyril Martin'), names.join(','));
  const phone = document.querySelector('a.phone-link');
  assert('phone numbers are tappable tel: links', phone && /^tel:\+91/.test(phone.getAttribute('href')), phone && phone.getAttribute('href'));
  assert('Mark Paid and Picked up buttons are present',
    document.querySelector('[data-act="Paid"]') && document.querySelector('[data-act="Picked up"]'));
  const collect = document.getElementById('count-collect').textContent;
  const picked = document.getElementById('count-picked').textContent;
  const pending = document.getElementById('count-pending').textContent;
  assert('counters show to collect, picked up, and pending',
    Number(collect) >= 1 && Number(picked) >= 1 && Number(pending) >= 1,
    JSON.stringify({ collect, picked, pending }));

  const paidBtn = document.querySelector('[data-id="PB-261123-HVAB"][data-act="Paid"]');
  paidBtn.click();
  await sleep(30);
  const anita = window.__staff.getState().orders.find((o) => o.orderId === 'PB-261123-HVAB');
  assert('Mark Paid updates the order status', anita && anita.status === 'Paid', anita && anita.status);

  await window.__staff.setStatus('PB-261123-HVAB', 'Picked up');
  const after = window.__staff.getState().orders.find((o) => o.orderId === 'PB-261123-HVAB');
  assert('Picked up can follow Paid', after.status === 'Picked up');

  // Cancel confirm
  const more = document.querySelector('[data-menu="PB-261122-ABCD"]');
  more.click();
  const cancelBtn = document.querySelector('[data-act="Cancelled"][data-id="PB-261122-ABCD"]');
  cancelBtn.click();
  await sleep(20);
  assert('Cancel opens a confirm dialog', document.getElementById('confirm-modal').hidden === false);
  document.getElementById('confirm-yes').click();
  await sleep(30);
  const joseph = window.__staff.getState().orders.find((o) => o.orderId === 'PB-261122-ABCD');
  assert('confirming Cancel marks the order cancelled', joseph.status === 'Cancelled', joseph && joseph.status);

  await window.__staff.search('7793');
  await sleep(20);
  const listed = window.__staff.getState().orders;
  assert('search by last phone digits filters the list',
    listed.length === 1 && listed[0].name === 'Cyril Martin',
    JSON.stringify(listed.map((o) => o.name)));
  await window.__staff.search('');

  await window.__staff.setMass('06:30');
  assert('mass filter keeps 6:30 AM orders',
    window.__staff.getState().orders.every((o) => o.mass === '06:30'));
  await window.__staff.setMass('');

  await window.__staff.setTab('walkin');
  assert('walk-in tab is shown', document.getElementById('panel-walkin').hidden === false);
  assert('six priced item buttons are shown', document.querySelectorAll('#item-grid .item-btn').length === 6);
  window.__staff.setItem('Dates & Carrot Pudding (700g)');
  window.__staff.setQty(2);
  window.__staff.setPayment('UPI');
  assert('live amount updates with qty and item',
    document.getElementById('live-amount').textContent.replace(/\s/g, '').includes('1,300') ||
    document.getElementById('live-amount').textContent.includes('1300'),
    document.getElementById('live-amount').textContent);
  const liveSum = document.getElementById('live-summary').textContent;
  assert('live summary shows qty, item, payment and mass',
    liveSum.includes('2 ×') && liveSum.includes('Dates & Carrot Pudding (700g)') && liveSum.includes('UPI') && liveSum.includes('Mass'), liveSum);

  const custInput = document.getElementById('walkin-customer');
  assert('customer name field is an optional text input (maxlength 60, autocomplete off)',
    custInput && custInput.type === 'text' && custInput.maxLength === 60 && custInput.getAttribute('autocomplete') === 'off');
  custInput.value = '  Maria  ';
  custInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert('live summary shows the customer name', document.getElementById('live-summary').textContent.includes('for Maria'), document.getElementById('live-summary').textContent);
  const beforeWalk = window.__staff.getState().walkins.filter((w) => !w.voided).length;
  await window.__staff.addWalkin();
  assert('recorded walk-in carries the trimmed customer name',
    window.__staff.getState().walkins.some((w) => w.customer === 'Maria'), JSON.stringify(window.__staff.getState().walkins[0]));
  assert('Recent walk-ins card shows the customer name', document.getElementById('walkin-list').textContent.includes('Maria'));
  assert('customer field is cleared after a successful record', custInput.value === '' && window.__staff.getState().customer === '');
  const afterWalk = window.__staff.getState().walkins.filter((w) => !w.voided);
  const recorded = afterWalk.find((w) => w.payment === 'UPI' && w.amount === 1300);
  assert('recording a walk-in sale adds it to the recent list',
    afterWalk.length === beforeWalk + 1 && recorded,
    JSON.stringify(afterWalk));

  const newId = recorded && recorded.walkinId;
  await window.__staff.voidWalkin(newId);
  assert('undo voids the walk-in sale',
    !window.__staff.getState().walkins.filter((w) => !w.voided).some((w) => w.walkinId === newId));

  page.dom.window.close();
}

// PIN + fetch + optimistic conflict + outbox
{
  const store = {
    pin: '2468',
    orders: [
      { row: 2, orderId: 'PB-1', name: 'Anita DSouza', phone: '9876543210', mass: '06:30', pickupDate: '2026-11-29', items: '1 × Plum 400g', total: 350, status: 'Pending' },
      { row: 3, orderId: 'PB-2', name: 'Cyril Martin', phone: '7204017793', mass: '08:30', pickupDate: '2026-11-29', items: '1 × Dates 700g', total: 650, status: 'Paid' }
    ],
    walkins: []
  };
  let failNetwork = false;
  let conflictNext = false;
  const fetchImpl = makeFetch(({ body }) => {
    if (failNetwork) throw new Error('offline');
    if (body.action && body.action.indexOf('staff_') === 0) {
      if (!body.pin || body.pin !== store.pin) {
        return { ok: false, status: body.pin ? 'unauthorized' : 'unauthorized', error: 'Wrong PIN.' };
      }
    }
    if (body.action === 'staff_login') return { ok: true, status: 'ok', version: '2026-11-23.11' };
    if (body.action === 'staff_orders') {
      return { ok: true, pickupDate: '2026-11-29', orders: store.orders.map((o) => Object.assign({}, o)), counts: { toCollect: 1, toCollectAmount: 350, pickedUp: 0, pending: 2 }, dates: [{ id: '2026-11-29', label: 'Sun, 29 Nov' }] };
    }
    if (body.action === 'staff_set_status') {
      const order = store.orders.find((o) => o.orderId === body.orderId);
      if (conflictNext) {
        conflictNext = false;
        return { ok: false, status: 'conflict', currentStatus: order.status, error: 'Status changed' };
      }
      if (body.expectedStatus && order.status !== body.expectedStatus) {
        return { ok: false, status: 'conflict', currentStatus: order.status, error: 'Status changed' };
      }
      order.status = body.status;
      return { ok: true, status: order.status, orderId: order.orderId };
    }
    if (body.action === 'staff_walkins') return { ok: true, date: '2026-11-29', walkins: store.walkins.slice() };
    if (body.action === 'staff_add_walkin') {
      const row = { walkinId: body.walkinId, date: body.date, mass: body.mass, item: body.item, qty: body.qty, amount: 650, payment: body.payment, customer: body.customer || '', voided: false };
      store.walkins.unshift(row);
      return Object.assign({ ok: true }, row);
    }
    if (body.action === 'staff_delete_walkin') {
      const row = store.walkins.find((w) => w.walkinId === body.walkinId);
      if (row) row.voided = true;
      return { ok: true, walkinId: body.walkinId, voided: true };
    }
    return { ok: false, error: 'unknown' };
  });

  const page = load('', fetchImpl);
  const { document, window } = page;
  const gateReady = await waitFor(() => document.getElementById('pin-gate') && !document.getElementById('pin-gate').hidden);
  assert('PIN screen is shown when the session has no PIN', gateReady && document.getElementById('pin-gate').hidden === false);

  const bad = await window.__staff.login('1111');
  assert('wrong PIN stays on the gate and shows an error',
    bad.ok === false &&
    document.getElementById('pin-gate').hidden === false &&
    document.getElementById('pin-error').textContent.toLowerCase().indexOf('wrong') !== -1,
    document.getElementById('pin-error').textContent);
  assert('wrong PIN does not put the PIN in sessionStorage',
    window.sessionStorage.getItem('poppinsStaffPin') == null || window.sessionStorage.getItem('poppinsStaffPin') === '');

  const good = await window.__staff.login('2468');
  assert('correct PIN unlocks the desk', good.ok === true && document.getElementById('pin-gate').hidden === true);
  assert('PIN is kept only in sessionStorage',
    window.sessionStorage.getItem('poppinsStaffPin') === '2468' &&
    window.localStorage.getItem('poppinsStaffPin') == null);
  assert('staff POSTs are text/plain JSON and include the PIN',
    fetchImpl.calls.some((c) => c.type === 'text/plain' && c.body.action === 'staff_login' && c.body.pin === '2468' && c.body.clientToken),
    JSON.stringify(fetchImpl.calls[0]));
  assert('orders load after login', window.__staff.getState().orders.length === 2);

  // Optimistic + conflict rollback
  const firstStatus = window.__staff.getState().orders[0].status;
  conflictNext = true;
  const conflict = await window.__staff.setStatus('PB-1', 'Paid');
  assert('conflict is reported by staff_set_status', conflict && conflict.status === 'conflict');
  const rolled = window.__staff.getState().orders.find((o) => o.orderId === 'PB-1');
  assert('conflict rolls the card back to the server status',
    rolled.status === firstStatus,
    rolled.status);

  // Outbox when offline
  failNetwork = true;
  const queued = await window.__staff.setStatus('PB-1', 'Paid');
  assert('offline status change is queued in the outbox',
    queued.queued === true &&
    window.__staff.getState().outbox.some((e) => e.type === 'status' && e.orderId === 'PB-1'),
    JSON.stringify(window.__staff.getState().outbox));
  assert('optimistic UI still shows Paid while queued',
    window.__staff.getState().orders.find((o) => o.orderId === 'PB-1').status === 'Paid' ||
    window.__staff.getState().orders.find((o) => o.orderId === 'PB-1')._queued,
    JSON.stringify(window.__staff.getState().orders[0]));

  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(30);
  assert('outbox retries and clears after a successful POST',
    !window.__staff.getState().outbox.some((e) => e.type === 'status' && e.orderId === 'PB-1'),
    JSON.stringify(window.__staff.getState().outbox));
  assert('server status is Paid after the retry',
    store.orders.find((o) => o.orderId === 'PB-1').status === 'Paid');
  failNetwork = true;
  window.__staff.setItem('Rich Plum Cake (400g)');
  await window.__staff.addWalkin({ customer: 'Joseph' });
  const wEntry = window.__staff.getState().outbox.find((e) => e.type === 'walkin');
  assert('offline walk-in outbox entry keeps the customer', wEntry && wEntry.payload.customer === 'Joseph', JSON.stringify(wEntry));
  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(30);
  assert('queued walk-in is sent with the customer name', store.walkins.some((w) => w.customer === 'Joseph'), JSON.stringify(store.walkins));

  window.__staff.logout();
  assert('Lock clears the session PIN and shows the gate again',
    window.sessionStorage.getItem('poppinsStaffPin') == null &&
    document.getElementById('pin-gate').hidden === false);

  page.dom.window.close();
}

{
  const html = (await import('node:fs')).readFileSync(new URL('../public/staff.html', import.meta.url), 'utf8');
  assert('uses Tailwind (stylesheet linked, no big inline <style>)', html.includes('href="/tailwind.css"') && !/\.order-card\s*\{/.test(html));
  assert('desktop layout: wide container at 720px+', html.includes('min-[720px]:max-w-[1100px]'));
  assert('desktop layout: order cards grid 2 then 3 columns',
    /id="order-list"/.test(html) && html.includes('min-[720px]:grid-cols-2') && html.includes('min-[1000px]:grid-cols-3'));
  assert('desktop layout: walk-in form and list columns',
    /walkin-form">[\s\S]*id="record-sale"[\s\S]*<\/div>\s*<div class="walkin-side">[\s\S]*id="walkin-list"/.test(html));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
