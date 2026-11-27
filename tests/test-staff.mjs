import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import fs from 'fs';
import vm from 'vm';

const CODE = CODE_GS;
const src = fs.readFileSync(CODE, 'utf8');

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
const WALKIN = ['Date', 'Mass', 'Item', 'Qty', 'Price each', 'Amount', 'Payment', 'Notes', 'Walk-in ID', 'Void'];
const DATES = [
  { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30' },
  { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: '2026-12-06T08:30:00+05:30' },
  { id: '2026-12-13', label: 'Sun, 13 Dec', closesAt: '2026-12-13T08:30:00+05:30' }
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

function makeWorld(opts = {}) {
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
    getRow() { return this.r; }
    getColumn() { return this.c; }
    getNumColumns() { return this.nCols; }
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
      rec('setValues', { sheet: this.sheet.name, r: this.r, c: this.c });
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
      rec('setValue', { sheet: this.sheet.name, r: this.r, c: this.c, value });
      const rr = this.r - 1;
      if (!this.sheet.data[rr]) this.sheet.data[rr] = [];
      this.sheet.data[rr][this.c - 1] = value;
      return this;
    }
    setNote() { return this; }
    setFontWeight() { return this; }
    _style(key, value) {
      this.sheet.styles = this.sheet.styles || {};
      for (let i = 0; i < this.nRows; i++) {
        const row = this.r + i;
        this.sheet.styles[row] = Object.assign(this.sheet.styles[row] || {}, { [key]: value, cols: this.nCols });
      }
      return this;
    }
    setBackground(v) { return this._style('background', v); }
    setFontColor(v) { return this._style('color', v); }
    setFontLine(v) {
      if (this.sheet.failFontLine) throw new Error('setFontLine failed');
      return this._style('line', v);
    }
    setNumberFormat() { return this; }
    setFontSize() { return this; }
    setFormula(f) { rec('setFormula', { r: this.r, c: this.c }); this.sheet.formulas = this.sheet.formulas || {}; this.sheet.formulas[this.r + ':' + this.c] = f; return this; }
    getFormula() { return (this.sheet.formulas && this.sheet.formulas[this.r + ':' + this.c]) || ''; }
    setDataValidation() { return this; }
    createTextFinder(text) {
      rec('createTextFinder', { text: String(text) });
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
      this.hiddenCols = [];
    }
    _size() { return usedSize(this.data); }
    getLastRow() { rec('getLastRow', { sheet: this.name }); return this._size().lastRow; }
    getLastColumn() { rec('getLastColumn', { sheet: this.name }); return this._size().lastCol; }
    getRange(a, b, c, d) {
      if (typeof a === 'string') throw new Error('A1 getRange not mocked: ' + a);
      const nRows = typeof c === 'number' ? c : 1;
      const nCols = typeof d === 'number' ? d : 1;
      return new FakeRange(this, a, b, nRows, nCols);
    }
    getDataRange() {
      const { lastRow, lastCol } = this._size();
      return this.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, 1));
    }
    insertColumnAfter(col) {
      rec('insertColumnAfter', { sheet: this.name, col });
      for (const row of this.data) row.splice(col, 0, '');
    }
    setFrozenRows() {}
    setFrozenColumns() {}
    setColumnWidth(col, w) { this.widths = this.widths || {}; this.widths[col] = w; }
    hideColumns(col) { if (this.hiddenCols.indexOf(col) < 0) this.hiddenCols.push(col); }
    showColumns(col) { this.hiddenCols = this.hiddenCols.filter((c) => c !== col); }
    isColumnHiddenByUser(col) { return this.hiddenCols.indexOf(col) >= 0; }
    getMaxRows() { return 1000; }
    getConditionalFormatRules() { return this._cf || []; }
    setConditionalFormatRules(rules) { this._cf = rules; }
    hideSheet() { this.hidden = true; }
    clear() { this.data = []; }
    clearContents() { this.data = []; }
  }

  const cacheStore = new Map();
  const props = Object.assign({}, opts.props || {});
  const CacheService = {
    getScriptCache() {
      return {
        get(key) { return cacheStore.has(key) ? cacheStore.get(key) : null; },
        put(key, value) { cacheStore.set(key, String(value)); },
        remove(key) { cacheStore.delete(key); },
        getAll(keys) {
          const out = {};
          for (const k of keys) if (cacheStore.has(k)) out[k] = cacheStore.get(k);
          return out;
        },
        removeAll(keys) { for (const k of keys) cacheStore.delete(k); }
      };
    }
  };

  const sheets = {};
  const ss = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      sheets[name] = new FakeSheet(name, []);
      return sheets[name];
    },
    getSpreadsheetTimeZone() { return 'Asia/Kolkata'; },
    setActiveSheet() {}
  };

  const outputs = [];
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet() { return ss; },
      flush() {},
      getUi() {
        return {
          ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
          Button: { OK: 'OK', CANCEL: 'CANCEL' },
          alert() {},
          prompt() {
            return {
              getSelectedButton: () => 'OK',
              getResponseText: () => String(opts.promptPin || '')
            };
          },
          createMenu() {
            const m = {
              addItem() { return m; },
              addToUi() { return m; }
            };
            return m;
          }
        };
      },
      newDataValidation() {
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
        let held = false;
        return {
          waitLock() { held = true; },
          hasLock() { return held; },
          releaseLock() { held = false; }
        };
      }
    },
    CacheService,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty(k, v) { props[k] = String(v); }
        };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput(s) {
        const out = { body: s, setMimeType() { return out; } };
        outputs.push(out);
        return out;
      }
    },
    Logger: { log() {} },
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
        if (fmt === 'dd MMM yyyy, HH:mm') {
          const parts = partsOf({
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
          });
          return grab(parts, 'day') + ' ' + grab(parts, 'month') + ' ' + grab(parts, 'year') + ', ' +
            grab(parts, 'hour') + ':' + grab(parts, 'minute');
        }
        if (fmt === 'yyyy') return grab(partsOf({ year: 'numeric' }), 'year');
        return String(date);
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: CODE });
  return { ctx, sheets, ss, calls, cacheStore, props, FakeSheet, outputs };
}

