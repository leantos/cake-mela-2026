import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(CODE_GS, 'utf8');
function slice(a, b) {
  const start = src.indexOf(a);
  const end = src.indexOf(b);
  if (start < 0 || end < 0) throw new Error('missing markers ' + a + ' / ' + b);
  return src.slice(start, end + b.length);
}
const context = {};
vm.createContext(context);
vm.runInContext(slice('/* ---- date helpers (testable) ---- */', '/* ---- end date helpers ---- */'), context);
vm.runInContext(slice('/* ---- stock compute (testable) ---- */', '/* ---- end stock compute ---- */'), context);

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

const MENU = ['Dates & Carrot Pudding (700g)', 'Rich Plum Cake (400g)'];
const stockValues = [
  ['Item', '29 Nov 2026', '25 Dec 2026', 'Total'],
  ['Dates & Carrot Pudding (700g)', 15, 8, 23],
  ['Rich Plum Cake (400g)', '', 4, 4], // blank on 29 Nov: unlimited until the 25 Dec cap
  ['TOTAL', 15, 12, 27]
];
const ordered = {
  '2026-11-29': { 'Dates & Carrot Pudding (700g)': 3 }
};
const payload = context.computeRemainingFromTables_(stockValues, ordered, MENU);
assert('remaining subtracts tally from cap', payload.remaining['2026-11-29']['Dates & Carrot Pudding (700g)'] === 12,
  JSON.stringify(payload.remaining));
assert('blank early cell is unlimited when no earlier numeric cap exists', payload.remaining['2026-11-29']['Rich Plum Cake (400g)'] === null,
  JSON.stringify(payload.remaining['2026-11-29']));
assert('later numeric cap starts a pool (4, no earlier cap or orders)', payload.remaining['2026-12-25']['Rich Plum Cake (400g)'] === 4,
  JSON.stringify(payload.remaining['2026-12-25']));
assert('later date inherits leftover from earlier caps (15+8-3=20)', payload.remaining['2026-12-25']['Dates & Carrot Pudding (700g)'] === 20,
  JSON.stringify(payload.remaining['2026-12-25']));
assert('dates include Friday label from the header',
  payload.dates.some((d) => d.id === '2026-12-25' && d.label === 'Fri, 25 Dec'),
  JSON.stringify(payload.dates));
assert('Total column is not treated as a pickup date',
  !payload.dates.some((d) => /total/i.test(d.label || '')) && !payload.remaining.Total);

const bumped = context.incrementTallyMap_(ordered, '2026-11-29', [
  { name: 'Dates & Carrot Pudding (700g)', qty: 2 },
  { name: 'Rich Plum Cake (400g)', qty: 1 }
]);
assert('tally increment adds to the existing date/item', bumped['2026-11-29']['Dates & Carrot Pudding (700g)'] === 5);
assert('tally increment inserts a new item key', bumped['2026-11-29']['Rich Plum Cake (400g)'] === 1);
assert('tally increment does not mutate the original map', ordered['2026-11-29']['Dates & Carrot Pudding (700g)'] === 3);

const after = context.subtractOrderFromRemaining_(payload, '2026-11-29', [
  { name: 'Dates & Carrot Pudding (700g)', qty: 2 }
]);
assert('subtracting a saved order drops remaining', after.remaining['2026-11-29']['Dates & Carrot Pudding (700g)'] === 10);
assert('subtract does not go below zero',
  context.subtractOrderFromRemaining_(payload, '2026-11-29', [
    { name: 'Dates & Carrot Pudding (700g)', qty: 99 }
  ]).remaining['2026-11-29']['Dates & Carrot Pudding (700g)'] === 0);

assert('fresh cache requires matching gen',
  context.stockCacheIsFresh_(JSON.stringify({ ok: true, remaining: {}, _gen: '7' }), '7') === true);
assert('stale cache gen is rejected',
  context.stockCacheIsFresh_(JSON.stringify({ ok: true, remaining: {}, _gen: '7' }), '8') === false);
assert('empty cache is not fresh', context.stockCacheIsFresh_(null, '7') === false);
{
  const pub = context.publicStockPayload_({
    ok: true,
    dates: [{ id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: 'x' }, { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: 'y' }],
    remaining: { '2026-11-29': { A: 1 }, '2026-12-06': { A: null } },
    _gen: '9'
  });
  assert('public payload strips _gen', !('_gen' in pub));
  assert('public payload repeats remaining on each dates[] entry (null = unlimited)',
    pub.dates[0].remaining.A === 1 && pub.dates[1].remaining.A === null &&
    pub.remaining['2026-11-29'].A === 1 && pub.ok === true && typeof pub.version === 'string',
    JSON.stringify(pub));
}


