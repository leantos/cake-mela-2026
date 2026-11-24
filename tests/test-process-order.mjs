import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import fs from 'fs';
import vm from 'vm';

const BEFORE = ROOT + '/tests/fixtures/Code.gs.before';
const AFTER = CODE_GS;

const MENU = [
  'Dates & Carrot Pudding (700g)',
  'Dates & Carrot Pudding (350g)',
  'Butterscotch Pudding (700g)',
  'Butterscotch Pudding (350g)',
  'Rich Plum Cake (800g)',
  'Rich Plum Cake (400g)'
];

const BASE = [
  'Timestamp', 'Order ID', 'Pickup Date', 'Mass', 'Name', 'Phone',
  'Items', 'Total Items', 'Total Amount (₹)', 'Status', 'Raw JSON'
];

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

function usedSize(data) {
  let lastRow = 0, lastCol = 0;
  for (let r = 0; r < data.length; r++) {
    const row = data[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && typeof row[c] !== 'undefined') {
        lastRow = r + 1;
        lastCol = Math.max(lastCol, c + 1);
      }
    }
  }
  return { lastRow, lastCol };
}

function makeWorld(codePath) {
  const calls = [];
  function rec(name, extra) {
    calls.push(extra ? { name, ...extra } : { name });
  }

  class FakeRange {
    constructor(sheet, r, c, nRows, nCols) {
      this.sheet = sheet;
      this.r = r; this.c = c;
      this.nRows = nRows; this.nCols = nCols;
    }
    getValues() {
      rec('getValues', { sheet: this.sheet.name, r: this.r, c: this.c, nRows: this.nRows, nCols: this.nCols });
      const out = [];
      for (let i = 0; i < this.nRows; i++) {
        const row = [];
        const src = this.sheet.data[this.r - 1 + i] || [];
        for (let j = 0; j < this.nCols; j++) {
          const v = src[this.c - 1 + j];
          row.push(typeof v === 'undefined' ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    getValue() {
      rec('getValue', { sheet: this.sheet.name, r: this.r, c: this.c });
      const src = this.sheet.data[this.r - 1] || [];
      const v = src[this.c - 1];
      return typeof v === 'undefined' ? '' : v;
    }
    setValues(values) {
      rec('setValues', { sheet: this.sheet.name, r: this.r, c: this.c, nRows: values.length, nCols: (values[0] || []).length });
      for (let i = 0; i < values.length; i++) {
        const rr = this.r - 1 + i;
        if (!this.sheet.data[rr]) this.sheet.data[rr] = [];
        for (let j = 0; j < values[i].length; j++) {
          this.sheet.data[rr][this.c - 1 + j] = values[i][j];
        }
      }
      return this;
    }
    setValue(value) {
      rec('setValue', { sheet: this.sheet.name, r: this.r, c: this.c });
      const rr = this.r - 1;
      if (!this.sheet.data[rr]) this.sheet.data[rr] = [];
      this.sheet.data[rr][this.c - 1] = value;
      return this;
    }
    setNote() { rec('setNote'); return this; }
    setFontWeight() { rec('setFontWeight'); return this; }
    setBackground() { rec('setBackground'); return this; }
    setFontColor() { rec('setFontColor'); return this; }
    setNumberFormat() { rec('setNumberFormat'); return this; }
    setFontSize() { rec('setFontSize'); return this; }
    setFormula() { rec('setFormula'); return this; }
    getFormula() { rec('getFormula'); return ''; }
    setDataValidation() { rec('setDataValidation'); return this; }
    getColumn() { return this.c; }
    getNumColumns() { return this.nCols; }
    createTextFinder(text) {
      rec('createTextFinder', { sheet: this.sheet.name, text: String(text) });
      const self = this;
      const finder = {
        matchEntireCell() { return finder; },
        matchCase() { return finder; },
        findNext() {
          rec('findNext');
          const want = String(text);
          for (let i = 0; i < self.nRows; i++) {
            const src = self.sheet.data[self.r - 1 + i] || [];
            for (let j = 0; j < self.nCols; j++) {
              if (String(src[self.c - 1 + j] ?? '') === want) {
                return new FakeRange(self.sheet, self.r + i, self.c + j, 1, 1);
              }
            }
          }
          return null;
        }
      };
      return finder;
    }
  }

  class FakeSheet {
    constructor(name, data) {
      this.name = name;
      this.data = data || [];
      this.hidden = false;
      this._maxCols = 26;
    }
    _size() { return usedSize(this.data); }
    getLastRow() { rec('getLastRow', { sheet: this.name }); return this._size().lastRow; }
    getLastColumn() { rec('getLastColumn', { sheet: this.name }); return this._size().lastCol; }
    getRange(a, b, c, d) {
      rec('getRange', { sheet: this.name });
      if (typeof a === 'string') throw new Error('A1 getRange not mocked: ' + a);
      const nRows = typeof c === 'number' ? c : 1;
      const nCols = typeof d === 'number' ? d : 1;
      return new FakeRange(this, a, b, nRows, nCols);
    }
    getDataRange() {
      rec('getDataRange', { sheet: this.name });
      const { lastRow, lastCol } = this._size();
      return this.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, 1));
    }
    clearContents() {
      rec('clearContents', { sheet: this.name });
      this.data = [];
      return this;
    }
    clear() { rec('clear', { sheet: this.name }); this.data = []; return this; }
    hideSheet() { rec('hideSheet', { sheet: this.name }); this.hidden = true; }
    insertRowBefore(row) {
      rec('insertRowBefore', { sheet: this.name });
      this.data.splice(row - 1, 0, []);
    }
    insertColumnAfter(col) {
      rec('insertColumnAfter', { sheet: this.name });
      for (const row of this.data) row.splice(col, 0, '');
    }
    insertColumnBefore(col) {
      rec('insertColumnBefore', { sheet: this.name });
      for (const row of this.data) row.splice(col - 1, 0, '');
    }
    setFrozenRows() { rec('setFrozenRows', { sheet: this.name }); }
    setFrozenColumns() { rec('setFrozenColumns', { sheet: this.name }); }
    setColumnWidth() { rec('setColumnWidth', { sheet: this.name }); }
    getMaxRows() { rec('getMaxRows', { sheet: this.name }); return 1000; }
    getConditionalFormatRules() { rec('getConditionalFormatRules', { sheet: this.name }); return this._cf || []; }
    setConditionalFormatRules(rules) { rec('setConditionalFormatRules', { sheet: this.name }); this._cf = rules; }
    setName() {}
  }

  const cacheStore = new Map();
  const CacheService = {
    getScriptCache() {
      rec('CacheService.getScriptCache');
      return {
        get(key) { rec('cache.get'); return cacheStore.has(key) ? cacheStore.get(key) : null; },
        put(key, value, ttl) { rec('cache.put'); cacheStore.set(key, String(value)); },
        getAll(keys) {
          rec('cache.getAll');
          const out = {};
          for (const k of keys) if (cacheStore.has(k)) out[k] = cacheStore.get(k);
          return out;
        },
        remove(key) { rec('cache.remove'); cacheStore.delete(key); },
        removeAll(keys) { rec('cache.removeAll'); for (const k of keys) cacheStore.delete(k); }
      };
    }
  };

  let flushCount = 0;
  const sheets = {};
  const ss = {
    getSheetByName(name) { rec('getSheetByName', { sheet: name }); return sheets[name] || null; },
    insertSheet(name) {
      rec('insertSheet', { sheet: name });
      sheets[name] = new FakeSheet(name, []);
      return sheets[name];
    },
    getSpreadsheetTimeZone() { return 'Asia/Kolkata'; }
  };

  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet() { rec('getActiveSpreadsheet'); return ss; },
      flush() { rec('flush'); flushCount += 1; },
      newDataValidation() {
        rec('newDataValidation');
        const b = {
          requireValueInList() { return b; },
          requireDate() { return b; },
          setAllowInvalid() { return b; },
          setHelpText() { return b; },
          build() { return { type: 'validation' }; }
        };
        return b;
      },
      newConditionalFormatRule() {
        rec('newConditionalFormatRule');
        const b = {
          whenTextEqualTo() { return b; },
          setBackground() { return b; },
          setFontColor() { return b; },
          setStrikethrough() { return b; },
          setRanges() { return b; },
          build() { return { getRanges: () => [] }; }
        };
        return b;
      }
    },
    LockService: {
      getScriptLock() {
        rec('getScriptLock');
        let held = false;
        return {
          waitLock() { rec('waitLock'); held = true; },
          hasLock() { rec('hasLock'); return held; },
          releaseLock() { rec('releaseLock'); held = false; }
        };
      }
    },
    CacheService,
    Logger: { log() { rec('Logger.log'); } },
    Utilities: {
      formatDate(date, tz, fmt) {
        const zone = tz || 'Asia/Kolkata';
        const partsOf = (options) =>
          new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: zone }, options)).formatToParts(date);
        const grab = (parts, type) => {
          const hit = parts.find((p) => p.type === type);
          return hit ? hit.value : '';
        };
        if (fmt === 'yyyy-MM-dd-HH-mm-ss') {
          const parts = partsOf({
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
          });
          return [grab(parts, 'year'), grab(parts, 'month'), grab(parts, 'day'),
            grab(parts, 'hour'), grab(parts, 'minute'), grab(parts, 'second')].join('-');
        }
        if (fmt === 'EEE, d MMM') {
          const parts = partsOf({ weekday: 'short', day: 'numeric', month: 'short' });
          return grab(parts, 'weekday') + ', ' + grab(parts, 'day') + ' ' + grab(parts, 'month');
        }
        if (fmt === 'yyyy') {
          return grab(partsOf({ year: 'numeric' }), 'year');
        }
        return String(date);
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: codePath });

  return { ctx, sheets, ss, calls, cacheStore, rec, FakeSheet, flush: () => flushCount };
}