function seed(world, extra = {}) {
  const orderHeaders = BASE.concat(MENU, ['Assigned To']);
  const rows = extra.orders || [
    ['2026-11-23T09:00:00+05:30', 'PB-1', '2026-11-29', '6:30 AM Mass', 'Anita DSouza', '9876543210',
      '1 × Dates & Carrot Pudding (700g)', 1, 650, 'Pending', '{}'],
    ['2026-11-23T10:00:00+05:30', 'PB-2', '2026-11-29', '8:30 AM Mass', 'Cyril Martin', '7204017793',
      '1 × Butterscotch Pudding (700g)', 1, 700, 'Paid', '{}'],
    ['2026-11-23T11:00:00+05:30', 'PB-3', '2026-11-29', '6:30 AM Mass', 'TEST ORDER - delete me', '9000000000',
      '1 × Rich Plum Cake (400g)', 1, 350, 'Pending', '{}'],
    ['2026-11-23T12:00:00+05:30', 'PB-4', '2026-12-06', '8:30 AM Mass', 'Rohan Naik', '9811122233',
      '1 × Dates & Carrot Pudding (700g)', 1, 650, 'Pending', '{}']
  ];
  const ordersData = [orderHeaders];
  for (const row of rows) {
    const r = orderHeaders.map(() => '');
    for (let i = 0; i < row.length && i < r.length; i++) r[i] = row[i];
    ordersData.push(r);
  }
  const stockHeader = ['Item', '29 Nov 2026', '6 Dec 2026', 'Total'];
  const stockData = [stockHeader];
  for (const name of MENU) stockData.push([name, 20, 20, 40]);
  stockData.push(['TOTAL', 120, 120, 240]);

  const walkinData = extra.walkins || [
    WALKIN.slice(),
    ['2026-11-29', '8:30 AM Mass', 'Dates & Carrot Pudding (700g)', 1, 650, 650, 'Cash', '', 'WI-1', ''],
    ['2026-11-29', '8:30 AM Mass', 'Rich Plum Cake (400g)', 2, 350, 700, 'UPI', '', 'WI-2', '']
  ];

  world.sheets['Orders'] = new world.FakeSheet('Orders', cloneGrid(ordersData));
  world.sheets['Stock'] = new world.FakeSheet('Stock', cloneGrid(stockData));
  world.sheets['Walk-in Sales'] = new world.FakeSheet('Walk-in Sales', cloneGrid(walkinData));
  world.sheets['Tally'] = new world.FakeSheet('Tally', [['#tally', 5, 'PB-4', '2026-11-29']]);
  world.sheets['Weekly Summary'] = new world.FakeSheet('Weekly Summary', [['Weekly Summary']]);
  return { orderHeaders };
}