function extractFunction(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('missing function ' + name);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}
function extractVar(src, name) {
  const start = src.indexOf('var ' + name);
  if (start < 0) throw new Error('missing var ' + name);
  const endObj = src.indexOf('};', start);
  const endArr = src.indexOf('];', start);
  const end = (endArr >= 0 && (endObj < 0 || endArr < endObj)) ? endArr : endObj;
  if (end < 0) throw new Error('unclosed var ' + name);
  return src.slice(start, end + 2);
}

vm.runInContext(extractVar(src, 'MENU_ITEM_COLUMNS'), context);
vm.runInContext(extractFunction(src, 'uniqueNames_'), context);
vm.runInContext(extractFunction(src, 'tallyDatesKey_'), context);
vm.runInContext(extractFunction(src, 'tallyItemNames_'), context);
vm.runInContext(extractFunction(src, 'writeTallySheet_'), context);

function mockSheet() {
  const calls = [];
  return {
    calls,
    clearContents() { calls.push('clear'); },
    getRange(r, c, nRows, nCols) {
      return {
        setValues(values) {
          if (!values || !values.length) throw new Error('empty values');
          const width = values[0].length;
          for (let i = 0; i < values.length; i++) {
            if (values[i].length !== width) {
              throw new Error('data has ' + values[i].length + ' but range has ' + nCols + ' (row ' + i + ' is ragged)');
            }
          }
          if (width !== nCols) throw new Error('data has ' + width + ' but range has ' + nCols);
          if (values.length !== nRows) throw new Error('row count ' + values.length + ' != ' + nRows);
          calls.push({ nRows, nCols, values });
        }
      };
    }
  };
}

function datesList(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = 20 + i;
    out.push({ id: '2026-12-' + String(d).padStart(2, '0'), label: 'D' + d });
  }
  return out;
}

for (const n of [1, 3, 9]) {
  const sheet = mockSheet();
  const dates = datesList(n);
  const ordered = {};
  ordered[dates[0].id] = { 'Dates & Carrot Pudding (700g)': 2 };
  context.writeTallySheet_(sheet, dates, ordered, 4, 'PB-TEST');
  const write = sheet.calls.find((c) => c && c.values);
  const width = Math.max(4, 1 + n);
  assert('writeTallySheet_ is rectangular for ' + n + ' date(s)',
    write && write.nCols === width && write.values.every((row) => row.length === width),
    JSON.stringify(write && { nCols: write.nCols, lengths: write.values.map((r) => r.length) }));
  assert('writeTallySheet_ meta row is padded to width for ' + n + ' date(s)',
    write && write.values[0][0] === '#tally' && write.values[0].length === width);
}

// ---- schema fast path + tally patch plan (loaded from current Code.gs) ----
vm.runInContext(extractVar(src, 'BASE_HEADERS'), context);
vm.runInContext(extractFunction(src, 'schemaSignature_'), context);
vm.runInContext(extractFunction(src, 'ordersSchemaLooksOk_'), context);
vm.runInContext(extractFunction(src, 'planTallyPatch_'), context);

const fullHeaders = context.BASE_HEADERS.concat(context.MENU_ITEM_COLUMNS);
assert('schema looks ok when every base header and item is present',
  context.ordersSchemaLooksOk_(fullHeaders, context.MENU_ITEM_COLUMNS) === true);
assert('schema rejects a missing Status column',
  context.ordersSchemaLooksOk_(fullHeaders.filter((h) => h !== 'Status'), context.MENU_ITEM_COLUMNS) === false);
assert('schema rejects a new item name that is not on the sheet yet',
  context.ordersSchemaLooksOk_(fullHeaders, context.MENU_ITEM_COLUMNS.concat(['New Cake (1kg)'])) === false);
assert('schema rejects a first cell that is not Timestamp',
  context.ordersSchemaLooksOk_(['Order ID'].concat(fullHeaders.slice(1)), context.MENU_ITEM_COLUMNS) === false);
assert('schema rejects an empty header row',
  context.ordersSchemaLooksOk_([], context.MENU_ITEM_COLUMNS) === false);

const sigA = context.schemaSignature_(fullHeaders, context.MENU_ITEM_COLUMNS);
const sigB = context.schemaSignature_(fullHeaders.concat(['Extra']), context.MENU_ITEM_COLUMNS);
assert('schema signature changes when a header is added', sigA !== sigB);

