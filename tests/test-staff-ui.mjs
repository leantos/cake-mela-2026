import { readPage, CODE_GS, ROOT, PUBLIC } from './helpers.mjs';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const staffHtml = readPage('staff.html');
const ordersHtml = readPage('orders.html');
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
assert('orders.html links to Staff mode', /href=["']staff\.html["']/.test(ordersHtml) && /Staff mode/.test(ordersHtml));
assert('staff.html links to the Orders page', /class="orders-link[^"]*"[^>]*href="orders\.html"[^>]*>Orders</.test(readPage('staff.html')));
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

function load(search, fetchImpl, now) {
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
      window.__TEST_NOW = now || new Date(2026, 10, 24, 10, 0, 0);
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

  assert('no Mass filter chips and no Mass select exist',
    !document.getElementById('mass-chips') && !document.getElementById('walkin-mass') &&
    typeof window.__staff.setMass === 'undefined' && !('mass' in window.__staff.getState()));
  assert('order cards no longer show a Mass time', !/Mass/.test(document.getElementById('order-list') ? document.getElementById('order-list').textContent : document.body.textContent));
  assert('page is branded Vailankanni Matha Youth (title, heading, logo alt)',
    document.title.includes('Vailankanni Matha Youth') && !document.documentElement.outerHTML.includes('Parish Youth') &&
    document.querySelector('h1').textContent.includes('Vailankanni Matha Youth') &&
    document.querySelector('header img').alt.includes('Vailankanni Matha Youth'));

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
  assert('live summary shows qty, item and payment (no Mass)',
    liveSum.includes('2 ×') && liveSum.includes('Dates & Carrot Pudding (700g)') && liveSum.includes('UPI') && !liveSum.includes('Mass'), liveSum);

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

  // ---- Recent walk-ins lives in its own third tab ----
  const tabEls = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'));
  assert('three tabs: Orders, Walk-in sale, Recent walk-ins',
    tabEls.map((t) => t.id).join(',') === 'tab-orders,tab-walkin,tab-recent' && /Recent/.test(document.getElementById('tab-recent').textContent));
  assert('tab bar has 3 equal columns', document.querySelector('[role="tablist"]').className.includes('grid-cols-3'));
  assert('walk-in list lives in the Recent panel, not the Walk-in panel',
    document.getElementById('panel-recent').contains(document.getElementById('walkin-list')) &&
    !document.getElementById('panel-walkin').contains(document.getElementById('walkin-list')) &&
    document.getElementById('panel-recent').contains(document.getElementById('walkin-updated')));
  assert('Recent tab has its own date chips', document.querySelectorAll('#recent-date-chips [data-date]').length >= 1);
  await window.__staff.setTab('recent');
  assert('Recent tab shows its panel and hides the others',
    document.getElementById('panel-recent').hidden === false &&
    document.getElementById('panel-walkin').hidden === true &&
    document.getElementById('panel-orders').hidden === true &&
    document.getElementById('tab-recent').getAttribute('aria-selected') === 'true' &&
    document.getElementById('tab-walkin').getAttribute('aria-selected') === 'false');
  await window.__staff.setTab('walkin');
  assert('Walk-in tab hides the Recent panel',
    document.getElementById('panel-recent').hidden === true && document.getElementById('panel-walkin').hidden === false);
  window.__staff.setItem('Rich Plum Cake (400g)'); window.__staff.setQty(1);
  const recentBefore = window.__staff.getState().walkins.filter((w) => !w.voided).length;
  await window.__staff.addWalkin();
  await window.__staff.setTab('recent');
  const recentRows = window.__staff.getState().walkins.filter((w) => !w.voided);
  assert('a sale recorded on the Walk-in tab appears in the Recent panel list',
    recentRows.length === recentBefore + 1 && document.querySelectorAll('#panel-recent #walkin-list [data-walkin]').length === recentRows.length);
  const badge = document.getElementById('recent-count');
  assert('Recent tab shows a count badge of walk-ins',
    badge.textContent === String(recentRows.length) && !badge.classList.contains('hidden'), badge.textContent);
  const lastId = recentRows[0].walkinId;
  await window.__staff.voidWalkin(lastId);
  assert('undo from the Recent list removes the card and updates the badge',
    !document.querySelector('#walkin-list [data-walkin="' + lastId + '"]') &&
    document.getElementById('recent-count').textContent === String(recentRows.length - 1));
  await window.__staff.setTab('walkin');

  // ---- cart: per-pill steppers, many cakes in one sale ----
  const DATES = 'Dates & Carrot Pudding (700g)';
  const PLUM = 'Rich Plum Cake (400g)';
  const pillOf = (name) => Array.from(document.querySelectorAll('#item-grid [data-item]')).find((el) => el.getAttribute('data-item') === name);
  const tap = (name, act) => { const all = pillOf(name).querySelectorAll('[data-act="' + act + '"]'); all[all.length - 1].click(); };
  const flat = (el) => el.textContent.replace(/[\s,]/g, '');
  window.__staff.setItem(DATES); window.__staff.setQty(0); // clear the cart
  assert('cart starts empty: Record disabled and preview prompts',
    document.getElementById('record-sale').disabled === true && document.getElementById('live-summary').textContent.includes('Pick a cake to start'));
  assert('every cake pill has its own - and + buttons and a quantity (>=48px targets)',
    Array.from(document.querySelectorAll('#item-grid [data-item]')).every((el) =>
      el.querySelector('[data-act="dec"]') && el.querySelector('[data-act="inc"]') && el.querySelector('.item-qty') &&
      el.querySelector('[data-act="dec"]').className.includes('size-12') && Array.from(el.querySelectorAll('[data-act="inc"]')).pop().className.includes('size-12')));
  assert('- is disabled while a cake is at 0', pillOf(DATES).querySelector('[data-act="dec"]').disabled === true);
  tap(DATES, 'inc'); tap(DATES, 'inc'); tap(PLUM, 'inc');
  assert('tapping + on two cakes puts both in the sale',
    window.__staff.getCart().length === 2 && pillOf(DATES).querySelector('.item-qty').textContent === '2' && pillOf(DATES).getAttribute('data-on') === 'true',
    JSON.stringify(window.__staff.getCart()));
  const prev = document.getElementById('live-summary').textContent;
  assert('preview lists every line and the total is the sum',
    prev.includes('2 × ' + DATES) && prev.includes('1 × ' + PLUM) && flat(document.getElementById('live-amount')).includes('1650'), prev);
  tap(PLUM, 'dec');
  assert('- takes a cake all the way back to 0 and out of the sale',
    window.__staff.getCart().length === 1 && pillOf(PLUM).getAttribute('data-on') === 'false' && pillOf(PLUM).querySelector('[data-act="dec"]').disabled === true);
  tap(DATES, 'dec'); tap(DATES, 'dec');
  assert('removing every cake empties the sale and disables Record',
    window.__staff.getCart().length === 0 && document.getElementById('record-sale').disabled === true);
  const emptyTry = await window.__staff.addWalkin();
  assert('recording an empty cart does nothing', emptyTry.ok === false);

  tap(DATES, 'inc'); tap(PLUM, 'inc'); tap(PLUM, 'inc');
  const cust2 = document.getElementById('walkin-customer');
  cust2.value = 'Ravi';
  cust2.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert('preview shows payment and customer for the whole sale (no Mass)',
    /UPI · for Ravi/.test(document.getElementById('live-meta').textContent), document.getElementById('live-meta').textContent);
  const beforeCart = window.__staff.getState().walkins.filter((w) => !w.voided).length;
  document.getElementById('record-sale').click();
  await waitFor(() => window.__staff.getState().walkins.filter((w) => !w.voided).length === beforeCart + 2);
  const cartRows = window.__staff.getState().walkins.filter((w) => w.customer === 'Ravi');
  assert('Record posts one walk-in per cake line with unique ids',
    cartRows.length === 2 && new Set(cartRows.map((w) => w.walkinId)).size === 2 &&
    cartRows.some((w) => w.item === DATES && w.qty === 1) && cartRows.some((w) => w.item === PLUM && w.qty === 2), JSON.stringify(cartRows));
  assert('both lines share the same payment and customer', cartRows.every((w) => w.payment === 'UPI' && w.customer === 'Ravi'));
  assert('sale is cleared after recording (cart and customer)',
    window.__staff.getCart().length === 0 && cust2.value === '' && document.getElementById('record-sale').disabled === true);
  await waitFor(() => document.getElementById('toasts').textContent.includes('items recorded'));
  assert('a toast says how many items were recorded', document.getElementById('toasts').textContent.includes('2 items recorded'), document.getElementById('toasts').textContent);

  page.dom.window.close();
}

// PIN + fetch + optimistic conflict + outbox
{
  const store = {
    pin: '2468',
    orders: [
      { row: 2, orderId: 'PB-1', name: 'Anita DSouza', phone: '9876543210', pickupDate: '2026-11-29', items: '1 × Plum 400g', total: 350, status: 'Pending' },
      { row: 3, orderId: 'PB-2', name: 'Cyril Martin', phone: '7204017793', pickupDate: '2026-11-29', items: '1 × Dates 700g', total: 650, status: 'Paid' }
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
      const row = { walkinId: body.walkinId, date: body.date, item: body.item, qty: body.qty, amount: 650, payment: body.payment, customer: body.customer || '', voided: false };
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

  // multi-cake sale recorded offline: every line is queued once, then sent exactly once
  failNetwork = true;
  window.__staff.setItem('Rich Plum Cake (400g)');
  window.__staff.setLineQty('Butterscotch Pudding (350g)', 2);
  await window.__staff.addWalkin({ customer: 'Offline Olga' });
  const queued2 = window.__staff.getState().outbox.filter((e) => e.type === 'walkin' && e.payload.customer === 'Offline Olga');
  assert('offline multi-cake sale queues one outbox entry per line with unique ids',
    queued2.length === 2 && new Set(queued2.map((e) => e.payload.walkinId)).size === 2, JSON.stringify(queued2));
  assert('the cart is cleared once the lines are safely queued (no double-recording)', window.__staff.getCart().length === 0);
  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(30);
  const sent2 = store.walkins.filter((w) => w.customer === 'Offline Olga');
  assert('queued lines are each sent once when back online', sent2.length === 2 && new Set(sent2.map((w) => w.walkinId)).size === 2, JSON.stringify(sent2));


  // ---- cash change calculator ----
  window.__staff.setItem('Dates & Carrot Pudding (700g)'); // 650
  window.__staff.setLineQty('Rich Plum Cake (400g)', 1);   // 350 -> total 1000
  window.__staff.setPayment('Cash');
  const cdoc = window.document;
  const panelEl = () => cdoc.getElementById('cash-panel');
  const resultEl = () => cdoc.getElementById('cash-result');
  const digits = (t) => Number(String(t).replace(/[^0-9]/g, ''));
  assert('cash panel is shown for Cash with items in the cart', panelEl().classList.contains('hidden') === false);
  assert('cash panel has the numeric Amount received field',
    cdoc.getElementById('cash-received').getAttribute('inputmode') === 'numeric' &&
    cdoc.getElementById('cash-received').getAttribute('maxlength') === '6');
  assert('no result shown while the amount is empty', resultEl().textContent === '' && resultEl().classList.contains('hidden'));
  cdoc.querySelector('#cash-quick [data-cash="500"]').click();
  assert('quick button fills the field', cdoc.getElementById('cash-received').value === '500');
  assert('amount below the total shows "Short by" with the shortfall',
    /Short by/.test(resultEl().textContent) && digits(resultEl().textContent) === 500, resultEl().textContent);
  cdoc.querySelector('#cash-quick [data-cash="2000"]').click();
  assert('amount above the total shows the change to give',
    /Change to give/.test(resultEl().textContent) && digits(resultEl().textContent) === 1000, resultEl().textContent);
  cdoc.querySelector('#cash-quick [data-cash="exact"]').click();
  assert('Exact fills the sale total and shows change ₹0',
    cdoc.getElementById('cash-received').value === '1000' && /Change to give/.test(resultEl().textContent) && digits(resultEl().textContent) === 0, resultEl().textContent);
  const typed = cdoc.getElementById('cash-received');
  typed.value = '12a3456789';
  typed.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert('typed amount keeps digits only, max 6', window.__staff.getState().received === '123456', window.__staff.getState().received);
  window.__staff.setPayment('UPI');
  assert('cash panel is hidden for UPI and the amount is cleared',
    panelEl().classList.contains('hidden') && window.__staff.getState().received === '');
  window.__staff.setPayment('Cash');
  assert('switching back to Cash starts with an empty amount', cdoc.getElementById('cash-received').value === '');

  // note saved on the FIRST line only, when the amount covers the total (recorded offline -> outbox)
  failNetwork = true;
  window.__staff.setReceived(2000);
  await window.__staff.addWalkin({ customer: 'Cash Carl' });
  const cashQ = window.__staff.getState().outbox.filter((e) => e.type === 'walkin' && e.payload.customer === 'Cash Carl');
  const withNote = cashQ.filter((e) => e.payload.notes);
  assert('two-line cash sale queues two entries and only the first has the note',
    cashQ.length === 2 && withNote.length === 1 && cashQ[0].payload.notes === withNote[0].payload.notes, JSON.stringify(cashQ.map((e) => e.payload.notes)));
  assert('note records received, change and the sale total',
    /Cash received ₹2,000, change ₹1,000 \(sale total ₹1,000\)/.test(withNote[0].payload.notes), withNote[0].payload.notes);
  assert('note does not start with VOID', !/^\s*VOID/i.test(withNote[0].payload.notes));
  assert('Recent walk-ins card shows the note', cdoc.querySelectorAll('#walkin-list .walkin-notes').length === 1 &&
    /Cash received/.test(cdoc.querySelector('#walkin-list .walkin-notes').textContent));
  assert('the amount field is reset after recording', window.__staff.getState().received === '' && cdoc.getElementById('cash-received').value === '');
  assert('the cash panel hides once the cart is empty', panelEl().classList.contains('hidden'));
  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(30);

  // empty amount -> no note; short amount -> no note
  failNetwork = true;
  window.__staff.setItem('Rich Plum Cake (400g)');
  await window.__staff.addWalkin({ customer: 'No Note Nina' });
  window.__staff.setItem('Rich Plum Cake (400g)');
  window.__staff.setReceived(100);
  await window.__staff.addWalkin({ customer: 'Short Sam' });
  const plain = window.__staff.getState().outbox.filter((e) => e.type === 'walkin' && ['No Note Nina', 'Short Sam'].includes(e.payload.customer));
  assert('no note when no amount was entered or when the amount is short',
    plain.length === 2 && plain.every((e) => !e.payload.notes), JSON.stringify(plain.map((e) => e.payload.notes)));
  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(30);

  window.__staff.logout();
  assert('Lock clears the session PIN and shows the gate again',
    window.sessionStorage.getItem('poppinsStaffPin') == null &&
    document.getElementById('pin-gate').hidden === false);

  page.dom.window.close();
}

{
  const page = load('?preview=1&tab=recent');
  const ok = await waitFor(() => {
    const api = page.window.__staff;
    return api && api.getState().unlocked && api.getState().walkins.length > 0;
  });
  const d = page.document;
  assert('?tab=recent opens the Recent walk-ins tab with the list loaded',
    ok && page.window.__staff.getState().tab === 'recent' &&
    d.getElementById('panel-recent').hidden === false && d.getElementById('panel-walkin').hidden === true &&
    d.querySelectorAll('#walkin-list [data-walkin]').length >= 1);
  page.window.close();
}

{
  const html = (await import('node:fs')).readFileSync(new URL('../public/staff.html', import.meta.url), 'utf8');
  assert('uses Tailwind (stylesheet linked, no big inline <style>)', html.includes('href="/tailwind.css"') && !/\.order-card\s*\{/.test(html));
  assert('desktop layout: full-width container (no max-width cap)', !html.includes('min-[720px]:max-w-[1100px]') && /<div class="flex min-h-dvh w-full flex-col/.test(html));
  assert('desktop layout: order cards grid 2 then 3 columns',
    /id="order-list"/.test(html) && html.includes('min-[720px]:grid-cols-2') && html.includes('min-[1000px]:grid-cols-3'));
  assert('desktop layout: cake grid on the left, sticky preview on the right',
    /walkin-form[^"]*">[\s\S]*id="item-grid"[\s\S]*<div class="walkin-side [^"]*min-\[720px\]:sticky[^"]*">[\s\S]*id="live-summary"[\s\S]*id="record-sale"/.test(html));
  assert('Recent walk-ins is a separate third tab panel after the Walk-in panel',
    /id="panel-walkin"[\s\S]*id="record-sale"[\s\S]*id="panel-recent"[\s\S]*id="walkin-list"/.test(html) &&
    !/id="panel-walkin"[^]*?id="walkin-list"[^]*?id="panel-recent"/.test(html));
  assert('single global Quantity control is gone (steppers live on the cake pills)',
    !html.includes('id="qty"') && !html.includes('id="qty-plus"') && !html.includes('id="qty-minus"'));
}


// ---- auto date default from the browser clock ----
{
  const D = (y, m, d, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi, 0);
  async function boot(search, now) {
    const pg = load('?preview=1' + (search || ''), null, now);
    await waitFor(() => pg.window.__staff && pg.window.__staff.getState().unlocked);
    await sleep(40);
    return pg;
  }
  const pressed = (pg, id) => Array.from(pg.document.querySelectorAll('#' + id + ' [aria-pressed="true"]')).map((b) => b.getAttribute('data-date'));

  let pg = await boot('', D(2026, 12, 6));
  assert('today is a pickup date -> it is selected',
    pg.window.__staff.getState().pickupDate === '2026-12-06', pg.window.__staff.getState().pickupDate);
  assert('all three date chip rows highlight the same selected date',
    ['date-chips', 'walkin-date-chips', 'recent-date-chips'].every((id) => pressed(pg, id).join() === '2026-12-06'));
  pg.window.close();

  pg = await boot('', D(2026, 12, 2));
  assert('between pickup dates -> the next upcoming date is selected', pg.window.__staff.getState().pickupDate === '2026-12-06');
  pg.window.close();

  pg = await boot('', D(2027, 1, 5));
  assert('after the last pickup date -> the last one is selected', pg.window.__staff.getState().pickupDate === '2026-12-20');
  pg.window.close();

  pg = await boot('&date=2026-12-13', D(2026, 12, 6));
  assert('an explicit ?date= wins over the clock', pg.window.__staff.getState().pickupDate === '2026-12-13');
  pg.window.close();

  pg = await boot('', D(2026, 12, 6, 6, 0));
  assert('there is no Mass select for the clock to change',
    !pg.document.getElementById('walkin-mass') && !('walkinMass' in pg.window.__staff.getState()));
  pg.window.close();

  // a manual date pick is not overridden when the tab becomes visible on a new day
  pg = await boot('', D(2026, 11, 24, 6, 0));
  assert('first load on 24 Nov picks the next upcoming date', pg.window.__staff.getState().pickupDate === '2026-11-29');
  pg.document.querySelector('#date-chips [data-date="2026-12-13"]').click();
  pg.window.__TEST_NOW = D(2026, 12, 6, 6, 0);
  pg.window.__staff.onBecameVisible();
  assert('a manually picked date is not overridden on a new day', pg.window.__staff.getState().pickupDate === '2026-12-13');
  pg.window.close();

  // untouched page re-evaluates when the local day changes
  pg = await boot('', D(2026, 11, 24, 10, 0));
  pg.window.__TEST_NOW = D(2026, 12, 6, 6, 30);
  pg.window.__staff.onBecameVisible();
  await sleep(40);
  assert('an untouched page re-selects today when the day changes', pg.window.__staff.getState().pickupDate === '2026-12-06');
  pg.window.close();
}

// ---- Recent walk-ins: time+name pill, search, grouping, Undo all; Clear all ----
{
  const page = await loadPreview();
  const { document, window } = page;
  const S = window.__staff;
  const clock = (iso) => {
    const d = new Date(iso);
    const h = d.getHours();
    return (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
  };
  const cards = () => Array.from(document.querySelectorAll('#walkin-list article'));
  const cardFor = (name) => cards().find((c) => (c.querySelector('.walkin-customer') || {}).textContent === name);

  await S.setTab('recent');
  await waitFor(() => cards().length >= 2);
  assert('recent: search box exists in the Recent panel',
    document.getElementById('panel-recent').contains(document.getElementById('recent-search')) &&
    document.getElementById('recent-search').type === 'search');
  assert('recent: unnamed legacy sales stay separate cards (one per sale)', cards().length === 2, String(cards().length));
  const demoPill = cards()[0].querySelector('.walkin-pill');
  assert('recent: the pill shows the time recorded (local 12-hour) and Walk-in when unnamed',
    /\d{1,2}:\d{2} (AM|PM)/.test(demoPill.textContent) && /Walk-in/.test(demoPill.textContent), demoPill.textContent);
  assert('recent: the time comes from recordedAt',
    cards().some((c) => c.textContent.includes(clock('2026-11-29T03:35:00.000Z'))) &&
    cards().some((c) => c.textContent.includes(clock('2026-11-29T04:05:00.000Z'))));
  assert('recent: the newest sale is listed first',
    cards()[0].textContent.includes(clock('2026-11-29T04:05:00.000Z')));

  // record: Maria with two cakes, then "maria" (case-insensitive) with one more, then an unnamed 2-cake sale
  await S.setTab('walkin');
  S.setLineQty('Dates & Carrot Pudding (700g)', 1);
  S.setLineQty('Rich Plum Cake (400g)', 2);
  await S.addWalkin({ customer: 'Maria' });
  S.setLineQty('Butterscotch Pudding (350g)', 1);
  await S.addWalkin({ customer: 'maria' });
  S.setLineQty('Rich Plum Cake (800g)', 1);
  S.setLineQty('Dates & Carrot Pudding (350g)', 3);
  await S.addWalkin({});
  await S.setTab('recent');
  await waitFor(() => cards().length === 4);
  const maria = cardFor('Maria');
  assert('recent: lines for the same customer (case-insensitive) merge into ONE card',
    cards().length === 4 && maria && maria.querySelectorAll('li[data-walkin]').length === 3 &&
    cards().filter((c) => /maria/i.test((c.querySelector('.walkin-customer') || {}).textContent || '')).length === 1,
    String(cards().length));
  const mariaTotal = Number(maria.querySelector('.walkin-total').textContent.replace(/[^\d]/g, ''));
  assert('recent: the merged card total = 650 + 2x350 + 350', mariaTotal === 650 + 700 + 350, String(mariaTotal));
  const unnamed = cards().find((c) => /Walk-in/.test(c.querySelector('.walkin-pill').textContent) && c.querySelectorAll('li[data-walkin]').length === 2);
  assert('recent: an unnamed multi-cake sale is ONE card of its own lines', !!unnamed);
  assert('recent: the badge counts cards (customers/sales), not lines',
    document.getElementById('recent-count').textContent === '4' && document.querySelectorAll('#walkin-list li[data-walkin]').length === 7);
  assert('recent: lines of one sale share a sale-id prefix and one recordedAt',
    (() => {
      const lines = S.getState().walkins.filter((w) => !w.voided && w.customer === 'Maria');
      const first = lines.filter((w) => /^WI-[A-Z0-9]+-[A-Z0-9]+-\d+$/.test(w.walkinId));
      const byBase = {};
      first.forEach((w) => { (byBase[w.walkinId.split('-').slice(0, 3).join('-')] = byBase[w.walkinId.split('-').slice(0, 3).join('-')] || []).push(w); });
      return Object.values(byBase).some((g) => g.length === 2 && g[0].recordedAt && g[0].recordedAt === g[1].recordedAt && !isNaN(new Date(g[0].recordedAt)));
    })());
  assert('recent: a just-recorded sale has a time in its pill', /\d{1,2}:\d{2} (AM|PM)/.test(maria.querySelector('.walkin-pill').textContent) && /Maria/.test(maria.querySelector('.walkin-pill').textContent));

  // search
  const search = document.getElementById('recent-search');
  const type = (v) => { search.value = v; search.dispatchEvent(new window.Event('input', { bubbles: true })); };
  type('maria');
  assert('recent search: filters by customer name', cards().length === 1 && /Maria/.test(cards()[0].textContent));
  type('BUTTERSCOTCH');
  assert('recent search: matches cake names case-insensitively', cards().length === 1 && /Maria/.test(cards()[0].textContent));
  type('upi');
  assert('recent search: matches the payment', cards().length >= 1 && cards().every((c) => /UPI/.test(c.textContent)));
  type('zzzz-nothing');
  assert('recent search: shows a No matches state', cards().length === 0 && /No matches/.test(document.getElementById('walkin-list').textContent));
  assert('recent search: the clear button appears and the badge still counts all cards',
    !document.getElementById('recent-search-clear').classList.contains('hidden') && document.getElementById('recent-count').textContent === '4');
  document.getElementById('recent-search-clear').click();
  assert('recent search: clear resets the query and shows every card', search.value === '' && cards().length === 4);

  // undo one line vs Undo all
  const mariaLine = cardFor('Maria').querySelector('li[data-walkin] [data-undo]');
  mariaLine.click();
  await sleep(40);
  assert('recent: Undo on a line removes only that line',
    cardFor('Maria') && cardFor('Maria').querySelectorAll('li[data-walkin]').length === 2 && cards().length === 4);
  const undoAllBtn = cardFor('Maria').querySelector('[data-undo-all]');
  assert('recent: cards with 2+ lines have an Undo all button', !!undoAllBtn);
  undoAllBtn.click();
  await waitFor(() => !cardFor('Maria'));
  assert('recent: Undo all voids every line of the card and the badge drops to 3',
    !cardFor('Maria') && cards().length === 3 && document.getElementById('recent-count').textContent === '3');
  const single = cards().find((c) => c.querySelectorAll('li[data-walkin]').length === 1);
  assert('recent: single-line cards do not show Undo all', !!single && !single.querySelector('[data-undo-all]'));
  window.close();
}

// ---- recordedAt travels in the payload and survives the outbox ----
{
  const store = { pin: '2468', walkins: [] };
  let failNetwork = false;
  const fetchImpl = makeFetch(({ body }) => {
    if (body.action === 'staff_login') return { ok: true, status: 'ok', version: 'x' };
    if (failNetwork) throw new Error('offline');
    if (body.action === 'staff_orders') return { ok: true, pickupDate: '2026-11-29', orders: [], counts: { toCollect: 0, toCollectAmount: 0, pickedUp: 0, pending: 0 }, dates: [{ id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30' }] };
    if (body.action === 'staff_walkins') return { ok: true, date: '2026-11-29', walkins: store.walkins.slice() };
    if (body.action === 'staff_add_walkin') {
      const row = { walkinId: body.walkinId, date: body.date, item: body.item, qty: body.qty, amount: 650, payment: body.payment, customer: body.customer || '', recordedAt: body.recordedAt, voided: false };
      store.walkins.unshift(row);
      return Object.assign({ ok: true }, row);
    }
    return { ok: false, error: 'unknown' };
  });
  const page = load('', fetchImpl);
  const { window } = page;
  await waitFor(() => page.document.getElementById('pin-gate') && !page.document.getElementById('pin-gate').hidden);
  await window.__staff.login('2468');
  await window.__staff.setTab('walkin');
  window.__staff.setLineQty('Dates & Carrot Pudding (700g)', 1);
  window.__staff.setLineQty('Rich Plum Cake (400g)', 1);
  const before = Date.now();
  await window.__staff.addWalkin({ customer: 'Online Olive' });
  const adds = fetchImpl.calls.filter((c) => c.body.action === 'staff_add_walkin');
  assert('recordedAt: every line of a sale posts the same ISO recordedAt',
    adds.length === 2 && adds[0].body.recordedAt === adds[1].body.recordedAt &&
    !isNaN(new Date(adds[0].body.recordedAt)) && new Date(adds[0].body.recordedAt).toISOString() === adds[0].body.recordedAt &&
    new Date(adds[0].body.recordedAt).getTime() >= before - 1000, JSON.stringify(adds.map((c) => c.body.recordedAt)));

  failNetwork = true;
  window.__staff.setLineQty('Rich Plum Cake (800g)', 1);
  window.__staff.setLineQty('Butterscotch Pudding (700g)', 1);
  await window.__staff.addWalkin({ customer: 'Offline Otto' });
  const q = window.__staff.getState().outbox.filter((e) => e.type === 'walkin' && e.payload.customer === 'Offline Otto');
  assert('recordedAt: queued (offline) lines keep their true time in the outbox',
    q.length === 2 && q[0].payload.recordedAt && q[0].payload.recordedAt === q[1].payload.recordedAt, JSON.stringify(q.map((e) => e.payload.recordedAt)));
  assert('recordedAt: an offline sale shows as ONE queued card with its time',
    (() => {
      const cs = Array.from(page.document.querySelectorAll('#walkin-list article')).filter((c) => /Offline Otto/.test(c.textContent));
      return cs.length === 1 && cs[0].querySelectorAll('li[data-walkin]').length === 2 && /Queued/.test(cs[0].textContent) && /\d{1,2}:\d{2} (AM|PM)/.test(cs[0].textContent);
    })());
  failNetwork = false;
  await window.__staff.flushOutbox({ force: true });
  await sleep(40);
  const sent = fetchImpl.calls.filter((c) => c.body.action === 'staff_add_walkin' && c.body.customer === 'Offline Otto');
  assert('recordedAt: the retry posts the original recordedAt', sent.length >= 2 && sent.every((c) => c.body.recordedAt === q[0].payload.recordedAt));
  window.close();
}

// ---- Clear all ----
{
  const page = await loadPreview();
  const { document, window } = page;
  const S = window.__staff;
  await S.setTab('walkin');
  const clearBtn = document.getElementById('clear-sale');
  assert('clear all: the button is in the preview panel next to Record sale, >=48px',
    document.getElementById('walkin-preview').contains(clearBtn) && /min-h-12/.test(clearBtn.className) && /Clear all/.test(clearBtn.textContent) &&
    clearBtn.parentElement === document.getElementById('record-sale').parentElement);
  assert('clear all: disabled when there is nothing to clear', clearBtn.disabled === true);

  const dateBefore = S.getState().pickupDate;
  const recordedBefore = S.getState().walkins.length;
  const outboxBefore = S.getState().outbox.length;
  S.setLineQty('Dates & Carrot Pudding (700g)', 2);
  S.setLineQty('Rich Plum Cake (400g)', 1);
  S.setPayment('UPI');
  const cust = document.getElementById('walkin-customer');
  cust.value = 'Clara';
  cust.dispatchEvent(new window.Event('input', { bubbles: true }));
  S.setPayment('Cash');
  S.setReceived(2000);
  S.setPayment('UPI');
  S.setReceived(500);
  assert('clear all: enabled once the form has anything in it', clearBtn.disabled === false);
  const snapReceived = S.getState().received;
  clearBtn.click();
  const st = S.getState();
  assert('clear all: empties the cart, name, amount received and resets payment to Cash',
    S.getCart().length === 0 && st.customer === '' && cust.value === '' && st.received === '' && st.payment === 'Cash' &&
    document.getElementById('pay-cash').getAttribute('aria-pressed') === 'true');
  assert('clear all: preview, total and Record button update',
    document.getElementById('record-sale').disabled === true && /0/.test(document.getElementById('live-amount').textContent) &&
    document.getElementById('cash-panel').classList.contains('hidden') && clearBtn.disabled === true);
  assert('clear all: every pill quantity is back to 0',
    Array.from(document.querySelectorAll('#item-grid .item-qty')).every((e) => e.textContent === '0'));
  assert('clear all: does not change the selected date or touch recorded walk-ins and the outbox',
    st.pickupDate === dateBefore && st.walkins.length === recordedBefore && st.outbox.length === outboxBefore);
  const toastEl = Array.from(document.querySelectorAll('#toasts > div')).find((t) => /Sale cleared/.test(t.textContent));
  assert('clear all: shows a Sale cleared snackbar with an Undo action', !!toastEl && /Undo/.test(toastEl.textContent) && !!toastEl.querySelector('button.toast-action'));
  assert('clear all: focus moves to the cake grid (not lost on the disabled button)',
    document.getElementById('item-grid').contains(document.activeElement));
  toastEl.querySelector('button.toast-action').click();
  const back = S.getState();
  assert('clear all: Undo restores the cart, name, amount and payment exactly',
    S.getCart().length === 2 && S.getCart().find((l) => l.item === 'Dates & Carrot Pudding (700g)').qty === 2 &&
    S.getCart().find((l) => l.item === 'Rich Plum Cake (400g)').qty === 1 &&
    back.customer === 'Clara' && cust.value === 'Clara' && back.payment === 'UPI' && back.received === snapReceived,
    JSON.stringify({ c: back.customer, p: back.payment, r: back.received, s: snapReceived }));
  assert('clear all: Undo removes the snackbar and re-enables Record sale',
    !Array.from(document.querySelectorAll('#toasts > div')).some((t) => /Sale cleared/.test(t.textContent)) &&
    document.getElementById('record-sale').disabled === false);
  assert('clear all: Undo leaves recorded walk-ins and the outbox alone',
    S.getState().walkins.length === recordedBefore && S.getState().outbox.length === outboxBefore);

  // a payment-only change counts as "something to clear"
  clearBtn.click();
  S.setPayment('UPI');
  assert('clear all: a non-default payment alone enables the button', clearBtn.disabled === false);
  clearBtn.click();
  assert('clear all: resets payment back to Cash', S.getState().payment === 'Cash' && clearBtn.disabled === true);
  window.close();
}

// ---- Recent walk-ins: picking another date swaps the list and the message ----
{
  const page = await loadPreview();
  const { document, window } = page;
  const S = window.__staff;
  await S.setTab('recent');
  await waitFor(() => document.querySelectorAll('#walkin-list article').length >= 1);
  const list = () => document.getElementById('walkin-list');
  const startDate = S.getState().pickupDate;
  const other = Array.from(document.querySelectorAll('#recent-date-chips [data-date]')).find((b) => b.getAttribute('data-date') !== startDate);
  const otherLabel = other.textContent.trim();
  other.click();
  assert('recent date change: the old date cards are gone at once and a loading line shows',
    list().querySelectorAll('article').length === 0 && /Loading walk-ins for/.test(list().textContent), list().textContent);
  await waitFor(() => /No walk-in sales for/.test(list().textContent));
  assert('recent date change: the empty message names the newly selected date',
    list().textContent.indexOf('No walk-in sales for') >= 0 && S.getState().pickupDate === other.getAttribute('data-date') && list().textContent.indexOf(otherLabel.split(/\s+/).slice(-2).join(' ')) >= 0,
    list().textContent + ' | ' + otherLabel);
  document.querySelector('#recent-date-chips [data-date="' + startDate + '"]').click();
  await waitFor(() => list().querySelectorAll('article').length >= 1);
  assert('recent date change: going back shows that date walk-ins again', list().querySelectorAll('article').length >= 1);
  window.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