// ---- static source checks ----
assert('version is 2026-11-27.1', /var SCRIPT_VERSION = '2026-11-27.1'/.test(src));
assert('doPost routes staff actions without using processOrder_ first',
  /isStaffAction_\(data\.action\)/.test(src) &&
  /handleStaffAction_\(data\)/.test(src));
assert('Status Updated is not a required hot-path header',
  !/BASE_HEADERS = \[[^\]]*'Status Updated'/s.test(src) &&
  /'Status Updated'/.test(src) &&
  src.includes("'Status Updated'"));
assert('Set staff PIN is on the Cake Sale menu',
  /addItem\('Set staff PIN…', 'promptSetStaffPin'\)/.test(src));
assert('setupSheets reminds if the PIN is missing',
  /remindStaffPinIfMissing_\(\)/.test(src));
assert('void walk-ins are skipped in the summary',
  /isVoidWalkIn_\(wcell\(row, 'Void'\), wcell\(row, 'Notes'\)\)/.test(src));

// ---- PIN / rate limit ----
{
  const world = makeWorld();
  const { pinsEqual_, checkStaffAuth_, sanitizeClientToken_ } = world.ctx;
  assert('pinsEqual_ matches the same PIN', pinsEqual_('2468', '2468') === true);
  assert('pinsEqual_ rejects a different PIN', pinsEqual_('2468', '2469') === false);
  assert('pinsEqual_ rejects a different length', pinsEqual_('2468', '24680') === false);
  assert('short client tokens collapse to anon', sanitizeClientToken_('ab') === 'anon');
  assert('client tokens keep safe characters', sanitizeClientToken_('Abc_12-zzzz') === 'Abc_12-zzzz');

  const cache = world.ctx.CacheService.getScriptCache();
  const unset = checkStaffAuth_({ pin: '1234', clientToken: 'tokentoken1' }, { pin: '', cache });
  assert('unset STAFF_PIN refuses every staff call', unset.status === 'pin_unset' && unset.ok === false);

  const token = 'deviceTokenA1';
  let last;
  for (let i = 0; i < 4; i++) {
    last = checkStaffAuth_({ pin: '0000', clientToken: token }, { pin: '2468', cache });
  }
  assert('four wrong PINs stay unauthorized', last.status === 'unauthorized' && last.ok === false, last.status);
  last = checkStaffAuth_({ pin: '0000', clientToken: token }, { pin: '2468', cache });
  assert('fifth wrong PIN locks the client token', last.status === 'locked' && last.ok === false, last.status);
  const still = checkStaffAuth_({ pin: '2468', clientToken: token }, { pin: '2468', cache });
  assert('correct PIN is refused while locked', still.status === 'locked' && still.ok === false);

  const ok = checkStaffAuth_({ pin: '2468', clientToken: 'deviceTokenB2' }, { pin: '2468', cache });
  assert('correct PIN authenticates a fresh token', ok.ok === true && ok.status === 'ok');

  checkStaffAuth_({ pin: '0000', clientToken: 'deviceTokenC3' }, { pin: '2468', cache });
  const recovered = checkStaffAuth_({ pin: '2468', clientToken: 'deviceTokenC3' }, { pin: '2468', cache });
  assert('a successful login clears earlier failures', recovered.ok === true);
}