function seedHappyPath(world, opts = {}) {
  const orderHeaders = BASE.concat(MENU, ['Assigned To']);
  const existingOrders = opts.existingOrders || [
    ['t', 'PB-EXISTING-1', '2026-11-29', '6:30 AM Mass', 'Ann', '9000000000', '1 x Rich Plum Cake (400g)', 1, 350, 'OK', '{}', '', '', '', '', '', 1]
  ];
  const ordersData = [orderHeaders, ...existingOrders.map((row) => {
    const r = orderHeaders.map(() => '');
    for (let i = 0; i < row.length && i < r.length; i++) r[i] = row[i];
    // place plum 400g qty if provided at the end or in the item column
    const plumIdx = orderHeaders.indexOf('Rich Plum Cake (400g)');
    if (plumIdx >= 0 && (row[plumIdx] || row[row.length - 1] === 1)) {
      r[plumIdx] = row[plumIdx] || 1;
    }
    return r;
  })];
  // Ensure the existing order has qty 1 in plum 400g
  const plumIdx = orderHeaders.indexOf('Rich Plum Cake (400g)');
  if (ordersData[1] && plumIdx >= 0) ordersData[1][plumIdx] = 1;

  const stockHeader = ['Item', '29 Nov 2026', 'Total'];
  const stockData = [stockHeader];
  const caps = {
    'Dates & Carrot Pudding (700g)': 15,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  };
  let stockTotal = 0;
  for (const name of MENU) {
    stockData.push([name, caps[name], caps[name]]);
    stockTotal += caps[name];
  }
  stockData.push(['TOTAL', stockTotal, stockTotal]);

  const lastRow = ordersData.length; // includes header, so last data row index+1 = length
  const tallyHeader = ['Item', '2026-11-29'];
  const tallyData = [
    ['#tally', lastRow, 'PB-EXISTING-1', '2026-11-29'],
    tallyHeader
  ];
  for (const name of MENU) {
    const used = name === 'Rich Plum Cake (400g)' ? 1 : 0;
    tallyData.push([name, used]);
  }

  const summaryData = [
    ['Weekly Summary — Vailankanni Parish Youth Cake Sale'],
    ['Live totals'],
    ['Pickup Date', 'Mass', 'Orders'],
    ['Sun, 29 Nov', '6:30 AM Mass', ''],
    ['Sun, 29 Nov', '8:30 AM Mass', ''],
    ['TOTAL', '', '']
  ];

  world.sheets['Orders'] = new world.FakeSheet('Orders', cloneGrid(ordersData));
  world.sheets['Stock'] = new world.FakeSheet('Stock', cloneGrid(stockData));
  world.sheets['Tally'] = new world.FakeSheet('Tally', cloneGrid(tallyData));
  world.sheets['Weekly Summary'] = new world.FakeSheet('Weekly Summary', cloneGrid(summaryData));
  return { lastRow, orderHeaders, plumIdx };
}