const tallyDates = [
  { id: '2026-11-29', label: 'Sun, 29 Nov' },
  { id: '2026-12-06', label: 'Sun, 6 Dec' }
];
const tallyValues = [
  ['#tally', 6, 'PB-OLD', '2026-11-29,2026-12-06', ''],
  ['Item', '2026-11-29', '2026-12-06', '', ''],
  ['Dates & Carrot Pudding (700g)', 3, 0, '', ''],
  ['Rich Plum Cake (400g)', 1, 2, '', '']
];
const plan = context.planTallyPatch_(
  tallyValues,
  tallyDates,
  '2026-11-29',
  [{ name: 'Dates & Carrot Pudding (700g)', qty: 2 }, { name: 'Rich Plum Cake (400g)', qty: 1 }],
  7,
  'PB-NEW'
);
assert('tally patch plan succeeds when date and items exist', plan.ok === true, JSON.stringify(plan));
assert('tally patch updates meta lastRow and lastOrderId',
  plan.ok && plan.meta[0] === 7 && plan.meta[1] === 'PB-NEW', JSON.stringify(plan.meta));
assert('tally patch increments only the chosen date column',
  plan.ok && plan.dateCol === 1 && plan.startRow === 3 &&
  plan.column[0][0] === 5 && plan.column[1][0] === 2,
  JSON.stringify(plan.column));
assert('tally patch does not mutate the original grid',
  tallyValues[2][1] === 3 && tallyValues[3][1] === 1);

const missingItem = context.planTallyPatch_(
  tallyValues, tallyDates, '2026-11-29',
  [{ name: 'Brand New Cake (1kg)', qty: 1 }],
  7, 'PB-NEW'
);
assert('tally patch falls back when an item row is missing',
  missingItem.ok === false && missingItem.reason === 'missing-item', JSON.stringify(missingItem));

const missingDate = context.planTallyPatch_(
  tallyValues, tallyDates, '2026-12-25',
  [{ name: 'Rich Plum Cake (400g)', qty: 1 }],
  7, 'PB-NEW'
);
assert('tally patch falls back when the date column is missing',
  missingDate.ok === false && missingDate.reason === 'date-col', JSON.stringify(missingDate));

const staleDates = context.planTallyPatch_(
  tallyValues,
  [{ id: '2026-11-29', label: 'Sun, 29 Nov' }, { id: '2026-12-25', label: 'Fri, 25 Dec' }],
  '2026-11-29',
  [{ name: 'Rich Plum Cake (400g)', qty: 1 }],
  7, 'PB-NEW'
);
assert('tally patch falls back when the tally date key is stale',
  staleDates.ok === false && staleDates.reason === 'dates', JSON.stringify(staleDates));

// Duplicate date column must not zero out the first (user edit, firstColForDate)
const dupStock = [
  ['Item', '29 Nov 2026', '29 Nov 2026', 'Total'],
  ['Dates & Carrot Pudding (700g)', 15, '', 15],
  ['Rich Plum Cake (400g)', 50, '', 50]
];
const dupPayload = context.computeRemainingFromTables_(dupStock, {}, MENU);
assert('duplicate later blank date column does not wipe the first column cap',
  dupPayload.remaining['2026-11-29']['Dates & Carrot Pudding (700g)'] === 15,
  JSON.stringify(dupPayload.remaining));


vm.runInContext(extractFunction(src, 'usedByDateFromSummary_'), context);
// ---- carry-forward leftover stock (blank = unlimited, batch + leftover) ----
const D = 'Dates & Carrot Pudding (700g)';
const P = 'Rich Plum Cake (400g)';
const cfStock = [
  ['Item', '29 Nov 2026', '6 Dec 2026'],
  [D, 15, ''],
  [P, 0, 10]
];
const cf1 = context.computeRemainingFromTables_(cfStock, { '2026-11-29': { [D]: 5 } }, MENU);
assert('29 Nov batch 15 minus 5 used is 10', cf1.remaining['2026-11-29'][D] === 10, JSON.stringify(cf1.remaining));
assert('blank 6 Dec is UNLIMITED even though 29 Nov had a cap', cf1.remaining['2026-12-06'][D] === null, JSON.stringify(cf1.remaining));
assert('29 Nov stays 10: an unlimited later date claims nothing from it', cf1.remaining['2026-11-29'][D] === 10);
assert('explicit 0 with no leftover is sold out (not unlimited)', cf1.remaining['2026-11-29'][P] === 0);
assert('0 leftover + batch 10 offers 10 on 6 Dec', cf1.remaining['2026-12-06'][P] === 10);

// Two capped dates in a row: leftover + new batch.
const cf2Stock = [['Item', '29 Nov 2026', '6 Dec 2026'], [D, 10, 5]];
const cf2 = context.computeRemainingFromTables_(cf2Stock, { '2026-11-29': { [D]: 7 } }, [D]);
assert('29 Nov: 10 - 7 = 3 left', cf2.remaining['2026-11-29'][D] === 3, JSON.stringify(cf2.remaining));
assert('6 Dec = leftover 3 + new batch 5 = 8', cf2.remaining['2026-12-06'][D] === 8, JSON.stringify(cf2.remaining));