// ---- listing helpers ----
{
  const world = makeWorld();
  const { staffOrdersFromValues_, staffWalkInsFromValues_, isVoidWalkIn_, nextUpcomingPickupDateId_ } = world.ctx;
  const now = new Date('2026-11-23T12:00:00+05:30');
  assert('next upcoming date after 23 Nov is 29 Nov',
    nextUpcomingPickupDateId_(DATES, now) === '2026-11-29');

  const headers = BASE.concat(MENU, ['Assigned To']);
  function row(over) {
    const r = headers.map(() => '');
    const set = (n, v) => { r[headers.indexOf(n)] = v; };
    set('Timestamp', over.timestamp || '2026-11-23T09:00:00+05:30');
    set('Order ID', over.orderId || 'PB-X');
    set('Pickup Date', over.pickupDate || '2026-11-29');
    set('Mass', over.mass || '6:30 AM Mass');
    set('Name', over.name || 'Ann');
    set('Phone', over.phone || '9876543210');
    set('Items', over.items || '1 × Rich Plum Cake (400g)');
    set('Total Items', over.totalItems || 1);
    set('Total Amount (₹)', over.amount || 350);
    set('Status', over.status || 'Pending');
    return r;
  }
  const values = [
    headers,
    row({ orderId: 'PB-1', name: 'Anita DSouza', phone: '9876543210', amount: 650, status: 'Pending', items: '1 × Dates 700g' }),
    row({ orderId: 'PB-2', name: 'Cyril Martin', phone: '7204017793', mass: '8:30 AM Mass', amount: 700, status: 'Paid', items: '1 × Butterscotch 700g' }),
    row({ orderId: 'PB-3', name: 'TEST ORDER - delete me', amount: 350, status: 'Pending' }),
    row({ orderId: 'PB-4', name: 'Maria Fernandes', phone: '9988776655', amount: 1310, status: 'Picked up' }),
    row({ orderId: 'PB-5', name: 'Rohan Naik', pickupDate: '2026-12-06', amount: 650, status: 'Pending' })
  ];
  const listed = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29' });
  assert('staff_orders defaults to the requested date and skips TEST ORDER',
    listed.ok && listed.orders.length === 3 && listed.orders.every((o) => o.orderId !== 'PB-3' && o.pickupDate === '2026-11-29'),
    JSON.stringify(listed.orders.map((o) => o.orderId)));
  assert('staff_orders returns name, phone, items, total, status, row',
    listed.orders[0].name === 'Anita DSouza' &&
    listed.orders[0].phone === '9876543210' &&
    listed.orders[0].total === 650 &&
    listed.orders[0].status === 'Pending' &&
    listed.orders[0].row === 2);
  // an existing sheet may still have a filled-in legacy 'Assigned To' column: it is ignored
  const legacyValues = values.map((r) => r.slice());
  legacyValues[1][headers.indexOf('Assigned To')] = 'Aashwin Alfy';
  const legacyListed = staffOrdersFromValues_(legacyValues, { dates: DATES, now, pickupDate: '2026-11-29' });
  assert('staff_orders no longer returns assignedTo, even when a legacy column has values',
    legacyListed.ok && legacyListed.orders.length === 3 && legacyListed.orders.every((o) => !('assignedTo' in o)),
    JSON.stringify(legacyListed.orders[0]));
  assert('counters: to collect, picked up, pending',
    listed.counts.toCollect === 1 &&
    listed.counts.toCollectAmount === 650 &&
    listed.counts.pickedUp === 1 &&
    listed.counts.pending === 2,
    JSON.stringify(listed.counts));

  const byPhone = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29', q: '7793' });
  assert('search matches last phone digits',
    byPhone.orders.length === 1 && byPhone.orders[0].orderId === 'PB-2');
  const byName = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29', q: 'anita' });
  assert('search matches name', byName.orders.length === 1 && byName.orders[0].orderId === 'PB-1');
  const byId = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29', q: 'PB-4' });
  assert('search matches order ID', byId.orders.length === 1 && byId.orders[0].name.indexOf('Maria') === 0);
  const massed = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29', mass: '06:30' });
  const unfiltered = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29' });
  assert('a legacy mass option is ignored and orders carry no mass field',
    massed.orders.length === unfiltered.orders.length && massed.orders.length > 0 &&
    massed.orders.every((o) => !('mass' in o)) && !('mass' in massed),
    JSON.stringify(massed.orders.map((o) => o.mass)));
  const withTest = staffOrdersFromValues_(values, { dates: DATES, now, pickupDate: '2026-11-29', includeTest: true });
  assert('includeTest returns the TEST ORDER row',
    withTest.orders.some((o) => o.orderId === 'PB-3'));
  const def = staffOrdersFromValues_(values, { dates: DATES, now });
  assert('missing date defaults to the next upcoming pickup', def.pickupDate === '2026-11-29');

  assert('VOID in Void column is void', isVoidWalkIn_('VOID', '') === true);
  assert('VOID prefix in Notes is void', isVoidWalkIn_('', 'VOID typo') === true);
  assert('normal notes are not void', isVoidWalkIn_('', 'paid at desk') === false);

  const wvalues = [
    WALKIN,
    ['2026-11-29', '8:30 AM Mass', 'Dates & Carrot Pudding (700g)', 1, 650, 650, 'Cash', '', 'WI-1', ''],
    ['2026-11-29', '8:30 AM Mass', 'Rich Plum Cake (400g)', 2, 350, 700, 'UPI', '', 'WI-2', 'VOID'],
    ['2026-11-29', '6:30 AM Mass', 'Butterscotch Pudding (350g)', 1, 350, 350, 'Cash', 'VOID extra', 'WI-3', '']
  ];
  const wlist = staffWalkInsFromValues_(wvalues, { date: '2026-11-29', dates: DATES, now });
  assert('staff_walkins hides voided rows',
    wlist.walkins.length === 1 && wlist.walkins[0].walkinId === 'WI-1',
    JSON.stringify(wlist.walkins.map((w) => w.walkinId)));
  const withVoid = staffWalkInsFromValues_(wvalues, { date: '2026-11-29', dates: DATES, now, includeVoid: true });
  assert('includeVoid returns voided walk-ins', withVoid.walkins.length === 3);
}