function sampleOrder(overrides = {}) {
  return Object.assign({
    orderId: 'PB-TEST-0001',
    timestamp: '23/11/2026, 15:00:00 IST',
    pickupDate: '2026-11-29',
    pickupDateLabel: 'Sun, 29 Nov',
    massLabel: '6:30 AM Mass',
    name: 'Asha',
    phone: '9876543210',
    items: [{ name: 'Rich Plum Cake (400g)', qty: 2, price: 350, lineTotal: 700 }],
    totalItems: 2,
    totalAmount: 700
  }, overrides);
}

function countCalls(calls) {
  const c = {};
  for (const x of calls) c[x.name] = (c[x.name] || 0) + 1;
  const style = (c.setFontWeight || 0) + (c.setBackground || 0) + (c.setFontColor || 0) +
    (c.setFrozenRows || 0) + (c.setColumnWidth || 0);
  const reads = (c.getValues || 0) + (c.getValue || 0) + (c.getDataRange || 0);
  const writes = (c.setValues || 0) + (c.setValue || 0) + (c.clearContents || 0) + (c.clear || 0);
  const meta = (c.getLastRow || 0) + (c.getLastColumn || 0) + (c.getRange || 0) + (c.getSheetByName || 0);
  const spreadsheet = (c.getActiveSpreadsheet || 0) + (c.flush || 0) + (c.getDataRange || 0) +
    (c.getValues || 0) + (c.getValue || 0) + (c.setValues || 0) + (c.setValue || 0) +
    (c.getLastRow || 0) + (c.getLastColumn || 0) + (c.getRange || 0) + (c.getSheetByName || 0) +
    (c.clearContents || 0) + (c.clear || 0) + (c.insertSheet || 0) + (c.insertRowBefore || 0) +
    (c.insertColumnAfter || 0) + (c.insertColumnBefore || 0) +
    (c.setFontWeight || 0) + (c.setBackground || 0) + (c.setFontColor || 0) +
    (c.setFrozenRows || 0) + (c.setFrozenColumns || 0) + (c.setColumnWidth || 0) +
    (c.setNote || 0) + (c.hideSheet || 0) + (c.createTextFinder || 0) + (c.findNext || 0);
  return {
    byName: c,
    spreadsheet,
    reads,
    writes,
    style,
    flush: c.flush || 0,
    getDataRange: c.getDataRange || 0,
    getHeadersApprox: c.getValues || 0,
    clearContents: c.clearContents || 0
  };
}

