import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(CODE_GS, 'utf8');

function slice(a, b) {
  const start = src.indexOf(a);
  const end = src.indexOf(b, start);
  if (start < 0 || end < 0) throw new Error('missing markers ' + a + ' / ' + b);
  return src.slice(start, end + b.length);
}

function extractVarBlock(name, until) {
  const start = src.indexOf(name);
  const end = src.indexOf(until, start);
  if (start < 0 || end < 0) throw new Error('missing ' + name);
  return src.slice(start, end);
}

const context = {};
vm.createContext(context);
vm.runInContext(
  extractVarBlock('var SCRIPT_VERSION', 'function doGet') + '\n' +
  extractVarBlock('var DEFAULT_OPENING_DATE_ID', 'var BASE_HEADERS') + '\n' +
  slice('/* ---- date helpers (testable) ---- */', '/* ---- end date helpers ---- */') + '\n' +
  slice('/* ---- order summary (testable) ---- */', '/* ---- end order summary ---- */'),
  context
);

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

const MENU = context.MENU_ITEM_COLUMNS;
assert('menu has 6 items', Array.isArray(MENU) && MENU.length === 6, String(MENU && MENU.length));

const DATES = [
  { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30' },
  { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: '2026-12-06T08:30:00+05:30' }
];

const headers = [
  'Timestamp', 'Order ID', 'Pickup Date', 'Mass', 'Name', 'Phone', 'Items',
  'Total Items', 'Total Amount (₹)', 'Status', 'Raw JSON'
].concat(MENU);

function row(overrides, itemsByName, raw) {
  const r = headers.map(() => '');
  const set = (name, value) => { r[headers.indexOf(name)] = value; };
  set('Timestamp', overrides.timestamp || '2026-11-23T10:00:00+05:30');
  set('Order ID', overrides.orderId || 'PB-X');
  set('Pickup Date', overrides.pickupDate || '2026-11-29');
  set('Mass', overrides.mass || '6:30 AM Mass');
  set('Name', overrides.name || 'Ann');
  set('Phone', overrides.phone || '9000000000');
  set('Total Items', overrides.totalItems || 0);
  set('Total Amount (₹)', overrides.amount || 0);
  set('Status', overrides.status || 'OK');
  if (raw) set('Raw JSON', typeof raw === 'string' ? raw : JSON.stringify(raw));
  MENU.forEach((name) => {
    if (itemsByName && Object.prototype.hasOwnProperty.call(itemsByName, name)) {
      set(name, itemsByName[name]);
    }
  });
  return r;
}

const grid = [
  headers,
  row(
    { orderId: 'PB-1', mass: '6:30 AM Mass', amount: 700, totalItems: 2, name: 'Ann', timestamp: '2026-11-23T09:00:00+05:30' },
    { 'Rich Plum Cake (400g)': 2 }
  ),
  row(
    { orderId: 'PB-2', mass: '8:30 AM Mass', amount: 1000, totalItems: 2, name: 'Bala', timestamp: '2026-11-23T10:30:00+05:30' },
    { 'Rich Plum Cake (400g)': 1, 'Dates & Carrot Pudding (700g)': 1 }
  ),
  row(
    { orderId: 'PB-3', mass: '06:30', amount: 350, totalItems: 1, name: 'TEST ORDER - delete me' },
    { 'Rich Plum Cake (400g)': 1 }
  ),
  row(
    { orderId: 'PB-4', mass: '6:30 AM Mass', amount: 650, totalItems: 1, name: 'Cyril', status: 'CANCELLED' },
    { 'Dates & Carrot Pudding (700g)': 1 }
  ),
  row(
    { orderId: 'PB-5', pickupDate: 'Sun, 6 Dec', mass: '08:30', amount: 350, totalItems: 1, name: 'Dee' },
    { 'Rich Plum Cake (400g)': 1 }
  )
];

const now = new Date('2026-11-23T16:00:00+05:30');
const summary = context.computeOrderSummaryFromValues_(grid, DATES, MENU, now);

assert('payload is ok', summary.ok === true);
assert('version is present', typeof summary.version === 'string' && summary.version.length > 0, summary.version);
assert('returns both catalog dates in order', summary.dates.map((d) => d.id).join(',') === '2026-11-29,2026-12-06',
  JSON.stringify(summary.dates.map((d) => d.id)));
assert('every date lists all 6 items', summary.dates.every((d) => MENU.every((n) => d.items[n] && typeof d.items[n].total === 'number')));

const nov = summary.dates[0];
const dec = summary.dates[1];
assert('TEST ORDER row is excluded from 29 Nov plum count', nov.items['Rich Plum Cake (400g)'].total === 3,
  JSON.stringify(nov.items['Rich Plum Cake (400g)']));
assert('cancelled row is excluded from dates pudding', nov.items['Dates & Carrot Pudding (700g)'].total === 1,
  JSON.stringify(nov.items['Dates & Carrot Pudding (700g)']));
assert('summary items have no per-Mass keys (legacy Mass column is ignored)',
  !('06:30' in nov.items['Rich Plum Cake (400g)']) && !('08:30' in nov.items['Rich Plum Cake (400g)']) &&
  !('06:30' in summary.grand.items['Rich Plum Cake (400g)']),
  JSON.stringify(nov.items['Rich Plum Cake (400g)']));
assert('item shape per date is total/ordered/pickedUp/walkIn/pending only',
  JSON.stringify(Object.keys(nov.items['Rich Plum Cake (400g)']).sort()) === JSON.stringify(['ordered', 'pending', 'pickedUp', 'total', 'walkIn']),
  JSON.stringify(Object.keys(nov.items['Rich Plum Cake (400g)'])));
assert('plum on 29 Nov totals 3 across both legacy Mass labels', nov.items['Rich Plum Cake (400g)'].total === 3);
assert('29 Nov has 2 orders and 4 cakes', nov.totals.orders === 2 && nov.totals.cakes === 4,
  JSON.stringify(nov.totals));
assert('29 Nov amount is 1700', nov.totals.amount === 1700, JSON.stringify(nov.totals));
assert('6 Dec label match still counts the plum', dec.items['Rich Plum Cake (400g)'].total === 1 && dec.totals.orders === 1);
assert('grand cakes and orders exclude test and cancelled', summary.grand.cakes === 5 && summary.grand.orders === 3,
  JSON.stringify(summary.grand));
assert('payload has no names, phones or order IDs',
  !JSON.stringify(summary).includes('Ann') &&
  !JSON.stringify(summary).includes('9000000000') &&
  !JSON.stringify(summary).includes('PB-1'),
  JSON.stringify(summary).slice(0, 400));
assert('lastUpdated is set', /IST/.test(summary.lastUpdated), summary.lastUpdated);
assert('latest order timestamp prefers the later row', /10:30/.test(summary.latestOrderAt) || /10:30/.test(String(summary.latestOrderAt)),
  summary.latestOrderAt);

assert('Mass helpers are gone from the script', typeof context.normalizeMassId_ === 'undefined' && typeof context.massKeyExpr_ === 'undefined');
assert('cancelled status detected', context.isCancelledStatus_('CANCELLED') === true);
assert('ok status is not cancelled', context.isCancelledStatus_('OK') === false);
assert('TEST ORDER name detected', context.isTestOrderName_('TEST ORDER - delete me') === true);
assert('ordinary name is kept', context.isTestOrderName_('Ann Philip') === false);

const rawHeaders = [
  'Timestamp', 'Order ID', 'Pickup Date', 'Mass', 'Name', 'Phone',
  'Items', 'Total Items', 'Total Amount (₹)', 'Status', 'Raw JSON'
];
const rawGrid = [
  rawHeaders,
  [
    '2026-11-23T11:00:00+05:30', 'PB-RAW-1', '2026-11-29', '6:30 AM Mass', 'Ravi', '9111111111',
    '2 x Rich Plum Cake (400g)', 2, 700, 'OK',
    JSON.stringify({
      pickupDate: '2026-11-29',
      mass: '06:30',
      items: [
        { name: 'Rich Plum Cake (400g)', qty: 2, price: 350, lineTotal: 700 }
      ],
      totalAmount: 700
    })
  ],
  [
    '2026-11-23T11:05:00+05:30', 'PB-RAW-2', '2026-12-06', '8:30 AM Mass', 'TEST ORDER raw', '9222222222',
    '1 x Dates & Carrot Pudding (700g)', 1, 650, 'OK',
    JSON.stringify({
      items: [{ name: 'Dates & Carrot Pudding (700g)', qty: 9, lineTotal: 5850 }],
      totalAmount: 5850
    })
  ],
  [
    '2026-11-23T11:10:00+05:30', 'PB-RAW-3', '2026-12-06', '08:30', 'Maya', '9333333333',
    '', '', '', 'OK',
    JSON.stringify({
      pickupDate: '2026-12-06',
      massLabel: '8:30 AM Mass',
      items: [
        { name: 'Dates & Carrot Pudding (700g)', qty: 1, price: 650, lineTotal: 650 },
        { name: 'Butterscotch Pudding (350g)', qty: 2, price: 350, lineTotal: 700 }
      ]
    })
  ]
];

const rawSummary = context.computeOrderSummaryFromValues_(rawGrid, DATES, MENU, now);
const rawNov = rawSummary.dates[0];
const rawDec = rawSummary.dates[1];
assert('raw JSON fallback counts 29 Nov plum qty', rawNov.items['Rich Plum Cake (400g)'].total === 2,
  JSON.stringify(rawNov.items['Rich Plum Cake (400g)']));
assert('raw JSON TEST ORDER is excluded', rawDec.items['Dates & Carrot Pudding (700g)'].total === 1,
  JSON.stringify(rawDec.items['Dates & Carrot Pudding (700g)']));
assert('raw JSON fills amount from line totals when the amount column is blank', rawDec.totals.amount === 1350,
  JSON.stringify(rawDec.totals));
assert('raw JSON qty still lands on the right date without a Mass', rawDec.items['Butterscotch Pudding (350g)'].total === 2);

// Sheets getValues() returns Date objects when setValues auto-converted
// the ISO pickup date and the '06:30' mass time.
const istMidnight29 = new Date('2026-11-28T18:30:00.000Z'); // 29 Nov 00:00 IST
const tsDate = new Date('2026-11-23T16:45:00+05:30');

assert('findStockDate_ accepts a Sheets Date at IST midnight',
  context.findStockDate_(istMidnight29, DATES)?.id === '2026-11-29',
  JSON.stringify(context.findStockDate_(istMidnight29, DATES)));
assert('normalizePickupDateId_ uses the IST calendar date, not the UTC day',
  context.normalizePickupDateId_(istMidnight29) === '2026-11-29',
  context.normalizePickupDateId_(istMidnight29));
assert('TEST ORDER exclusion does not match an ordinary name', context.isTestOrderName_('Cyril Martin') === false);
assert('TEST ORDER exclusion does not match a Date cell', context.isTestOrderName_(istMidnight29) === false);
assert('TEST ORDER exclusion matches only names containing TEST ORDER',
  context.isTestOrderName_('TEST ORDER - delete me') === true &&
  context.isTestOrderName_('Anita Test') === false);

const dateGrid = [
  headers,
  row(
    {
      orderId: 'PB-DATE-1',
      pickupDate: istMidnight29,
      amount: 700,
      totalItems: 2,
      name: 'Priya',
      timestamp: tsDate
    },
    { 'Rich Plum Cake (400g)': 2 }
  ),
  row(
    {
      orderId: 'PB-DATE-2',
      pickupDate: istMidnight29,
      amount: 650,
      totalItems: 1,
      name: 'Joseph',
      timestamp: '2026-11-23T10:00:00+05:30'
    },
    { 'Dates & Carrot Pudding (700g)': 1 }
  )
];
const dateSummary = context.computeOrderSummaryFromValues_(dateGrid, DATES, MENU, now);
const dateNov = dateSummary.dates[0];
assert('Date cells still count cakes on 29 Nov', dateNov.totals.cakes === 3 && dateNov.totals.orders === 2,
  JSON.stringify(dateNov.totals));
assert('Date cells still total per item without a Mass split',
  dateNov.items['Rich Plum Cake (400g)'].total === 2 &&
  dateNov.items['Dates & Carrot Pudding (700g)'].total === 1,
  JSON.stringify({ plum: dateNov.items['Rich Plum Cake (400g)'], pudding: dateNov.items['Dates & Carrot Pudding (700g)'] }));
assert('latestOrderAt formats a Date timestamp in IST',
  /4:45/.test(dateSummary.latestOrderAt) && /IST/.test(dateSummary.latestOrderAt),
  dateSummary.latestOrderAt);

const fallbackGrid = [
  headers,
  row(
    {
      orderId: 'PB-FALLBACK',
      pickupDate: new Date('2000-01-01T00:00:00Z'),
      mass: new Date('2000-01-01T00:00:00Z'),
      amount: 350,
      totalItems: 1,
      name: 'Renu',
      timestamp: tsDate
    },
    { 'Rich Plum Cake (400g)': 1 },
    {
      pickupDate: '2026-11-29',
      massLabel: '6:30 AM Mass',
      items: [{ name: 'Rich Plum Cake (400g)', qty: 1, lineTotal: 350 }],
      totalAmount: 350
    }
  )
];
const fallback = context.computeOrderSummaryFromValues_(fallbackGrid, DATES, MENU, now);
assert('unparseable Date cells fall back to Raw JSON pickup',
  fallback.dates[0].items['Rich Plum Cake (400g)'].total === 1 && fallback.dates[0].totals.orders === 1,
  JSON.stringify(fallback.dates[0].totals));

assert('weekly summary formulas normalize Date cells with SUMPRODUCT and TEXT',
  /function pickupKeyExpr_/.test(src) && /SUMPRODUCT/.test(src) && /yyyy-mm-dd/.test(src));

assert('normalizeOrderStatus_ maps OK and New to Pending',
  context.normalizeOrderStatus_('OK') === 'Pending' &&
  context.normalizeOrderStatus_('New') === 'Pending' &&
  context.normalizeOrderStatus_('INVALID DATE - CHECK') === 'Pending');
assert('normalizeOrderStatus_ maps Paid and Picked up',
  context.normalizeOrderStatus_('Paid') === 'Paid' &&
  context.normalizeOrderStatus_('Picked up') === 'Picked up');
assert('Picked up counts as paid', context.isPaidStatus_('Picked up') === true && context.isPaidStatus_('Pending') === false);
assert('Cancelled still detected from legacy text', context.isCancelledStatus_('CANCELLED') === true);

const statusGrid = [
  headers,
  row({ orderId: 'PB-S1', pickupDate: '2026-11-29', mass: '6:30 AM Mass', amount: 700, totalItems: 2, name: 'Ann', status: 'OK' },
    { 'Rich Plum Cake (400g)': 2 }),
  row({ orderId: 'PB-S2', pickupDate: '2026-11-29', mass: '8:30 AM Mass', amount: 650, totalItems: 1, name: 'Bala', status: 'New' },
    { 'Dates & Carrot Pudding (700g)': 1 }),
  row({ orderId: 'PB-S3', pickupDate: '2026-11-29', mass: '6:30 AM Mass', amount: 350, totalItems: 1, name: 'Cyril', status: 'Paid' },
    { 'Rich Plum Cake (400g)': 1 }),
  row({ orderId: 'PB-S4', pickupDate: '2026-11-29', mass: '8:30 AM Mass', amount: 700, totalItems: 2, name: 'Dee', status: 'Picked up' },
    { 'Rich Plum Cake (400g)': 2 }),
  row({ orderId: 'PB-S5', pickupDate: '2026-11-29', mass: '6:30 AM Mass', amount: 650, totalItems: 1, name: 'Evan', status: 'Cancelled' },
    { 'Dates & Carrot Pudding (700g)': 1 })
];
const statusSummary = context.computeOrderSummaryFromValues_(statusGrid, DATES, MENU, now);
const stNov = statusSummary.dates[0];
assert('legacy OK/New statuses count as ordered Pending', stNov.totals.orders === 4 && stNov.totals.cakes === 6,
  JSON.stringify(stNov.totals));
assert('cancelled order is counted separately and excluded from ordered',
  stNov.sales.cancelled.orders === 1 && stNov.sales.ordered.orders === 4,
  JSON.stringify(stNov.sales));
assert('paid includes Paid plus Picked up cakes',
  stNov.sales.paid.cakes === 3 && stNov.sales.pickedUp.cakes === 2,
  JSON.stringify(stNov.sales));
assert('pending pickup is ordered minus picked up',
  stNov.sales.pendingPickup.cakes === 4, JSON.stringify(stNov.sales));

// ---- OVERSOLD (saved over stock) ----
assert('normalizeOrderStatus_ keeps OVERSOLD as its own status (incl. legacy text)',
  context.normalizeOrderStatus_('OVERSOLD') === 'OVERSOLD' &&
  context.normalizeOrderStatus_('OVERSOLD - CHECK') === 'OVERSOLD' &&
  context.normalizeOrderStatus_('Paid') === 'Paid');
assert('OVERSOLD is neither paid, picked up nor cancelled',
  context.isPaidStatus_('OVERSOLD') === false && context.isCancelledStatus_('OVERSOLD') === false &&
  context.isPickedUpStatus_('OVERSOLD') === false);
{
  const ovGrid = statusGrid.concat([
    row({ orderId: 'PB-S6', pickupDate: '2026-11-29', mass: '6:30 AM Mass', amount: 1050, totalItems: 3, name: 'Fay', status: 'OVERSOLD' },
      { 'Rich Plum Cake (400g)': 3 })
  ]);
  const ov = context.computeOrderSummaryFromValues_(ovGrid, DATES, MENU, now);
  const ovNov = ov.dates[0];
  assert('OVERSOLD counts as ordered', ovNov.sales.ordered.orders === 5 && ovNov.totals.cakes === 9 &&
    ovNov.items['Rich Plum Cake (400g)'].ordered === 8, JSON.stringify(ovNov.sales));
  assert('OVERSOLD is listed separately per date and in the grand total',
    ovNov.sales.oversold.orders === 1 && ovNov.sales.oversold.cakes === 3 &&
    ov.grand.sales.oversold.orders === 1 && ov.grand.sales.oversold.cakes === 3 &&
    ov.dates[1].sales.oversold.orders === 0, JSON.stringify(ovNov.sales.oversold));
  assert('OVERSOLD is not counted as paid', ovNov.sales.paid.cakes === 3, JSON.stringify(ovNov.sales));
}

const walkHeaders = ['Date', 'Mass', 'Item', 'Qty', 'Price each', 'Amount', 'Payment', 'Notes'];
const walkGrid = [
  walkHeaders,
  [new Date('2026-11-28T18:30:00.000Z'), '6:30 AM Mass', 'Rich Plum Cake (400g)', 3, 350, 1050, 'Cash', ''],
  [new Date('2026-11-28T18:30:00.000Z'), '8:30 AM Mass', 'Dates & Carrot Pudding (700g)', 1, 650, 650, 'UPI', ''],
  [new Date('2026-12-21T00:00:00+05:30'), 'Other', 'Butterscotch Pudding (350g)', 2, 350, 700, 'cash', 'unlisted date']
];
const withWalk = context.computeOrderSummaryFromValues_(statusGrid, DATES, MENU, now, walkGrid);
const walkNov = withWalk.dates[0];
assert('walk-in Date cells add cakes and cash/UPI split on 29 Nov',
  walkNov.sales.walkIn.cakes === 4 && walkNov.sales.walkIn.amount === 1700 &&
  walkNov.sales.walkIn.cash === 1050 && walkNov.sales.walkIn.upi === 650,
  JSON.stringify(walkNov.sales.walkIn));
assert('walk-in item qty lands on the item row',
  walkNov.items['Rich Plum Cake (400g)'].walkIn === 3,
  JSON.stringify(walkNov.items['Rich Plum Cake (400g)']));
assert('total sold is picked up plus walk-in',
  walkNov.sales.totalSold.cakes === walkNov.sales.pickedUp.cakes + walkNov.sales.walkIn.cakes);
assert('collected ₹ is paid orders plus walk-in',
  walkNov.sales.collected.amount === walkNov.sales.paid.amount + walkNov.sales.walkIn.amount,
  JSON.stringify(walkNov.sales));
const extra = withWalk.dates.find((d) => d.id === '2026-12-21');
assert('walk-ins on a date not in the Stock list are appended',
  extra && extra.sales.walkIn.cakes === 2 && extra.label.length > 0,
  JSON.stringify(extra && { id: extra.id, label: extra.label, sales: extra.sales.walkIn }));
assert('weekly formulas exclude cancelled and keep IFERROR around summed cells',
  /notCancelledExpr_/.test(src) && /IFERROR\(1\*/.test(src) && /Walk-in/.test(src));

// ---- pending orders: exactly Pending, per date and per item ----
const pendGrid = [
  headers,
  row({ orderId: 'PB-P1', pickupDate: '2026-11-29', amount: 700, totalItems: 2, name: 'Ann', status: 'Pending' }, { 'Rich Plum Cake (400g)': 2 }),
  row({ orderId: 'PB-P2', pickupDate: '2026-11-29', amount: 1000, totalItems: 2, name: 'Bala', status: 'OK' },
    { 'Rich Plum Cake (400g)': 1, 'Dates & Carrot Pudding (700g)': 1 }),
  row({ orderId: 'PB-P3', pickupDate: '2026-11-29', amount: 350, totalItems: 1, name: 'Cyril', status: 'Paid' }, { 'Rich Plum Cake (400g)': 1 }),
  row({ orderId: 'PB-P4', pickupDate: '2026-11-29', amount: 700, totalItems: 2, name: 'Dee', status: 'Picked up' }, { 'Rich Plum Cake (400g)': 2 }),
  row({ orderId: 'PB-P5', pickupDate: '2026-11-29', amount: 650, totalItems: 1, name: 'Evan', status: 'Cancelled' }, { 'Dates & Carrot Pudding (700g)': 1 }),
  row({ orderId: 'PB-P6', pickupDate: '2026-11-29', amount: 350, totalItems: 1, name: 'Fay', status: 'OVERSOLD' }, { 'Rich Plum Cake (400g)': 1 }),
  row({ orderId: 'PB-P7', pickupDate: '2026-11-29', amount: 350, totalItems: 1, name: 'TEST ORDER - delete me', status: 'Pending' }, { 'Rich Plum Cake (400g)': 1 }),
  row({ orderId: 'PB-P8', pickupDate: '2026-12-06', amount: 350, totalItems: 1, name: 'Gus', status: 'Pending' }, { 'Rich Plum Cake (400g)': 1 })
];
const pendSummary = context.computeOrderSummaryFromValues_(pendGrid, DATES, MENU, now);
const pNov = pendSummary.dates[0];
const pDec = pendSummary.dates[1];
assert('pending: 29 Nov counts only Pending/OK rows (2 orders, 4 cakes, Rs 1700)',
  JSON.stringify(pNov.pending) === JSON.stringify({ orders: 2, cakes: 4, amount: 1700 }), JSON.stringify(pNov.pending));
assert('pending: per-item pending cakes exclude Paid, Picked up, Cancelled, OVERSOLD and test rows',
  pNov.items['Rich Plum Cake (400g)'].pending === 3 && pNov.items['Dates & Carrot Pudding (700g)'].pending === 1 &&
  pNov.items['Butterscotch Pudding (700g)'].pending === 0,
  JSON.stringify(pNov.items['Rich Plum Cake (400g)']));
assert('pending: OVERSOLD stays in its own block, not in pending',
  pNov.sales.oversold.orders === 1 && pNov.pending.orders === 2);
assert('pending: 6 Dec is counted separately', JSON.stringify(pDec.pending) === JSON.stringify({ orders: 1, cakes: 1, amount: 350 }), JSON.stringify(pDec.pending));
assert('pending: grand total sums the dates and items',
  JSON.stringify(pendSummary.grand.pending) === JSON.stringify({ orders: 3, cakes: 5, amount: 2050 }) &&
  pendSummary.grand.items['Rich Plum Cake (400g)'].pending === 4,
  JSON.stringify(pendSummary.grand.pending));
assert('pending: aggregates only (no names, phones or order IDs in the payload)',
  !/PB-P|Ann|Bala|Gus|9876/.test(JSON.stringify(pendSummary)));
assert('pending: ordered totals and existing fields are unchanged',
  pNov.totals.orders === 5 && pNov.sales.ordered.orders === 5 && typeof pNov.sales.paid.cakes === 'number');

// ---- the order page's own timestamp text: 'dd/mm/yyyy, hh:mm:ss am/pm IST' ----
assert('timestamp text: 4:12 pm IST is 10:42 UTC', context.timestampMs_('23/11/2026, 04:12:00 pm IST') === Date.UTC(2026, 10, 23, 10, 42, 0), String(context.timestampMs_('23/11/2026, 04:12:00 pm IST')));
assert('timestamp text: 12:05 am is just after midnight, 12:05 pm just after noon',
  context.timestampMs_('24/11/2026, 12:05:00 am IST') === Date.UTC(2026, 10, 23, 18, 35, 0) && context.timestampMs_('24/11/2026, 12:05:00 pm IST') === Date.UTC(2026, 10, 24, 6, 35, 0));
assert('timestamp text: a 24-hour clock without am/pm works, and rubbish returns 0',
  context.timestampMs_('24/11/2026, 16:12:30') === Date.UTC(2026, 10, 24, 10, 42, 30) && context.timestampMs_('not a date') === 0);
{
  const textRows = [
    headers,
    row({ orderId: 'PB-TXT-1', pickupDate: '2026-11-29', amount: 350, totalItems: 1, name: 'Maria', timestamp: '23/11/2026, 04:12:00 pm IST' }, { 'Rich Plum Cake (400g)': 1 }),
    row({ orderId: 'PB-TXT-2', pickupDate: '2026-11-29', amount: 650, totalItems: 1, name: 'Joseph', timestamp: '24/11/2026, 09:30:00 am IST' }, { 'Dates & Carrot Pudding (700g)': 1 })
  ];
  const textSummary = context.computeOrderSummaryFromValues_(textRows, DATES, MENU, now);
  assert('latestOrderAt is filled from the page text timestamps and picks the later order',
    /24\/11\/2026/.test(textSummary.latestOrderAt) && /09:30/.test(textSummary.latestOrderAt) && /IST/.test(textSummary.latestOrderAt),
    String(textSummary.latestOrderAt));
}
const failed = results.filter((r) => !r.ok);
console.log('\n--- summary aggregate ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) process.exit(1);