// ---- handleStaffAction auth wall ----
{
  const world = makeWorld();
  seed(world);
  const denied = world.ctx.handleStaffAction_({
    action: 'staff_orders',
    pin: '1111',
    clientToken: 'deviceTokenD4',
    pickupDate: '2026-11-29'
  });
  assert('staff_orders without a valid PIN returns no buyer data',
    denied.ok === false &&
    denied.status === 'pin_unset' &&
    !denied.orders,
    JSON.stringify(denied));

  world.props.STAFF_PIN = '2468';
  const wrong = world.ctx.handleStaffAction_({
    action: 'staff_orders',
    pin: '1111',
    clientToken: 'deviceTokenE5',
    pickupDate: '2026-11-29'
  });
  assert('wrong PIN does not return orders',
    wrong.ok === false && wrong.status === 'unauthorized' && !wrong.orders);

  const login = world.ctx.handleStaffAction_({
    action: 'staff_login',
    pin: '2468',
    clientToken: 'deviceTokenE5'
  });
  assert('staff_login accepts the correct PIN', login.ok === true && login.version === '2026-11-27.1');

  const listed = world.ctx.handleStaffAction_({
    action: 'staff_orders',
    pin: '2468',
    clientToken: 'deviceTokenE5',
    pickupDate: '2026-11-29'
  });
  assert('staff_orders with a valid PIN lists church orders and skips TEST ORDER',
    listed.ok && listed.orders.length === 2 && listed.orders.every((o) => o.name.indexOf('TEST') === -1),
    JSON.stringify(listed.orders && listed.orders.map((o) => o.name)));
}

// ---- set status conflict / success ----
{
  const world = makeWorld({ props: { STAFF_PIN: '2468' } });
  seed(world);
  const ok = world.ctx.staffSetStatus_({
    orderId: 'PB-1',
    status: 'Paid',
    expectedStatus: 'Pending'
  });
  assert('staff_set_status writes Paid when the expected status matches',
    ok.ok === true && ok.status === 'Paid' && ok.previousStatus === 'Pending',
    JSON.stringify(ok));
  const headers = world.sheets['Orders'].data[0];
  const statusCol = headers.indexOf('Status');
  const updatedCol = headers.indexOf('Status Updated');
  assert('Status Updated column is added and stamped',
    updatedCol >= 0 && String(world.sheets['Orders'].data[1][updatedCol] || '').length > 0,
    String(world.sheets['Orders'].data[1][updatedCol]));
  assert('Status cell is Paid', world.sheets['Orders'].data[1][statusCol] === 'Paid');

  const conflict = world.ctx.staffSetStatus_({
    orderId: 'PB-1',
    status: 'Picked up',
    expectedStatus: 'Pending'
  });
  assert('stale expected status returns a conflict with the current value',
    conflict.ok === false && conflict.status === 'conflict' && conflict.currentStatus === 'Paid',
    JSON.stringify(conflict));
  assert('conflict does not overwrite the current status',
    world.sheets['Orders'].data[1][statusCol] === 'Paid');

  const found = world.ctx.staffSetStatus_({
    orderId: 'NO-SUCH',
    status: 'Paid',
    expectedStatus: 'Pending'
  });
  assert('unknown orderId is not_found', found.status === 'not_found' && found.ok === false);
}