function measure(label, codePath, fn) {
  const world = makeWorld(codePath);
  const seeded = seedHappyPath(world);
  world.calls.length = 0; // count only the order path
  const result = fn(world, seeded);
  const stats = countCalls(world.calls);
  return { label, result, stats, world, seeded, calls: world.calls.slice() };
}

function runSuite(codePath, tag) {
  console.log('\n======== ' + tag + ' (' + codePath + ') ========');
  const out = {};

  out.saved = measure(tag + ' saved', codePath, (world) => {
    return world.ctx.processOrder_(sampleOrder(), {});
  });
  console.log(tag, 'saved result', out.saved.result);
  console.log(tag, 'saved calls', summarize(out.saved.stats));

  out.saved2 = measure(tag + ' saved2-warm', codePath, (world) => {
    // First order warms schema cache; second unique id still misses order-id cache
    world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-0001' }), {});
    world.calls.length = 0;
    return world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-0002' }), {});
  });
  console.log(tag, 'saved2 (warm schema) calls', summarize(out.saved2.stats));

  out.dup = measure(tag + ' duplicate', codePath, (world) => {
    const first = world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-0001' }), {});
    world.calls.length = 0;
    const second = world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-0001' }), {});
    return { first, second };
  });
  console.log(tag, 'duplicate result', out.dup.result.second, 'calls', summarize(out.dup.stats));

  out.insuff = measure(tag + ' insufficient', codePath, (world) => {
    return world.ctx.processOrder_(sampleOrder({
      orderId: 'PB-TEST-BIG',
      items: [{ name: 'Rich Plum Cake (400g)', qty: 999, price: 350, lineTotal: 349650 }],
      totalItems: 999,
      totalAmount: 349650
    }), {});
  });
  console.log(tag, 'insufficient result', out.insuff.result && { ok: out.insuff.result.ok, status: out.insuff.result.status });

  out.oversold = measure(tag + ' fallback-oversold', codePath, (world) => {
    return world.ctx.processOrder_(sampleOrder({
      orderId: 'PB-TEST-FB',
      items: [{ name: 'Rich Plum Cake (400g)', qty: 999, price: 350, lineTotal: 349650 }],
      totalItems: 999,
      totalAmount: 349650
    }), { fallback: true });
  });
  console.log(tag, 'fallback-oversold result', out.oversold.result && { ok: out.oversold.result.ok, status: out.oversold.result.status, oversold: out.oversold.result.oversold });

  return out;
}