const cf3 = context.computeRemainingFromTables_(cf2Stock, {
  '2026-11-29': { [D]: 7 },
  '2026-12-06': { [D]: 6 }
}, [D]);
assert('6 Dec: 3 + 5 - 6 = 2', cf3.remaining['2026-12-06'][D] === 2, JSON.stringify(cf3.remaining));
assert('29 Nov is capped at 2 so an order there cannot take stock 6 Dec already claimed',
  cf3.remaining['2026-11-29'][D] === 2, JSON.stringify(cf3.remaining));

const cf3b = context.computeRemainingFromTables_(cf2Stock, {
  '2026-11-29': { [D]: 2 },
  '2026-12-06': { [D]: 99 }
}, [D]);
assert('sold out everywhere: floors at 0, never negative',
  cf3b.remaining['2026-11-29'][D] === 0 && cf3b.remaining['2026-12-06'][D] === 0, JSON.stringify(cf3b.remaining));

// An unlimited date in the middle resets the pool and ends the guard chain.
const cf4Stock = [['Item', '29 Nov 2026', '6 Dec 2026', '13 Dec 2026'], [D, 10, '', 4]];
const cf4 = context.computeRemainingFromTables_(cf4Stock, {
  '2026-11-29': { [D]: 2 },
  '2026-12-13': { [D]: 4 }
}, [D]);
assert('29 Nov keeps 8: the unlimited 6 Dec leaves nothing behind and 13 Dec cannot claim it',
  cf4.remaining['2026-11-29'][D] === 8, JSON.stringify(cf4.remaining));
assert('unlimited middle date is null', cf4.remaining['2026-12-06'][D] === null);
assert('13 Dec starts a fresh pool (leftover 8 from 29 Nov is not carried across the unlimited date)',
  cf4.remaining['2026-12-13'][D] === 0, JSON.stringify(cf4.remaining));

// Orders on an unlimited date never reduce a later batch.
const cf5 = context.computeRemainingFromTables_(
  [['Item', '29 Nov 2026', '6 Dec 2026'], [D, '', 10]],
  { '2026-11-29': { [D]: 8 } },
  [D]
);
assert('unlimited 29 Nov', cf5.remaining['2026-11-29'][D] === null);
assert('later batch is untouched by orders on the earlier unlimited date (10)', cf5.remaining['2026-12-06'][D] === 10, JSON.stringify(cf5.remaining));

// Items with no Stock row are unlimited.
const cf6 = context.computeRemainingFromTables_(
  [['Item', '29 Nov 2026'], [D, 5]], {}, [D, P]
);
assert('item with no Stock row is unlimited', cf6.remaining['2026-11-29'][P] === null, JSON.stringify(cf6.remaining));

// Pool used for stock = non-cancelled orders + non-void walk-ins (via the summary).
const usedSummary = {
  dates: [{ id: '2026-11-29', items: { [D]: { ordered: 3, walkIn: 2 }, [P]: { ordered: 0, walkIn: 0 } } }]
};
const usedMap = context.usedByDateFromSummary_(usedSummary, [D, P]);
assert('used = ordered + walk-in per item', usedMap['2026-11-29'][D] === 5 && !usedMap['2026-11-29'][P], JSON.stringify(usedMap));

vm.runInContext(extractFunction(src, 'orderExceedsRemaining_'), context);
const remMap = { 'Dates & Carrot Pudding (700g)': 2, 'Rich Plum Cake (400g)': null };
assert('insufficient when qty exceeds a numeric cap',
  context.orderExceedsRemaining_([{ name: 'Dates & Carrot Pudding (700g)', qty: 3 }], remMap) === true);
assert('ok when qty is within a numeric cap',
  context.orderExceedsRemaining_([{ name: 'Dates & Carrot Pudding (700g)', qty: 2 }], remMap) === false);
assert('unlimited null never exceeds',
  context.orderExceedsRemaining_([{ name: 'Rich Plum Cake (400g)', qty: 99 }], remMap) === false);
assert('item with no Stock row has no limit',
  context.orderExceedsRemaining_([{ name: 'Unknown Cake', qty: 1 }], remMap) === false);
assert('0 remaining means any quantity exceeds',
  context.orderExceedsRemaining_([{ name: 'Dates & Carrot Pudding (700g)', qty: 1 }], { 'Dates & Carrot Pudding (700g)': 0 }) === true);


const failed = results.filter((r) => !r.ok);
console.log('\n--- stock compute ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) {
  console.error(failed);
  process.exit(1);
}