// ---- walk-in recorded time (Recorded At) ----
{
  const world = makeWorld({ props: { STAFF_PIN: '2468' } });
  seed(world);
  const NOW = Date.UTC(2026, 10, 24, 10, 0, 0);
  const norm = (v) => world.ctx.normalizeRecordedAt_(v, NOW);
  assert('recordedAt: a valid recent ISO time is kept as ISO', norm('2026-11-24T09:15:20.000Z') === '2026-11-24T09:15:20.000Z', norm('2026-11-24T09:15:20.000Z'));
  assert('recordedAt: non-UTC offsets are normalised to ISO UTC', norm('2026-11-24T14:45:20+05:30') === '2026-11-24T09:15:20.000Z', norm('2026-11-24T14:45:20+05:30'));
  assert('recordedAt: garbage falls back to now', norm('not a date') === new Date(NOW).toISOString() && norm('') === new Date(NOW).toISOString() && norm(undefined) === new Date(NOW).toISOString() && norm(12345) === new Date(NOW).toISOString());
  assert('recordedAt: older than 14 days falls back to now', norm('2026-11-01T00:00:00.000Z') === new Date(NOW).toISOString());
  assert('recordedAt: more than 5 minutes in the future falls back to now', norm('2026-11-24T10:30:00.000Z') === new Date(NOW).toISOString());
  assert('recordedAt: up to 5 minutes ahead is tolerated (clock skew)', norm('2026-11-24T10:04:00.000Z') === '2026-11-24T10:04:00.000Z');

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const first = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-REC-1', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'Cash', recordedAt: hourAgo
  });
  assert('staff_add_walkin returns the recorded time', first.ok && first.recordedAt === hourAgo, JSON.stringify(first));
  const tab = world.sheets['Walk-in Sales'];
  const recCol = tab.data[0].indexOf('Recorded At');
  assert('Recorded At column is created on the Walk-in Sales tab', recCol >= 0, JSON.stringify(tab.data[0]));
  assert('Recorded At is stored as the ISO string', tab.data[first.row - 1][recCol] === hourAgo, String(tab.data[first.row - 1][recCol]));

  const bad = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-REC-2', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'UPI',
    recordedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  });
  const fut = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-REC-3', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'UPI',
    recordedAt: new Date(Date.now() + 3600 * 1000).toISOString()
  });
  const none = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-REC-4', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'UPI'
  });
  const near = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 60 * 1000;
  assert('too-old, future and missing recordedAt all fall back to the server time', near(bad.recordedAt) && near(fut.recordedAt) && near(none.recordedAt), JSON.stringify({ bad: bad.recordedAt, fut: fut.recordedAt, none: none.recordedAt }));

  const listed = world.ctx.staffWalkInsFromValues_(tab.data, { date: '2026-11-29', dates: DATES });
  const row1 = listed.walkins.find((w) => w.walkinId === 'WI-REC-1');
  assert('staff_walkins rows return recordedAt', !!row1 && row1.recordedAt === hourAgo, JSON.stringify(row1));
  const legacy = listed.walkins.find((w) => w.walkinId && !/^WI-REC-/.test(w.walkinId));
  assert('legacy rows without a recorded time return an empty string', !!legacy && legacy.recordedAt === '', JSON.stringify(legacy));

  const dup = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-REC-1', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'Cash',
    recordedAt: new Date(Date.now() - 60 * 1000).toISOString()
  });
  assert('a duplicate walkinId keeps the original time', dup.ok && dup.duplicate === true && tab.data[first.row - 1][recCol] === hourAgo, JSON.stringify({ dup, cell: tab.data[first.row - 1][recCol] }));
}