function summarize(stats) {
  return {
    spreadsheet: stats.spreadsheet,
    reads: stats.reads,
    writes: stats.writes,
    style: stats.style,
    flush: stats.flush,
    getDataRange: stats.getDataRange,
    clearContents: stats.clearContents,
    getLastRow: stats.byName.getLastRow || 0,
    getLastColumn: stats.byName.getLastColumn || 0,
    getRange: stats.byName.getRange || 0,
    getValues: stats.byName.getValues || 0,
    setValues: stats.byName.setValues || 0,
    setValue: stats.byName.setValue || 0
  };
}

const before = runSuite(BEFORE, 'BEFORE');
const after = runSuite(AFTER, 'AFTER');

// Behaviour — after (and before should match)
for (const [tag, suite] of [['BEFORE', before], ['AFTER', after]]) {
  assert(tag + ' saved ok', suite.saved.result && suite.saved.result.ok === true && suite.saved.result.status === 'saved',
    JSON.stringify(suite.saved.result));
  const expectedStatus = tag === 'BEFORE' ? 'OK' : 'Pending';
  assert(tag + ' saved writes Status ' + expectedStatus, (() => {
    const sheet = suite.saved.world.sheets.Orders;
    const headers = sheet.data[0];
    const statusCol = headers.indexOf('Status');
    const last = sheet.data[sheet.data.length - 1];
    return last[statusCol] === expectedStatus;
  })());
  assert(tag + ' duplicate is ok/duplicate and does not append a second row',
    suite.dup.result.second.status === 'duplicate' && suite.dup.result.second.ok === true &&
    suite.dup.world.sheets.Orders.data.length === suite.saved.world.sheets.Orders.data.length);
  if (tag === 'BEFORE') {
    assert(tag + ' insufficient is rejected with no write',
      suite.insuff.result && suite.insuff.result.ok === false && suite.insuff.result.status === 'insufficient' &&
      suite.insuff.world.sheets.Orders.data.length === 2);
    assert(tag + ' fallback oversold writes OVERSOLD - CHECK', (() => {
      if (!suite.oversold.result || suite.oversold.result.status !== 'saved' || !suite.oversold.result.oversold) return false;
      const sheet = suite.oversold.world.sheets.Orders;
      const headers = sheet.data[0];
      const statusCol = headers.indexOf('Status');
      return sheet.data[sheet.data.length - 1][statusCol] === 'OVERSOLD - CHECK';
    })(), JSON.stringify(suite.oversold.result));
  } else {
    assert(tag + ' large qty still saves (pre-order, no stock check)',
      suite.insuff.result && suite.insuff.result.ok === true && suite.insuff.result.status === 'saved' &&
      suite.insuff.world.sheets.Orders.data.length === 3,
      JSON.stringify(suite.insuff.result));
    assert(tag + ' fallback large qty writes Status Pending (no OVERSOLD flag)', (() => {
      if (!suite.oversold.result || suite.oversold.result.status !== 'saved' || suite.oversold.result.oversold) return false;
      const sheet = suite.oversold.world.sheets.Orders;
      const headers = sheet.data[0];
      const statusCol = headers.indexOf('Status');
      return sheet.data[sheet.data.length - 1][statusCol] === 'Pending';
    })(), JSON.stringify(suite.oversold.result));
  }
}

// After-only fast-path invariants
assert('AFTER saved does not restyle the Orders header', after.saved.stats.style === 0,
  JSON.stringify(after.saved.stats));
assert('AFTER saved does not clear/rewrite the whole Tally sheet',
  after.saved.stats.clearContents === 0, JSON.stringify(after.saved.stats));
assert('AFTER saved does not use getDataRange', after.saved.stats.getDataRange === 0);
assert('AFTER saved flushes once', after.saved.stats.flush === 1, String(after.saved.stats.flush));
assert('AFTER large qty also flushes once (it was written)', after.insuff.stats.flush === 1, String(after.insuff.stats.flush));
assert('AFTER duplicate does not flush (no write)', after.dup.stats.flush === 0, String(after.dup.stats.flush));

// Tally is off the checkout hot path (Weekly Summary formulas use Orders).
(function () {
  const tally = after.saved.world.sheets.Tally;
  const plumRow = tally.data.find((r) => r[0] === 'Rich Plum Cake (400g)');
  assert('AFTER tally is left unchanged', plumRow && Number(plumRow[1]) === 1, JSON.stringify(plumRow));
  const tallyWrites = after.saved.calls.filter((c) => (c.name === 'setValues' || c.name === 'setValue' || c.name === 'clearContents') && c.sheet === 'Tally');
  assert('AFTER saved does not write the Tally sheet', tallyWrites.length === 0, JSON.stringify(tallyWrites));
})();

(function () {
  const headers = after.saved.world.sheets.Orders.data[0];
  const last = after.saved.world.sheets.Orders.data[after.saved.world.sheets.Orders.data.length - 1];
  const pickup = last[headers.indexOf('Pickup Date')];
  const mass = last[headers.indexOf('Mass')];
  const phone = last[headers.indexOf('Phone')];
  assert('AFTER saved writes Pickup Date as an ISO text id', pickup === '2026-11-29', String(pickup));
  assert('AFTER saved writes Mass as the 6:30 AM Mass label', mass === '6:30 AM Mass', String(mass));
  const fmt = after.saved.calls.filter((c) => c.name === 'setNumberFormat');
  const written = after.saved.calls.find((c) => c.name === 'setValues' && c.sheet === 'Orders');
  const firstFmt = after.saved.calls.find((c) => c.name === 'setNumberFormat');
  assert('AFTER saved sets plain-text format on date/mass/phone before setValues',
    fmt.length >= 1 && written && firstFmt && after.saved.calls.indexOf(firstFmt) < after.saved.calls.indexOf(written),
    JSON.stringify({ formats: fmt.length, pickup, mass, phone }));
})();

// Schema fast path: a missing item name should go through ensure and add the column
(function () {
  const world = makeWorld(AFTER);
  seedHappyPath(world);
  world.calls.length = 0;
  const result = world.ctx.processOrder_(sampleOrder({
    orderId: 'PB-TEST-NEWITEM',
    items: [
      { name: 'Rich Plum Cake (400g)', qty: 1, price: 350, lineTotal: 350 },
      { name: 'Special Marzipan Cake (500g)', qty: 1, price: 400, lineTotal: 400 }
    ],
    totalItems: 2,
    totalAmount: 750
  }), {});
  const headers = world.sheets.Orders.data[0];
  // Pre-order: a new item name still extends the Orders header, and the
  // row is saved (no stock check).
  assert('schema slow path appends a new item column',
    headers.includes('Special Marzipan Cake (500g)'),
    JSON.stringify({ status: result.status, headers }));
  assert('new item is saved on a pre-order (no stock rejection)',
    result.status === 'saved' && result.ok === true, JSON.stringify(result));
  assert('schema slow path styles once because headers changed',
    (countCalls(world.calls).style > 0), JSON.stringify(countCalls(world.calls)));
})();

// Direct readOrdersHeadersFast_ should not style when headers already ok
(function () {
  const world = makeWorld(AFTER);
  seedHappyPath(world);
  world.calls.length = 0;
  const headers = world.ctx.readOrdersHeadersFast_(world.sheets.Orders, MENU);
  const stats = countCalls(world.calls);
  assert('readOrdersHeadersFast_ returns existing headers', headers[0] === 'Timestamp' && headers.includes('Rich Plum Cake (400g)'));
  assert('readOrdersHeadersFast_ does not style or write',
    stats.style === 0 && stats.writes === 0,
    JSON.stringify(stats));
})();