// ---- walk-in idempotency, void, summary exclusion ----
{
  const world = makeWorld({ props: { STAFF_PIN: '2468' } });
  seed(world);
  // Leave formula columns empty; then append should not write into E/F
  const first = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-NEW-1',
    date: '2026-11-29',
    mass: '8:30 AM Mass',
    item: 'Dates & Carrot Pudding (700g)',
    qty: 2,
    payment: 'Cash'
  });
  assert('staff_add_walkin appends a row and prices from the menu',
    first.ok && first.amount === 1140 && first.price === 570 && first.row >= 4,
    JSON.stringify(first));
  const tab = world.sheets['Walk-in Sales'];
  const headers = tab.data[0];
  const added = tab.data[first.row - 1];
  const priceCol = headers.indexOf('Price each');
  const amountCol = headers.indexOf('Amount');
  const idCol = headers.indexOf('Walk-in ID');
  assert('walk-in write skips ARRAYFORMULA price and amount columns',
    (added[priceCol] === '' || added[priceCol] == null) &&
    (added[amountCol] === '' || added[amountCol] == null),
    JSON.stringify({ price: added[priceCol], amount: added[amountCol], headers, added }));
  assert('walkinId is stored', added[idCol] === 'WI-NEW-1');

  const lastRowBefore = tab.data.filter((r) => (r || []).some((c) => c !== '' && c != null)).length;
  const dup = world.ctx.staffAddWalkIn_({
    walkinId: 'WI-NEW-1',
    date: '2026-11-29',
    mass: '8:30 AM Mass',
    item: 'Dates & Carrot Pudding (700g)',
    qty: 9,
    payment: 'UPI'
  });
  const lastRowAfter = tab.data.filter((r) => (r || []).some((c) => c !== '' && c != null)).length;
  assert('duplicate walkinId is idempotent and does not append',
    dup.ok && dup.duplicate === true && lastRowAfter === lastRowBefore,
    JSON.stringify({ dup, lastRowBefore, lastRowAfter }));

  const listed = world.ctx.staffWalkInsFromValues_(tab.data, { date: '2026-11-29', dates: DATES });
  const newRow = listed.walkins.find((w) => w.walkinId === 'WI-NEW-1');
  assert('new walk-in is listed', !!newRow && newRow.qty === 2);

  const voided = world.ctx.staffDeleteWalkIn_({ walkinId: 'WI-NEW-1' });
  assert('staff_delete_walkin soft-deletes with VOID',
    voided.ok && voided.voided === true);
  const voidCol = headers.indexOf('Void');
  assert('Void column is VOID', String(tab.data[first.row - 1][voidCol]) === 'VOID');
  const afterVoid = world.ctx.staffWalkInsFromValues_(tab.data, { date: '2026-11-29', dates: DATES });
  assert('voided walk-in is hidden from the undo list',
    !afterVoid.walkins.some((w) => w.walkinId === 'WI-NEW-1'),
    JSON.stringify(afterVoid.walkins.map((w) => w.walkinId)));

  // ---- visible VOID marker ----
  const st = tab.styles && tab.styles[first.row];
  assert('undo greys the row and strikes it through',
    !!st && st.color === '#9aa0a6' && st.line === 'line-through' && st.background === '#f1f3f4' && st.cols === headers.length,
    JSON.stringify(st));
  const rowsBefore2 = tab.data.filter((r) => (r || []).some((c) => c !== '' && c != null)).length;
  const again = world.ctx.staffDeleteWalkIn_({ walkinId: 'WI-NEW-1' });
  assert('a second undo is harmless (still VOID, same row, no new row)',
    again.ok && again.voided === true && again.row === first.row &&
    String(tab.data[first.row - 1][voidCol]) === 'VOID' &&
    tab.data.filter((r) => (r || []).some((c) => c !== '' && c != null)).length === rowsBefore2);
  assert('rows that were not undone are not restyled',
    !(tab.styles && (tab.styles[2] || tab.styles[3])), JSON.stringify(tab.styles));
  tab.failFontLine = true;
  const second = world.ctx.staffAddWalkIn_({ walkinId: 'WI-NEW-2', date: '2026-11-29', item: 'Rich Plum Cake (400g)', qty: 1, payment: 'UPI' });
  const brokenFmt = world.ctx.staffDeleteWalkIn_({ walkinId: 'WI-NEW-2' });
  tab.failFontLine = false;
  assert('a formatting error never fails the undo',
    second.ok && brokenFmt.ok === true && brokenFmt.voided === true && String(tab.data[second.row - 1][voidCol]) === 'VOID',
    JSON.stringify(brokenFmt));

  const summary = world.ctx.computeOrderSummaryFromValues_(
    world.sheets['Orders'].data,
    DATES,
    MENU,
    new Date('2026-11-23T12:00:00+05:30'),
    tab.data
  );
  const nov = summary.dates.find((d) => d.id === '2026-11-29');
  // Seeded walk-ins: WI-1 1×650 Dates 700g + WI-2 2×350 Plum 400g = 3 cakes / ₹1350
  // WI-NEW-1 (2× Dates) is VOID and must not be included.
  assert('summary excludes voided walk-ins',
    nov && nov.sales.walkIn.cakes === 3 && nov.sales.walkIn.amount === 1350,
    JSON.stringify(nov && nov.sales && nov.sales.walkIn));
}

// ---- visible VOID marker: legacy rows and column visibility ----
{
  const world = makeWorld({ props: { STAFF_PIN: '2468' } });
  const hdr = WALKIN.concat(['Customer', 'Recorded At']);
  const mk = (id, voidCell, notes) => {
    const r = hdr.map(() => '');
    r[0] = '2026-11-29'; r[2] = 'Dates & Carrot Pudding (700g)'; r[3] = 1; r[6] = 'Cash';
    r[hdr.indexOf('Notes')] = notes || '';
    r[hdr.indexOf('Walk-in ID')] = id; r[hdr.indexOf('Void')] = voidCell;
    return r;
  };
  seed(world, { walkins: [hdr.slice(), mk('L-LIVE', '', ''), mk('L-VOID', 'VOID', ''), mk('L-NOTES', '', 'VOID old note')] });
  const tab = world.sheets['Walk-in Sales'];
  const n = world.ctx.restyleVoidedWalkIns_(tab);
  assert('setupSheets restyles walk-ins undone before the marker existed (Void cell or legacy VOID note)',
    n === 2 && tab.styles && tab.styles[3] && tab.styles[4] && tab.styles[3].line === 'line-through' && tab.styles[4].line === 'line-through',
    JSON.stringify({ n, styles: tab.styles }));
  assert('the legacy restyle leaves live rows alone', !(tab.styles && tab.styles[2]), JSON.stringify(tab.styles));
  assert('setupSheets runs the legacy restyle', /restyleVoidedWalkIns_\(walkInTab\)/.test(src));

  const voidCol1 = hdr.indexOf('Void') + 1;
  const idCol1 = hdr.indexOf('Walk-in ID') + 1;
  tab.hiddenCols = [voidCol1]; // an older version hid it
  world.ctx.ensureWalkInExtraColumns_(tab);
  assert('the Void column is shown again and the Walk-in ID column stays hidden',
    tab.hiddenCols.indexOf(voidCol1) < 0 && tab.hiddenCols.indexOf(idCol1) >= 0, JSON.stringify(tab.hiddenCols));
  assert('the Void column gets a visible width', tab.widths && tab.widths[voidCol1] >= 50, JSON.stringify(tab.widths));
}

// ---- doPost routing keeps the customer hot path ----
{
  const world = makeWorld({ props: { STAFF_PIN: '2468' } });
  seed(world);
  const staffRes = world.ctx.doPost({
    postData: { contents: JSON.stringify({ action: 'staff_login', pin: '2468', clientToken: 'deviceTokenF6' }) }
  });
  const staffBody = JSON.parse(staffRes.body);
  assert('doPost staff_login returns ok JSON', staffBody.ok === true && staffBody.version === '2026-11-27.1');

  const beforeRows = world.sheets['Orders'].data.length;
  const order = {
    orderId: 'PB-HOT-1',
    name: 'Hot Path',
    phone: '9000000001',
    pickupDate: '2026-11-29',
    mass: '6:30 AM Mass',
    items: [{ name: 'Rich Plum Cake (400g)', qty: 1, price: 350, lineTotal: 350 }],
    totalItems: 1,
    totalAmount: 350
  };
  const orderRes = world.ctx.doPost({ postData: { contents: JSON.stringify(order) } });
  const orderBody = JSON.parse(orderRes.body);
  assert('doPost without a staff action still saves a customer order',
    orderBody.ok === true && world.sheets['Orders'].data.length === beforeRows + 1,
    JSON.stringify(orderBody));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