assert('AFTER first saved uses fewer spreadsheet calls than BEFORE',
  after.saved.stats.spreadsheet < before.saved.stats.spreadsheet,
  'before=' + before.saved.stats.spreadsheet + ' after=' + after.saved.stats.spreadsheet);
assert('AFTER first saved does not write more often than BEFORE, and skips style/clear/full-tally rewrite',
  after.saved.stats.writes <= before.saved.stats.writes &&
  after.saved.stats.style === 0 && after.saved.stats.clearContents === 0 &&
  after.saved.stats.flush <= before.saved.stats.flush,
  'before=' + JSON.stringify(summarize(before.saved.stats)) + ' after=' + JSON.stringify(summarize(after.saved.stats)));

// ---- 'Assigned To' column (v.12) ----
{
  const world = makeWorld(CODE_GS);
  seedHappyPath(world);
  const res = world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-ASG1', assignedTo: 'Aashwin Alfy', assignedContactId: 'aashwin' }), {});
  const data = world.sheets['Orders'].data;
  const hdr = data[0];
  const idx = hdr.indexOf('Assigned To');
  const row = data.find((r) => r && r[1] === 'PB-TEST-ASG1');
  assert('assigned: order saved', res.ok === true && res.status === 'saved', JSON.stringify(res));
  assert('assigned: Assigned To column holds the contact name', idx >= 0 && row && row[idx] === 'Aashwin Alfy', JSON.stringify({ idx, row }));
}
{
  // Existing live sheet without the column: first order appends it at the right, data stays intact.
  const world = makeWorld(CODE_GS);
  seedHappyPath(world);
  const sheet = world.sheets['Orders'];
  const at = sheet.data[0].indexOf('Assigned To');
  sheet.data.forEach((r) => r.splice(at, 1));
  const before = sheet.data[1].slice();
  const res = world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-ASG2', assignedTo: 'Cyril Martin' }), {});
  const hdr = sheet.data[0];
  const idx = hdr.indexOf('Assigned To');
  const row = sheet.data.find((r) => r && r[1] === 'PB-TEST-ASG2');
  assert('migrate: Assigned To appended as the last column', idx === hdr.length - 1, JSON.stringify(hdr));
  assert('migrate: existing row untouched', JSON.stringify(sheet.data[1].slice(0, before.length)) === JSON.stringify(before));
  assert('migrate: new row has Assigned To', res.ok && row && row[idx] === 'Cyril Martin', JSON.stringify(row));
}
{
  // Older page (no assignedTo) still saves; column left blank.
  const world = makeWorld(CODE_GS);
  seedHappyPath(world);
  const res = world.ctx.processOrder_(sampleOrder({ orderId: 'PB-TEST-ASG3' }), {});
  const data = world.sheets['Orders'].data;
  const idx = data[0].indexOf('Assigned To');
  const row = data.find((r) => r && r[1] === 'PB-TEST-ASG3');
  assert('legacy payload: saved with blank Assigned To', res.ok && row && (row[idx] === '' || row[idx] == null), JSON.stringify(row));
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== CALL COUNTS (first saved order, schema already ok, tally in sync) ===');
console.log('BEFORE', summarize(before.saved.stats));
console.log('AFTER ', summarize(after.saved.stats));
console.log('BEFORE warm', summarize(before.saved2.stats));
console.log('AFTER  warm', summarize(after.saved2.stats));
console.log('\n--- processOrder mocks ' + (results.length - failed.length) + '/' + results.length + ' passed ---');

// Write a machine-readable summary for the report
fs.writeFileSync(ROOT + '/tests/fixtures/call-counts.json', JSON.stringify({
  before: { saved: summarize(before.saved.stats), warm: summarize(before.saved2.stats), insuff: summarize(before.insuff.stats) },
  after: { saved: summarize(after.saved.stats), warm: summarize(after.saved2.stats), insuff: summarize(after.insuff.stats) }
}, null, 2));

if (failed.length) {
  console.error(failed);
  process.exit(1);
}
