/**
 * Vailankanni Matha Youth — Christmas cake sale order logger
 * (cakes by Poppins Bakers)
 * --------------------------------------------------------------------------
 * Container-bound Google Apps Script for a Google Sheet. The ordering page
 * POSTs each order as text/plain JSON (e.postData.contents) and also GETs
 * live stock via ?action=stock.
 *
 * Setup (do this after pasting / updating this file)
 * --------------------------------------------------
 * 1. Create a Google Sheet (e.g. "Matha Youth Cake Sale").
 *    Extensions → Apps Script, replace any stub with this file, Save.
 *
 * 2. In the editor, select setupSheets and click Run. Authorise when asked.
 *    This creates/repairs the Orders, Weekly Summary, and Stock tabs.
 *    The Stock tab lists pickup dates (column headers). Each cell is the
 *    BATCH quantity sent to Poppins for that date + item. A blank cell
 *    means unlimited for that date; 0 means no new batch. Leftover from a
 *    capped date carries into the next capped date. To add a date: type
 *    it in the next empty column header (e.g. 27 Dec 2026). Or use Cake
 *    Sale → Add pickup date…. Use Cake Sale → Refresh Weekly Summary after
 *    adding a date so the summary tab picks up the new column.
 *
 * 3. Deploy the web app:
 *      Deploy → New deployment → Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *    Copy the Web App URL into SHEETS_WEBAPP_URL in index.html.
 *
 * 4. Drag the poppins-bakers folder (index.html + poster.jpg + logo.png)
 *    onto Netlify Drop.
 *
 * IMPORTANT — after any later edit to this script
 * -----------------------------------------------
 * Saving Code.gs is not enough. The live Web App keeps serving the last
 * deployed version until you publish a new one:
 *   Deploy → Manage deployments → pencil (Edit) → Version: New version → Deploy
 * The Web App URL stays the same, so you do not need to change index.html.
 *
 * Notes
 * -----
 * Stock rules (per item, dates in order):
 *   blank Stock cell  → unlimited on that date (and it leaves no leftover)
 *   numeric cell      → remaining = leftover from earlier capped dates
 *                       + this batch − used on this date (floored at 0)
 *   used = orders that are not Cancelled (Pending, Paid, Picked up and
 *          OVERSOLD all count) + non-VOID Walk-in Sales rows.
 * POST text/plain JSON or GET ?action=order&payload=.
 * Under a short LockService.waitLock (dedupe + stock check + append):
 *   (a) if orderId already exists (CacheService + bounded TextFinder),
 *       return {ok:true,status:'duplicate'} with no write;
 *   (b) if the pickup date is not on the Stock tab header list and this
 *       is not a fallback POST, return {ok:false,status:'invalid_date'};
 *   (c) otherwise append the row, flush once, return saved. The order is
 *       NEVER rejected for stock: if it exceeds what is left it is saved
 *       with Status OVERSOLD (and oversold:true in the reply) so staff can
 *       sort it out. Otherwise Status is Pending.
 * Weekly Summary is live formulas over Orders; it is not rebuilt on
 * each order. Refresh it from the Cake Sale menu after adding dates.
 * doGet(?action=stock) returns {ok, version, dates:[{id,label,closesAt,
 * remaining:{item:number|null}}], remaining:{dateId:{item:number|null}}};
 * null = unlimited. ?callback=name wraps the payload as JSONP.
 */

var ORDERS_SHEET_NAME = 'Orders';
var SUMMARY_SHEET_NAME = 'Weekly Summary';
var STOCK_SHEET_NAME = 'Stock';
var TALLY_SHEET_NAME = 'Tally';
var WALKIN_SHEET_NAME = 'Walk-in Sales';
var ITEM_PRICES_SHEET_NAME = '_ItemPrices';
var ORDER_STATUS_VALUES = ['Pending', 'Paid', 'Picked up', 'Cancelled', 'OVERSOLD'];
var WALKIN_PAYMENT_VALUES = ['Cash', 'UPI'];
var WALKIN_HEADERS = ['Date', 'Item', 'Qty', 'Price each', 'Amount', 'Payment', 'Notes', 'Walk-in ID', 'Void'];

/** Official menu prices, used by the Walk-in Sales price-each formula. */
var MENU_ITEM_PRICES = {
  'Dates & Carrot Pudding (700g)': 650,
  'Dates & Carrot Pudding (350g)': 330,
  'Butterscotch Pudding (700g)': 700,
  'Butterscotch Pudding (350g)': 350,
  'Rich Plum Cake (800g)': 650,
  'Rich Plum Cake (400g)': 350
};


/** Cached doGet stock JSON. Short TTL so a missed invalidation heals quickly. */
var STOCK_CACHE_KEY = 'stock-json-v1';
var STOCK_CACHE_GEN_KEY = 'stock-gen-v1';
var STOCK_CACHE_TTL = 25; // seconds

/** Orders header signature — skip full schema work when this still matches. */
var SCHEMA_CACHE_KEY = 'schema-ok-v1';
var SCHEMA_CACHE_TTL = 21600; // 6 hours
var LAST_TIMING_CACHE_KEY = 'last-order-timing-v1';

/**
 * Seeded only when setupSheets creates a brand-new, empty Stock tab.
 * After that, pickup dates come exclusively from Stock column headers.
 */
var DEFAULT_OPENING_DATE_ID = '2026-11-29';


/**
 * Seed item names for Orders qty columns, Stock rows, and the Weekly
 * Summary. Must match the frontend display names ("Name (weight)").
 * New names that arrive on an order are appended automatically.
 */
var MENU_ITEM_COLUMNS = [
  'Dates & Carrot Pudding (700g)',
  'Dates & Carrot Pudding (350g)',
  'Butterscotch Pudding (700g)',
  'Butterscotch Pudding (350g)',
  'Rich Plum Cake (800g)',
  'Rich Plum Cake (400g)'
];

/**
 * Opening stock for 29 Nov 2026, seeded only into empty cells of a
 * matching Stock column (matched by ISO date, never overwriting edits).
 * Add later dates on the Stock tab; blank cells mean no limit until
 * you type a cap (0 = sold out).
 */
var INITIAL_STOCK = {
  '2026-11-29': {
    'Dates & Carrot Pudding (700g)': 15,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  }
};

var BASE_HEADERS = [
  'Timestamp',
  'Order ID',
  'Pickup Date',
  'Name',
  'Phone',
  'Items',
  'Total Items',
  'Total Amount (₹)',
  'Status',
  'Raw JSON'
];

/** Older columns we no longer write. Left in place on existing sheets so
 *  historical rows stay intact, and never treated as menu-item qty columns. */
var LEGACY_HEADERS = [
  'Delivery Option',
  'Flat/Block',
  'Status Updated',
  'Assigned To' // orders are no longer assigned to a contact; old column is ignored
];

/**
 * Run once from the Apps Script editor (select setupSheets → Run).
 * Safe to run again: it repairs missing tabs/columns/rows and rewrites
 * Weekly Summary formulas from the current Stock dates, but
 * does not wipe Stock quantities or Orders.
 */
function setupSheets() {
  var ss = getSpreadsheet_();
  var orders = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
  ensureOrdersSchema_(orders, MENU_ITEM_COLUMNS);
  ensureOrdersStatusValidation_(orders);
  var walkInTab = ensureWalkInSalesSheet_(ss);
  restyleVoidedWalkIns_(walkInTab); // mark rows undone before the visible marker existed
  ensureStockSheet_(ss, MENU_ITEM_COLUMNS);
  rebuildTallySheet_(ss);
  refreshWeeklySummary_(ss, orders);
  invalidateStockCache_();
  invalidatePickupDatesCache_();
  invalidateSummaryCache_();
  ensureStatusUpdatedColumn_(orders);
  remindStaffPinIfMissing_();
}

/**
 * Health check, pickup dates (?action=stock), aggregate order totals
 * (?action=summary, no personal data), or a readable order reserve
 * (?action=order&payload=...). Optional ?callback= wraps JSONP.
 */
/** Bump when the script changes, so a deployed version can be identified. */
var SCRIPT_VERSION = '2026-11-24.7';

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  if (params.action === 'order') {
    try {
      if (!params.payload && !params.data) {
        return jsonpOrJson_({ ok: false, error: 'Empty payload' }, params.callback);
      }
      var data = JSON.parse(params.payload || params.data);
      var result = processOrder_(data, { fallback: params.fallback === '1' || params.fallback === 'true' });
      return jsonpOrJson_(result, params.callback);
    } catch (err) {
      try { logOrderError_(err, data, null); } catch (e2) {}
      return jsonpOrJson_({
        ok: false,
        error: String(err && err.message ? err.message : err)
      }, params.callback);
    }
  }
  var payload;
  if (params.action === 'debug') {
    // Light diagnostics: timings + date list. No remaining compute, no tally rebuild.
    try {
      var dss = getSpreadsheet_();
      var dstock = dss.getSheetByName(STOCK_SHEET_NAME);
      var dorders = dss.getSheetByName(ORDERS_SHEET_NAME);
      var ddates = dstock ? getStockDatesFromSheet_(dstock) : [];
      payload = {
        ok: true,
        version: SCRIPT_VERSION,
        spreadsheetTz: dss.getSpreadsheetTimeZone(),
        parsedDates: ddates,
        ordersLastRow: dorders ? dorders.getLastRow() : 0,
        lastOrderTiming: readLastTiming_(),
        lastOrderError: readLastOrderError_(),
        ordersSample: ordersRowTypesSample_(dorders)
      };
    } catch (err) {
      payload = { ok: false, version: SCRIPT_VERSION, error: String(err && err.stack ? err.stack : err) };
    }
  } else if (params.action === 'stock' || params.action === 'dates') {
    try {
      var sss = getSpreadsheet_();
      payload = {
        ok: true,
        version: SCRIPT_VERSION,
        dates: publicStockDates_(getPickupDatesCached_(sss))
      };
      try {
        // Remaining stock per date + item (null = unlimited). If it cannot
        // be computed the date list is still served and no limits apply.
        var stockNow = getStockRemaining_({ spreadsheet: sss });
        payload.dates = stockNow.dates;
        payload.remaining = stockNow.remaining;
      } catch (stockErr) {}
    } catch (err) {
      payload = { ok: false, error: String(err && err.message ? err.message : err), dates: [] };
    }
  } else if (params.action === 'summary') {
    try {
      payload = getOrderSummaryPayload_(getSpreadsheet_());
    } catch (err) {
      payload = { ok: false, version: SCRIPT_VERSION, error: String(err && err.message ? err.message : err) };
    }
  } else {
    payload = {
      ok: true,
      service: 'Vailankanni Matha Youth Cake Sale',
      sheet: ORDERS_SHEET_NAME
    };
  }
  return jsonpOrJson_(payload, params.callback);
}

/**
 * Readable or fallback order intake. Body is text/plain JSON
 * (e.postData.contents). Over-stock orders are saved as OVERSOLD, never
 * rejected. A fallback POST with an unknown date is still written.
 */
function doPost(e) {
  var data = null;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'Empty request body' });
    }
    data = JSON.parse(e.postData.contents);
    if (data && isStaffAction_(data.action)) {
      return jsonResponse(handleStaffAction_(data));
    }
    var result = processOrder_(data, { fallback: !!data.fallback });
    return jsonResponse(result);
  } catch (err) {
    logOrderError_(err, data, null);
    return jsonResponse({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
}

var ORDER_ID_CACHE_PREFIX = 'oid:';
var ORDER_ID_CACHE_TTL = 21600; // 6 hours, CacheService maximum

/**
 * Short lock around dedupe + stock check + append:
 *   (a) duplicate orderId → {ok:true,status:'duplicate'}, no write
 *   (b) unknown pickup date (non-fallback) → {ok:false,status:'invalid_date'}
 *   (c) else append (Status Pending, or OVERSOLD when it exceeds the stock
 *       left for that date), one flush, {ok:true,status:'saved'[,oversold:true]}
 *       An order is never rejected for stock.
 */
function processOrder_(data, options) {
  options = options || {};
  var tAll = Date.now();
  var timings = {};
  var t;
  var wrote = false;

  var ss = getSpreadsheet_();
  var itemNames = collectItemNames_(data);
  t = Date.now();
  var dates = getPickupDatesCached_(ss);
  timings.datesMs = Date.now() - t;

  var orderId = String((data && data.orderId) || '').trim();
  var date = findStockDate_(data && (data.pickupDate || data.pickupDateLabel), dates);
  if (!date && !options.fallback) {
    timings.totalMs = Date.now() - tAll;
    rememberLastTiming_(timings);
    return {
      ok: false,
      status: 'invalid_date',
      orderId: orderId,
      dates: publicStockDates_(dates)
    };
  }

  var lock = LockService.getScriptLock();
  try {
    t = Date.now();
    lock.waitLock(10000);
    timings.lockMs = Date.now() - t;

    var sheet = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);

    t = Date.now();
    var ordersHeaders = readOrdersHeadersFast_(sheet, itemNames);
    var ordersLastRow = sheet.getLastRow();
    timings.schemaMs = Date.now() - t;

    t = Date.now();
    if (orderId && orderIdExists_(sheet, orderId, ordersHeaders, ordersLastRow)) {
      timings.idempotencyMs = Date.now() - t;
      timings.totalMs = Date.now() - tAll;
      rememberLastTiming_(timings);
      return { ok: true, status: 'duplicate', orderId: orderId };
    }
    timings.idempotencyMs = Date.now() - t;

    var rowStatus = 'Pending';
    var oversold = false;
    if (date) {
      t = Date.now();
      try {
        var left = remainingMapForDateId_(ss, date.id, itemNames);
        if (orderExceedsRemaining_(data && data.items, left)) {
          rowStatus = 'OVERSOLD';
          oversold = true;
        }
      } catch (stockErr) {
        // Never lose an order because the stock check failed.
      }
      timings.stockMs = Date.now() - t;
    }
    t = Date.now();
    var newRow = appendOrderRow_(sheet, data, rowStatus, ordersHeaders, ordersLastRow + 1);
    wrote = true;
    if (orderId) rememberOrderId_(orderId);
    invalidateSummaryCache_();
    invalidateStockCache_();
    timings.writeMs = Date.now() - t;

    if (lock.hasLock()) {
      t = Date.now();
      SpreadsheetApp.flush();
      timings.flushMs = Date.now() - t;
    }

    timings.totalMs = Date.now() - tAll;
    rememberLastTiming_(timings);
    var saved = {
      ok: true,
      status: 'saved',
      orderId: orderId,
      row: newRow
    };
    if (oversold) saved.oversold = true;
    return saved;
  } finally {
    try {
      if (wrote && lock.hasLock() && typeof timings.flushMs !== 'number') {
        t = Date.now();
        SpreadsheetApp.flush();
        timings.flushMs = Date.now() - t;
        timings.totalMs = Date.now() - tAll;
        rememberLastTiming_(timings);
      }
    } catch (flushErr) {}
    try {
      lock.releaseLock();
    } catch (releaseErr) {
      // Lock may not have been acquired if waitLock timed out.
    }
  }
}

function cacheKeyForOrderId_(orderId) {
  return ORDER_ID_CACHE_PREFIX + String(orderId);
}

function rememberOrderId_(orderId) {
  try {
    CacheService.getScriptCache().put(cacheKeyForOrderId_(orderId), '1', ORDER_ID_CACHE_TTL);
  } catch (err) {
    // Cache is a hint; the Orders column remains the source of truth.
  }
}

function orderIdExists_(sheet, orderId, headers, lastRow) {
  if (!orderId) return false;
  try {
    if (CacheService.getScriptCache().get(cacheKeyForOrderId_(orderId))) return true;
  } catch (err) {}

  headers = headers || getHeaders_(sheet);
  var col = headers.indexOf('Order ID');
  var last = (typeof lastRow === 'number') ? lastRow : sheet.getLastRow();
  if (col < 0 || last < 2) return false;
  // Bounded to the used Order ID column (not A:A / full-column scans).
  var range = sheet.getRange(2, col + 1, last - 1, 1);
  var found = range.createTextFinder(String(orderId))
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  if (found) {
    rememberOrderId_(orderId);
    return true;
  }
  return false;
}

function orderExceedsRemaining_(items, remainingForDate) {
  items = items || [];
  remainingForDate = remainingForDate || {};
  for (var i = 0; i < items.length; i++) {
    var line = items[i];
    if (!line || !line.name) continue;
    var qty = Number(line.qty || 0);
    if (!qty) continue;
    if (!Object.prototype.hasOwnProperty.call(remainingForDate, line.name)) {
      continue; // no Stock row for this item = no limit (same as a blank cell)
    }
    var rem = remainingForDate[line.name];
    if (rem === null) continue; // blank stock cell = no limit
    if (rem === '' || typeof rem === 'undefined') rem = 0;
    if (qty > Number(rem)) return true;
  }
  return false;
}

/* ---------- Spreadsheet helpers ---------- */

var activeSpreadsheet_;
var SPREADSHEET_ID_PROP_ = 'spreadsheet-id';

function getSpreadsheet_() {
  if (activeSpreadsheet_) return activeSpreadsheet_;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    try {
      var id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROP_);
      if (id) ss = SpreadsheetApp.openById(id);
    } catch (err) {}
  }
  if (!ss) {
    throw new Error('No active spreadsheet. Bind this script to a Google Sheet (Extensions → Apps Script).');
  }
  activeSpreadsheet_ = ss;
  try {
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty(SPREADSHEET_ID_PROP_)) {
      props.setProperty(SPREADSHEET_ID_PROP_, ss.getId());
    }
  } catch (err2) {}
  return ss;
}

function getOrCreateSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function getHeaders_(sheet) {
  if (!sheet) return [];
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) {
    return String(v || '').trim();
  });
}

/** Bounded used-range read. Avoid getDataRange(), which can scan trailing formatted cells. */
function getSheetValues_(sheet) {
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  return sheet.getRange(1, 1, lastRow, lastCol).getValues();
}

/* ---- order path (testable) ---- */

function schemaSignature_(headers, itemNames) {
  return (headers || []).join('\u0001') + '\u0002' + (itemNames || []).join('\u0001');
}

function ordersSchemaLooksOk_(headers, itemNames) {
  if (!headers || !headers.length || headers[0] !== 'Timestamp') return false;
  var set = {};
  var i;
  for (i = 0; i < headers.length; i++) set[String(headers[i] || '')] = true;
  for (i = 0; i < BASE_HEADERS.length; i++) {
    if (!set[BASE_HEADERS[i]]) return false;
  }
  var names = itemNames || [];
  for (i = 0; i < names.length; i++) {
    if (names[i] && !set[names[i]]) return false;
  }
  return true;
}

/**
 * Plan a Tally increment as two small writes: meta B1:C1 and the one
 * date column. Returns {ok:false} when the sheet must be fully rebuilt
 * (missing date column, missing item row, or stale date key).
 */
function planTallyPatch_(values, dates, dateId, items, lastRow, lastOrderId) {
  if (!values || values.length < 2) return { ok: false, reason: 'empty' };
  if (String(values[0][0] || '') !== '#tally') return { ok: false, reason: 'meta' };
  if (dates && String(values[0][3] || '') !== tallyDatesKey_(dates)) {
    return { ok: false, reason: 'dates' };
  }
  var header = values[1] || [];
  var dateCol = -1;
  var c, parsed, id;
  for (c = 1; c < header.length; c++) {
    id = String(header[c] || '').trim();
    parsed = parseStockDateHeader_(header[c], c + 1);
    if ((parsed && parsed.id === dateId) || id === dateId) {
      dateCol = c;
      break;
    }
  }
  if (dateCol < 0) return { ok: false, reason: 'date-col' };
  var itemRow = {};
  var r, name;
  for (r = 2; r < values.length; r++) {
    name = String(values[r][0] || '').trim();
    if (name) itemRow[name] = r;
  }
  items = items || [];
  var i, line, qty;
  for (i = 0; i < items.length; i++) {
    line = items[i];
    if (!line || !line.name) continue;
    qty = Number(line.qty || 0);
    if (!qty) continue;
    if (typeof itemRow[line.name] === 'undefined') return { ok: false, reason: 'missing-item' };
  }
  var column = [];
  for (r = 2; r < values.length; r++) {
    column.push([Number(values[r][dateCol] || 0)]);
  }
  for (i = 0; i < items.length; i++) {
    line = items[i];
    if (!line || !line.name) continue;
    qty = Number(line.qty || 0);
    if (!qty) continue;
    column[itemRow[line.name] - 2][0] += qty;
  }
  return {
    ok: true,
    dateCol: dateCol,
    startRow: 3,
    column: column,
    meta: [lastRow || 0, lastOrderId || '']
  };
}

/* ---- end order path ---- */

function schemaCacheMatches_(sig) {
  try {
    var cache = getScriptCacheSafe_();
    return !!(cache && sig && cache.get(SCHEMA_CACHE_KEY) === sig);
  } catch (err) {
    return false;
  }
}

function rememberSchemaOk_(sig) {
  try {
    var cache = getScriptCacheSafe_();
    if (cache && sig) cache.put(SCHEMA_CACHE_KEY, sig, SCHEMA_CACHE_TTL);
  } catch (err) {}
}

function invalidateSchemaCache_() {
  try {
    var cache = getScriptCacheSafe_();
    if (cache) cache.remove(SCHEMA_CACHE_KEY);
  } catch (err) {}
}

function readOrdersHeadersFast_(sheet, itemNames) {
  var headers = getHeaders_(sheet);
  var sig = schemaSignature_(headers, itemNames);
  if (schemaCacheMatches_(sig) || ordersSchemaLooksOk_(headers, itemNames)) {
    rememberSchemaOk_(sig);
    return headers;
  }
  ensureOrdersSchema_(sheet, itemNames);
  headers = getHeaders_(sheet);
  rememberSchemaOk_(schemaSignature_(headers, itemNames));
  return headers;
}

function rememberLastTiming_(timings) {
  try {
    var cache = getScriptCacheSafe_();
    if (cache) cache.put(LAST_TIMING_CACHE_KEY, JSON.stringify(timings || {}), 21600);
  } catch (err) {}
  try {
    Logger.log('processOrder_ timings ' + JSON.stringify(timings || {}));
  } catch (err2) {}
}

function readLastTiming_() {
  try {
    var cache = getScriptCacheSafe_();
    var raw = cache && cache.get(LAST_TIMING_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

var LAST_ERROR_CACHE_KEY = 'last-order-error-v1';
var ERRORS_SHEET_NAME = 'Errors';

function logOrderError_(err, data, timings) {
  var message = String(err && err.message ? err.message : err);
  var stack = String(err && err.stack ? err.stack : '');
  var orderId = data && data.orderId ? String(data.orderId) : '';
  var entry = {
    at: new Date().toISOString(),
    orderId: orderId,
    error: message,
    stack: stack,
    timings: timings || null
  };
  try { Logger.log('processOrder_ error ' + JSON.stringify(entry)); } catch (e0) {}
  try {
    var cache = getScriptCacheSafe_();
    if (cache) cache.put(LAST_ERROR_CACHE_KEY, JSON.stringify(entry), 21600);
  } catch (e1) {}
  try {
    var ss = getSpreadsheet_();
    var tab = getOrCreateSheet_(ss, ERRORS_SHEET_NAME);
    try { tab.hideSheet(); } catch (hideErr) {}
    if (tab.getLastRow() === 0 || tab.getLastColumn() === 0) {
      tab.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Order ID', 'Error', 'Stack', 'Payload', 'Timings']]);
    }
    var payload = '';
    try { payload = data ? JSON.stringify(data).substring(0, 50000) : ''; } catch (pErr) { payload = ''; }
    tab.getRange(tab.getLastRow() + 1, 1, 1, 6).setValues([[
      new Date(),
      orderId,
      message,
      stack,
      payload,
      timings ? JSON.stringify(timings) : ''
    ]]);
  } catch (e2) {}
}

function readLastOrderError_() {
  try {
    var cache = getScriptCacheSafe_();
    var raw = cache && cache.get(LAST_ERROR_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Create or migrate the Orders header row by name so an existing sheet
 * with the older column set keeps its data. Missing "Pickup Date" is
 * inserted immediately after "Order ID". An existing legacy "Mass" column
 * is left alone and ignored (remove it with Cake Sale → Remove Mass
 * columns…). Missing "Status" is inserted
 * immediately before "Raw JSON" (or appended). Retired columns such as
 * "Delivery Option" and "Flat/Block" are left in place. New menu-item
 * quantity columns are appended at the right.
 */
function ensureOrdersSchema_(sheet, itemNames) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    var initial = BASE_HEADERS.concat(itemNames || []);
    sheet.getRange(1, 1, 1, initial.length).setValues([initial]);
    styleOrdersHeader_(sheet);
    ensureOrdersTextColumns_(sheet, initial);
    ensureOrdersStatusValidation_(sheet);
    return;
  }

  var headers = getHeaders_(sheet);
  var mutated = false;

  if (headers[0] !== 'Timestamp') {
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, BASE_HEADERS.length).setValues([BASE_HEADERS]);
    headers = getHeaders_(sheet);
    mutated = true;
  }

  if (headers.indexOf('Pickup Date') === -1) {
    var orderIdIdx = headers.indexOf('Order ID');
    var afterCol = (orderIdIdx >= 0 ? orderIdIdx + 1 : 2); // 1-based
    sheet.insertColumnAfter(afterCol);
    sheet.getRange(1, afterCol + 1).setValue('Pickup Date');
    headers = getHeaders_(sheet);
    mutated = true;
  }

  if (headers.indexOf('Status') === -1) {
    var rawIdx = headers.indexOf('Raw JSON');
    if (rawIdx >= 0) {
      sheet.insertColumnBefore(rawIdx + 1);
      sheet.getRange(1, rawIdx + 1).setValue('Status');
    } else {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue('Status');
    }
    headers = getHeaders_(sheet);
    mutated = true;
  }

  var i, h;
  var present = {};
  for (i = 0; i < headers.length; i++) present[headers[i]] = true;
  var missing = [];
  for (i = 0; i < BASE_HEADERS.length; i++) {
    h = BASE_HEADERS[i];
    if (!present[h]) {
      missing.push(h);
      present[h] = true;
    }
  }
  var names = itemNames || [];
  for (i = 0; i < names.length; i++) {
    h = names[i];
    if (h && !present[h]) {
      missing.push(h);
      present[h] = true;
    }
  }
  if (missing.length) {
    var start = sheet.getLastColumn() + 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    mutated = true;
  }

  if (mutated) styleOrdersHeader_(sheet);
  ensureOrdersTextColumns_(sheet, getHeaders_(sheet));
  ensureOrdersStatusValidation_(sheet);
}

function styleOrdersHeader_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), BASE_HEADERS.length);
  var range = sheet.getRange(1, 1, 1, lastCol);
  range.setFontWeight('bold');
  range.setBackground('#b91c1c');
  range.setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 160);
}

function textColumnIndexes_(headers) {
  var names = ['Pickup Date', 'Phone'];
  var out = [];
  var i, idx;
  for (i = 0; i < names.length; i++) {
    idx = headers.indexOf(names[i]);
    if (idx >= 0) out.push(idx);
  }
  return out;
}

/**
 * Keep Pickup Date and Phone as plain text so Sheets does not
 * auto-convert ISO dates / leading digits.
 */
function ensureOrdersTextColumns_(sheet, headers) {
  headers = headers || getHeaders_(sheet);
  var idxs = textColumnIndexes_(headers);
  var lastRow = Math.max(sheet.getMaxRows ? sheet.getMaxRows() : 2, 2);
  var i, start;
  for (i = 0; i < idxs.length; i++) {
    start = Math.min(2, lastRow);
    sheet.getRange(start, idxs[i] + 1, lastRow - start + 1, 1).setNumberFormat('@');
  }
}

function formatOrdersTextCells_(sheet, headers, rowNumber) {
  var idxs = textColumnIndexes_(headers);
  var i;
  for (i = 0; i < idxs.length; i++) {
    sheet.getRange(rowNumber, idxs[i] + 1).setNumberFormat('@');
  }
}

function appendOrderRow_(sheet, data, status, headers, nextRow) {
  headers = headers || getHeaders_(sheet);
  var row = [];
  var i;
  for (i = 0; i < headers.length; i++) row.push('');

  function set(name, value) {
    var idx = headers.indexOf(name);
    if (idx >= 0) row[idx] = value;
  }

  set('Timestamp', data.timestamp || new Date());
  set('Order ID', data.orderId || '');
  set('Pickup Date', data.pickupDate || data.pickupDateLabel || '');
  set('Name', data.name || '');
  set('Phone', data.phone || '');
  set('Items', formatItems_(data.items));
  set('Total Items', data.totalItems || 0);
  set('Total Amount (₹)', data.totalAmount || 0);
  set('Status', status || 'Pending');
  set('Raw JSON', JSON.stringify(data));

  var items = data.items || [];
  for (i = 0; i < items.length; i++) {
    var line = items[i];
    if (line && line.name) set(line.name, line.qty || 0);
  }

  var at = (typeof nextRow === 'number' && nextRow > 0) ? nextRow : (sheet.getLastRow() + 1);
  // Format as text BEFORE setValues, otherwise Sheets coerces ISO dates and times.
  formatOrdersTextCells_(sheet, headers, at);
  sheet.getRange(at, 1, 1, row.length).setValues([row]);
  return at;
}

function collectItemNames_(data) {
  var seen = {};
  var out = MENU_ITEM_COLUMNS.slice();
  MENU_ITEM_COLUMNS.forEach(function (n) { seen[n] = true; });
  var items = (data && data.items) || [];
  for (var i = 0; i < items.length; i++) {
    var name = items[i] && items[i].name;
    if (name && !seen[name]) {
      seen[name] = true;
      out.push(name);
    }
  }
  return out;
}

function getItemColumnNames_(ordersSheet) {
  var headers = getHeaders_(ordersSheet);
  var base = {};
  BASE_HEADERS.concat(LEGACY_HEADERS).forEach(function (h) { base[h] = true; });
  var names = [];
  var i;
  for (i = 0; i < headers.length; i++) {
    if (headers[i] && !base[headers[i]]) names.push(headers[i]);
  }
  // Keep a stable, known-first order, then any extras.
  var ordered = [];
  var seen = {};
  MENU_ITEM_COLUMNS.forEach(function (n) {
    if (headers.indexOf(n) >= 0) {
      ordered.push(n);
      seen[n] = true;
    }
  });
  for (i = 0; i < names.length; i++) {
    if (!seen[names[i]]) ordered.push(names[i]);
  }
  return ordered;
}

/* ---------- Stock ---------- */

/* ---- date helpers (testable) ---- */

var MONTH_NAME_INDEX_ = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

function pad2_(n) {
  n = Number(n);
  return n < 10 ? '0' + n : String(n);
}

function isItemOrTotalHeader_(value) {
  var s = String(value || '').trim().toUpperCase();
  return s === 'ITEM' || s === 'TOTAL';
}

function istClockFromDate_(date) {
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    var parts = Utilities.formatDate(date, 'Asia/Kolkata', 'yyyy-MM-dd-HH-mm-ss').split('-');
    return {
      y: +parts[0], m: +parts[1], d: +parts[2],
      h: +parts[3], min: +parts[4], sec: +parts[5]
    };
  }
  var fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23'
  });
  var map = {};
  fmt.formatToParts(date).forEach(function (p) { map[p.type] = p.value; });
  var h = Number(map.hour);
  if (h === 24) h = 0;
  return { y: +map.year, m: +map.month, d: +map.day, h: h, min: +map.minute, sec: +map.second };
}

function isDateObject_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function formatYmdIst_(date) {
  var clock = istClockFromDate_(date);
  return clock.y + '-' + pad2_(clock.m) + '-' + pad2_(clock.d);
}

function formatHmIst_(date) {
  var clock = istClockFromDate_(date);
  return pad2_(clock.h) + ':' + pad2_(clock.min);
}

function cellTypeName_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return 'blank';
  if (isDateObject_(value)) return 'Date';
  return typeof value;
}

/** Types only — no cell values, so no buyer data is exposed. */
function ordersRowTypesSample_(sheet) {
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return null;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(lastRow, 1, 1, lastCol).getValues()[0];
  var types = {};
  var i, name;
  for (i = 0; i < headers.length; i++) {
    name = String(headers[i] || '').trim();
    if (!name) continue;
    types[name] = cellTypeName_(values[i]);
  }
  return { row: lastRow, types: types };
}

/**
 * Coerce a Pickup Date cell (Sheets Date, ISO id, or a display string
 * such as "Sun, 29 Nov") to yyyy-MM-dd in Asia/Kolkata, or ''.
 */
function normalizePickupDateId_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return '';
  if (isDateObject_(value)) return formatYmdIst_(value);
  var parsed = parseStockDateHeader_(value);
  return parsed ? parsed.id : '';
}

function formatShortPickupLabel_(y, m, d) {
  var date = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    return Utilities.formatDate(date, 'Asia/Kolkata', 'EEE, d MMM');
  }
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  }).formatToParts(date);
  function part(t) {
    for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value;
    return '';
  }
  return part('weekday') + ', ' + part('day') + ' ' + part('month');
}

function closesAtIso_(y, m, d, h, min) {
  return y + '-' + pad2_(m) + '-' + pad2_(d) + 'T' + pad2_(h) + ':' + pad2_(min) + ':00+05:30';
}

function currentIstYear_() {
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    return Number(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy'));
  }
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric'
  }).formatToParts(new Date());
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === 'year') return Number(parts[i].value);
  }
  return new Date().getFullYear();
}

function parseTimeFromHeaderText_(s) {
  var m = s.match(/(?:^|\s)(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (m) {
    var h = Number(m[1]);
    var min = Number(m[2]);
    var ap = m[3].toLowerCase();
    if (ap === 'am') { if (h === 12) h = 0; }
    else if (h !== 12) h += 12;
    return {
      h: h,
      min: min,
      rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    };
  }
  m = s.match(/(?:^|\s)(\d{1,2})\s*(am|pm)\b/i);
  if (m) {
    var h2 = Number(m[1]);
    var ap2 = m[2].toLowerCase();
    if (ap2 === 'am') { if (h2 === 12) h2 = 0; }
    else if (h2 !== 12) h2 += 12;
    return {
      h: h2,
      min: 0,
      rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    };
  }
  m = s.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (m) {
    var h3 = Number(m[1]);
    var min3 = Number(m[2]);
    if (h3 >= 0 && h3 <= 23 && min3 >= 0 && min3 <= 59) {
      return {
        h: h3,
        min: min3,
        rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
      };
    }
  }
  return null;
}

function parseYmdFromText_(s) {
  s = String(s || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  var ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymd) return { y: +ymd[1], m: +ymd[2], d: +ymd[3] };
  var dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return { y: +dmy[3], m: +dmy[2], d: +dmy[1] };
  var first = s.split(' ')[0];
  if (/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/i.test(first)) {
    s = s.replace(/^\S+\s+/, '');
  }
  var dMonY = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dMonY && MONTH_NAME_INDEX_[dMonY[2].toLowerCase()]) {
    return { y: +dMonY[3], m: MONTH_NAME_INDEX_[dMonY[2].toLowerCase()], d: +dMonY[1] };
  }
  var monDY = s.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (monDY && MONTH_NAME_INDEX_[monDY[1].toLowerCase()]) {
    return { y: +monDY[3], m: MONTH_NAME_INDEX_[monDY[1].toLowerCase()], d: +monDY[2] };
  }
  var dMon = s.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (dMon && MONTH_NAME_INDEX_[dMon[2].toLowerCase()]) {
    return { y: currentIstYear_(), m: MONTH_NAME_INDEX_[dMon[2].toLowerCase()], d: +dMon[1] };
  }
  var monD = s.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (monD && MONTH_NAME_INDEX_[monD[1].toLowerCase()]) {
    return { y: currentIstYear_(), m: MONTH_NAME_INDEX_[monD[1].toLowerCase()], d: +monD[2] };
  }
  return null;
}

function isValidYmd_(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse a Stock column header: a Sheets Date cell, or text such as
 * "27 Dec 2026", "Sun 29 Nov 2026", "2026-12-27", optionally with a
 * cutoff time ("27 Dec 2026 10:00 AM"). Default cutoff is 8:30 AM IST.
 * Returns { id, label, closesAt, col } or null.
 */
function parseStockDateHeader_(raw, col) {
  if (raw === '' || raw === null || typeof raw === 'undefined') return null;
  if (isItemOrTotalHeader_(raw)) return null;

  var y, m, d, h = 8, min = 30;

  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw.getTime())) {
    var clock = istClockFromDate_(raw);
    y = clock.y; m = clock.m; d = clock.d;
    if (!(clock.h === 0 && clock.min === 0 && clock.sec === 0)) {
      h = clock.h;
      min = clock.min;
    }
  } else {
    var text = String(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var time = parseTimeFromHeaderText_(text);
    var dateText = text;
    if (time) {
      h = time.h;
      min = time.min;
      dateText = time.rest;
    }
    var ymd = parseYmdFromText_(dateText);
    if (!ymd) return null;
    y = ymd.y; m = ymd.m; d = ymd.d;
  }

  if (!isValidYmd_(y, m, d)) return null;
  return {
    id: y + '-' + pad2_(m) + '-' + pad2_(d),
    label: formatShortPickupLabel_(y, m, d),
    closesAt: closesAtIso_(y, m, d, h, min),
    col: col || 0
  };
}

function findStockDate_(value, dates) {
  dates = dates || [];
  if (value === '' || value === null || typeof value === 'undefined') return null;
  var i;
  if (!isDateObject_(value)) {
    var s = String(value).trim();
    if (s) {
      for (i = 0; i < dates.length; i++) {
        if (dates[i].id === s || dates[i].label === s) return dates[i];
      }
    }
  }
  var id = normalizePickupDateId_(value);
  if (!id) return null;
  for (i = 0; i < dates.length; i++) {
    if (dates[i].id === id) return dates[i];
  }
  return null;
}

function publicStockDates_(dates) {
  return (dates || []).map(function (d) {
    return { id: d.id, label: d.label, closesAt: d.closesAt };
  });
}

/* ---- end date helpers ---- */

function getHeaderRaw_(sheet) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

/**
 * Date columns on the Stock tab (after the item-name column), first
 * occurrence of each ISO id, then sorted by date for the website and
 * Weekly Summary.
 */
function getStockDatesFromSheet_(sheet) {
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  return getStockDatesFromHeaderRow_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
}

var PICKUP_DATES_CACHE_KEY = 'pickup-dates-v1';
var PICKUP_DATES_CACHE_TTL = 21600;

/** Cached Stock header dates. Cache miss reads the header row only. */
function getPickupDatesCached_(ss) {
  try {
    var cache = getScriptCacheSafe_();
    var raw = cache && cache.get(PICKUP_DATES_CACHE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.length) return parsed;
    }
  } catch (err) {}
  var dates = [];
  var stock = ss && ss.getSheetByName(STOCK_SHEET_NAME);
  if (stock) dates = getStockDatesFromSheet_(stock);
  rememberPickupDates_(dates);
  return dates;
}

function rememberPickupDates_(dates) {
  try {
    var cache = getScriptCacheSafe_();
    if (cache) {
      cache.put(PICKUP_DATES_CACHE_KEY, JSON.stringify(publicStockDates_(dates) || []), PICKUP_DATES_CACHE_TTL);
    }
  } catch (err) {}
}

function invalidatePickupDatesCache_() {
  try {
    var cache = getScriptCacheSafe_();
    if (cache) cache.remove(PICKUP_DATES_CACHE_KEY);
  } catch (err) {}
}

function ensureStockSheet_(ss, itemNames, options) {
  options = options || {};
  var sheet = ss.getSheetByName(STOCK_SHEET_NAME);
  if (options.light && sheet && sheet.getLastRow() >= 2 && sheet.getLastColumn() >= 2) {
    return sheet;
  }
  if (!sheet) sheet = getOrCreateSheet_(ss, STOCK_SHEET_NAME);
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1).setValue('Item');
    var opening = new Date(2026, 10, 29);
    sheet.getRange(1, 2).setValue(opening);
    sheet.getRange(1, 2).setNumberFormat('d mmm yyyy');
    styleStockHeader_(sheet);
  }

  var headersNow = getHeaders_(sheet);
  if (!headersNow.length || String(headersNow[0] || '').trim() !== 'Item') {
    sheet.getRange(1, 1).setValue('Item');
  }

  var names = uniqueNames_(MENU_ITEM_COLUMNS.concat(itemNames || []));
  var existing = {};
  if (sheet.getLastRow() >= 2) {
    var nameCol = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var r = 0; r < nameCol.length; r++) {
      existing[String(nameCol[r][0] || '').trim()] = true;
    }
  }
  var totalRow = findStockTotalRow_(sheet);
  for (var i = 0; i < names.length; i++) {
    if (names[i] && !existing[names[i]]) {
      if (totalRow) {
        sheet.insertRowBefore(totalRow);
        sheet.getRange(totalRow, 1).setValue(names[i]);
        totalRow += 1;
      } else {
        sheet.getRange(sheet.getLastRow() + 1, 1).setValue(names[i]);
      }
      existing[names[i]] = true;
    }
  }

  seedInitialStock_(sheet);
  refreshStockTotals_(sheet);
  styleStockHeader_(sheet);
  sheet.getRange(1, 1).setNote(
    'To add a date: type it in the next empty column header (e.g. 27 Dec 2026), then enter the batch quantity sent to Poppins for that date. Leftover carries into the next date that has a number. Blank = unlimited (no batch limit). Enter 0 for no new batch (sold out unless leftover carried in).'
  );
  return sheet;
}

function findStockTotalRow_(sheet) {
  if (sheet.getLastRow() < 2) return 0;
  var names = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim().toUpperCase() === 'TOTAL') return i + 2;
  }
  return 0;
}

function findStockTotalCol_(sheet) {
  var raw = getHeaderRaw_(sheet);
  for (var c = 0; c < raw.length; c++) {
    if (String(raw[c] || '').trim().toUpperCase() === 'TOTAL') return c + 1;
  }
  return 0;
}

function dateColumnsFromSheet_(sheet) {
  var raw = getHeaderRaw_(sheet);
  var cols = [];
  for (var c = 0; c < raw.length; c++) {
    if (c === 0) continue;
    var parsed = parseStockDateHeader_(raw[c], c + 1);
    if (parsed) cols.push(parsed.col);
  }
  return cols;
}

function ensureTotalColumnIsLast_(sheet) {
  var totalCol = findStockTotalCol_(sheet);
  var last = sheet.getLastColumn();
  if (totalCol > 0 && totalCol < last) {
    sheet.moveColumns(totalCol, last + 1);
  }
}

/** Write opening stock only into empty cells; never overwrite an edit. */
function seedInitialStock_(sheet) {
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (lastRow < 1 || lastCol < 2) return;
  var raw = getHeaderRaw_(sheet);
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var rowOf = {};
  var r, c;
  for (r = 1; r < values.length; r++) {
    var name = String(values[r][0] || '').trim();
    if (name && name.toUpperCase() !== 'TOTAL') rowOf[name] = r + 1;
  }
  var dateIds = Object.keys(INITIAL_STOCK);
  for (var d = 0; d < dateIds.length; d++) {
    var id = dateIds[d];
    var col = -1;
    for (c = 1; c < raw.length; c++) {
      var parsed = parseStockDateHeader_(raw[c], c + 1);
      if (parsed && parsed.id === id) {
        col = c;
        break;
      }
    }
    if (col < 0) continue;
    var items = INITIAL_STOCK[id];
    var itemNames = Object.keys(items);
    for (var i = 0; i < itemNames.length; i++) {
      var item = itemNames[i];
      var row = rowOf[item];
      if (!row) continue;
      var cell = sheet.getRange(row, col + 1);
      var current = cell.getValue();
      if (current === '' || current === null || typeof current === 'undefined') {
        cell.setValue(items[item]);
      }
    }
  }
}

/**
 * Add or refresh a Total column (sum of numbered date caps per item) and
 * a TOTAL row (sum of numbered caps per date). Only parseable date columns
 * are included — new date columns are picked up automatically. Blank cells
 * are excluded from COUNTs, so a fully blank date column stays blank until
 * a quantity is typed.
 */
function refreshStockTotals_(sheet) {
  if (!sheet || sheet.getLastRow() === 0) return;
  ensureTotalColumnIsLast_(sheet);

  var dateCols = dateColumnsFromSheet_(sheet);
  var totalCol = findStockTotalCol_(sheet);
  if (totalCol <= 0) {
    totalCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, totalCol).setValue('Total');
  }

  var lastRow = sheet.getLastRow();
  var totalRow = findStockTotalRow_(sheet);
  var firstItem = 2;
  var lastItem;
  if (totalRow) lastItem = totalRow - 1;
  else lastItem = lastRow >= 2 ? lastRow : 1;

  function cellsInRow_(row) {
    return dateCols.map(function (c) { return colLetter_(c) + row; }).join(',');
  }

  if (lastItem >= firstItem && dateCols.length) {
    for (var r = firstItem; r <= lastItem; r++) {
      var itemName = String(sheet.getRange(r, 1).getValue() || '').trim();
      if (!itemName || itemName.toUpperCase() === 'TOTAL') continue;
      var rowCells = cellsInRow_(r);
      sheet.getRange(r, totalCol).setFormula(
        '=IF(COUNT(' + rowCells + ')=0,"",SUM(' + rowCells + '))'
      );
    }
  }

  if (lastItem >= firstItem) {
    if (!totalRow) {
      totalRow = lastItem + 1;
      sheet.getRange(totalRow, 1).setValue('TOTAL');
    }
    sheet.getRange(totalRow, 1).setValue('TOTAL');
    sheet.getRange(totalRow, 1, totalRow, totalCol).setFontWeight('bold');
    var i;
    for (i = 0; i < dateCols.length; i++) {
      var col = dateCols[i];
      var colRange = colLetter_(col) + firstItem + ':' + colLetter_(col) + lastItem;
      sheet.getRange(totalRow, col).setFormula(
        '=IF(COUNT(' + colRange + ')=0,"",SUM(' + colRange + '))'
      );
    }
    if (dateCols.length) {
      var blockCells = [];
      for (i = 0; i < dateCols.length; i++) {
        blockCells.push(colLetter_(dateCols[i]) + firstItem + ':' + colLetter_(dateCols[i]) + lastItem);
      }
      var block = blockCells.join(',');
      sheet.getRange(totalRow, totalCol).setFormula(
        '=IF(COUNT(' + block + ')=0,"",SUM(' + block + '))'
      );
    }
  }
}

function styleStockHeader_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var range = sheet.getRange(1, 1, 1, lastCol);
  range.setFontWeight('bold');
  range.setBackground('#0d3d8c');
  range.setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidth(1, 260);
}

function getOrderedQtys_(ordersSheet, dates) {
  if (!ordersSheet || ordersSheet.getLastRow() < 2) return {};
  return getOrderedQtysFromValues_(getSheetValues_(ordersSheet), dates);
}

function getOrderedQtysFromValues_(values, dates) {
  var byDate = {};
  if (!values || values.length < 2) return byDate;
  var headers = values[0].map(function (v) { return String(v || '').trim(); });
  var pickupIdx = headers.indexOf('Pickup Date');
  if (pickupIdx === -1) return byDate;
  var itemIdxs = [];
  var base = {};
  BASE_HEADERS.concat(LEGACY_HEADERS).forEach(function (h) { base[h] = true; });
  var c;
  for (c = 0; c < headers.length; c++) {
    if (headers[c] && !base[headers[c]]) itemIdxs.push(c);
  }
  for (var r = 1; r < values.length; r++) {
    var raw = values[r][pickupIdx];
    var date = findStockDate_(raw, dates);
    if (!date) continue;
    if (!byDate[date.id]) byDate[date.id] = {};
    for (var j = 0; j < itemIdxs.length; j++) {
      var col = itemIdxs[j];
      var name = headers[col];
      var qty = Number(values[r][col] || 0);
      if (!qty) continue;
      byDate[date.id][name] = (byDate[date.id][name] || 0) + qty;
    }
  }
  return byDate;
}

/**
 * Remaining stock per date + item (see computeRemainingFromTables_ for the
 * rules). Used = non-Cancelled orders + non-VOID walk-ins, read straight
 * from the Orders and Walk-in Sales tabs, so cancelling an order or voiding
 * a walk-in frees the stock again. The Tally tab is not used here.
 *
 * doGet uses CacheService for STOCK_CACHE_TTL seconds; every order, status
 * change and walk-in write invalidates it. processOrder_ passes bypassCache
 * so the check under the lock always sees fresh numbers.
 */
function getStockRemaining_(options) {
  options = options || {};
  if (!options.bypassCache) {
    var cached = readStockCache_();
    if (cached) return cached;
  }

  var ss = options.spreadsheet || getSpreadsheet_();
  var stock = ss.getSheetByName(STOCK_SHEET_NAME);
  var stockValues = getSheetValues_(stock);
  if (stockValues.length < 2 && options.ensure) {
    stock = ensureStockSheet_(ss, uniqueNames_(MENU_ITEM_COLUMNS.concat(options.itemNames || [])));
    stockValues = getSheetValues_(stock);
  }
  var dates = getStockDatesFromHeaderRow_(stockValues[0] || []);
  var used = {};
  // Nothing is limited unless some Stock cell holds a number, so skip the
  // Orders / Walk-in reads in that case.
  if (stockHasAnyCap_(stockValues)) {
    used = loadUsedByDate_(ss, dates, stockItemNames_(stockValues));
  }
  var payload = computeRemainingFromTables_(stockValues, used, MENU_ITEM_COLUMNS);

  if (!options.bypassCache) {
    putStockCache_(payload);
    return publicStockPayload_(payload);
  }
  return payload;
}

/** Remaining map {item: number|null} for one pickup date id (fresh read). */
function remainingMapForDateId_(ss, dateId, itemNames) {
  var payload = getStockRemaining_({
    spreadsheet: ss,
    bypassCache: true,
    itemNames: itemNames
  });
  return (payload.remaining && payload.remaining[dateId]) || {};
}

function stockItemNames_(stockValues) {
  var names = MENU_ITEM_COLUMNS.slice();
  var seen = {};
  names.forEach(function (n) { seen[n] = true; });
  for (var r = 1; r < (stockValues || []).length; r++) {
    var n = String((stockValues[r] || [])[0] || '').trim();
    if (!n || n.toUpperCase() === 'TOTAL' || seen[n]) continue;
    seen[n] = true;
    names.push(n);
  }
  return names;
}

function stockHasAnyCap_(stockValues) {
  var r, c, cell;
  for (r = 1; r < (stockValues || []).length; r++) {
    var name = String((stockValues[r] || [])[0] || '').trim();
    if (!name || name.toUpperCase() === 'TOTAL') continue;
    for (c = 1; c < stockValues[r].length; c++) {
      if (!parseStockDateHeader_(stockValues[0][c], c + 1)) continue;
      cell = stockValues[r][c];
      if (cell !== '' && cell !== null && typeof cell !== 'undefined' && !isNaN(Number(cell))) return true;
    }
  }
  return false;
}

/** {dateId: {item: qty}} of stock already used: non-Cancelled orders + non-VOID walk-ins. */
function loadUsedByDate_(ss, dates, itemNames) {
  var orders = ss.getSheetByName(ORDERS_SHEET_NAME);
  var walkIn = ss.getSheetByName(WALKIN_SHEET_NAME);
  var summary = computeOrderSummaryFromValues_(
    getSheetValues_(orders), dates, itemNames, new Date(), getSheetValues_(walkIn)
  );
  return usedByDateFromSummary_(summary, itemNames);
}

function usedByDateFromSummary_(summary, itemNames) {
  var used = {};
  var list = (summary && summary.dates) || [];
  for (var i = 0; i < list.length; i++) {
    var items = list[i].items || {};
    used[list[i].id] = {};
    for (var n = 0; n < itemNames.length; n++) {
      var rec = items[itemNames[n]];
      if (!rec) continue;
      var q = (Number(rec.ordered) || 0) + (Number(rec.walkIn) || 0);
      if (q) used[list[i].id][itemNames[n]] = q;
    }
  }
  return used;
}

/* ---- stock compute (testable) ---- */

function getStockDatesFromHeaderRow_(headerRow) {
  var seen = {};
  var dates = [];
  if (!headerRow || !headerRow.length) return dates;
  for (var c = 0; c < headerRow.length; c++) {
    if (c === 0) continue;
    var parsed = parseStockDateHeader_(headerRow[c], c + 1);
    if (!parsed) continue;
    if (seen[parsed.id]) continue;
    seen[parsed.id] = true;
    dates.push(parsed);
  }
  dates.sort(function (a, b) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    if (a.closesAt < b.closesAt) return -1;
    if (a.closesAt > b.closesAt) return 1;
    return a.col - b.col;
  });
  return dates;
}

/**
 * Stock Tab cell = batch quantity sent to Poppins for that date + item.
 * Per item, dates in order:
 *   blank cell   -> UNLIMITED (null) for that date, and it leaves no leftover
 *   numeric cell -> raw(D) = max(0, leftover carried in + cell - used on D)
 *                   and raw(D) is what carries into the next capped date.
 *   A numeric 0 means "no new batch": it is sold out unless leftover was
 *   carried in. An item with no Stock-tab row at all is unlimited.
 * Guard: remaining(D) = min(raw(D), raw of the capped dates that directly
 * follow D, stopping at the first unlimited date). An order on D uses the
 * shared pool, so it must not take stock a later date has already claimed.
 * An unlimited date resets the pool, which is why the chain stops there.
 * Only the first column for each date id is used (duplicate headers ignored).
 */
function computeRemainingFromTables_(stockValues, orderedByDate, menuNames) {
  orderedByDate = orderedByDate || {};
  menuNames = menuNames || [];
  var dates = getStockDatesFromHeaderRow_((stockValues && stockValues[0]) || []);
  var remaining = {};
  dates.forEach(function (d) {
    remaining[d.id] = {};
    menuNames.forEach(function (name) { remaining[d.id][name] = 0; });
  });
  if (!stockValues || stockValues.length < 2) {
    return { ok: true, dates: publicStockDates_(dates), remaining: remaining };
  }
  var firstColForDate = {};
  var hc, hd;
  for (hc = 1; hc < ((stockValues && stockValues[0]) || []).length; hc++) {
    hd = parseStockDateHeader_(stockValues[0][hc], hc + 1);
    if (hd && typeof firstColForDate[hd.id] === 'undefined') firstColForDate[hd.id] = hc;
  }

  var capsByDate = {};
  var numericByDate = {};
  dates.forEach(function (d) {
    capsByDate[d.id] = {};
    numericByDate[d.id] = {};
  });
  var itemNames = menuNames.slice();
  var seenItem = {};
  menuNames.forEach(function (n) { seenItem[n] = true; });
  var r, c, itemName, date, cell, cap;
  for (r = 1; r < stockValues.length; r++) {
    itemName = String(stockValues[r][0] || '').trim();
    if (!itemName || itemName.toUpperCase() === 'TOTAL') continue;
    if (!seenItem[itemName]) {
      seenItem[itemName] = true;
      itemNames.push(itemName);
      dates.forEach(function (d) { remaining[d.id][itemName] = 0; });
    }
    for (c = 1; c < stockValues[r].length; c++) {
      date = parseStockDateHeader_(stockValues[0][c], c + 1);
      if (!date) continue;
      if (firstColForDate[date.id] !== c) continue;
      if (!capsByDate[date.id]) continue;
      cell = stockValues[r][c];
      if (cell === '' || cell === null || typeof cell === 'undefined') continue;
      cap = Number(cell);
      if (isNaN(cap)) continue;
      capsByDate[date.id][itemName] = Math.max(0, cap);
      numericByDate[date.id][itemName] = true;
    }
  }

  var carried = carryForwardRemainingFromCaps_(dates, capsByDate, numericByDate, orderedByDate, itemNames);
  dates.forEach(function (d) {
    itemNames.forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(carried[d.id] || {}, name)) {
        remaining[d.id][name] = carried[d.id][name];
      }
    });
  });
  return { ok: true, dates: publicStockDates_(dates), remaining: remaining };
}

/**
 * capsByDate[dateId][item] is a number when a numeric cell exists (0 counts).
 * numericByDate[dateId][item] is true when that cell was numeric.
 * orderedByDate[dateId][item] is the stock already used on that date.
 * Returns remaining[dateId][item] as a number or null (unlimited).
 * Rules are described on computeRemainingFromTables_.
 */
function carryForwardRemainingFromCaps_(dates, capsByDate, numericByDate, orderedByDate, itemNames) {
  dates = dates || [];
  capsByDate = capsByDate || {};
  numericByDate = numericByDate || {};
  orderedByDate = orderedByDate || {};
  itemNames = itemNames || [];
  var remaining = {};
  var i, n, name, d, used, cap, hasNumeric, carry, raw, m, j;
  for (i = 0; i < dates.length; i++) remaining[dates[i].id] = {};
  for (n = 0; n < itemNames.length; n++) {
    name = itemNames[n];
    carry = 0;
    raw = [];
    for (i = 0; i < dates.length; i++) {
      d = dates[i].id;
      hasNumeric = !!(numericByDate[d] && numericByDate[d][name]);
      if (!hasNumeric) {
        raw.push(null); // unlimited date: nothing is left over from it
        carry = 0;
        continue;
      }
      cap = Number(capsByDate[d][name] || 0);
      if (isNaN(cap) || cap < 0) cap = 0;
      used = (orderedByDate[d] && orderedByDate[d][name]) ? Number(orderedByDate[d][name]) : 0;
      if (!used || isNaN(used)) used = 0;
      carry = Math.max(0, carry + cap - used);
      raw.push(carry);
    }
    for (i = 0; i < dates.length; i++) {
      if (raw[i] === null) {
        remaining[dates[i].id][name] = null;
        continue;
      }
      m = raw[i];
      for (j = i + 1; j < dates.length && raw[j] !== null; j++) {
        if (raw[j] < m) m = raw[j];
      }
      remaining[dates[i].id][name] = m;
    }
  }
  return remaining;
}

function incrementTallyMap_(orderedByDate, dateId, items) {
  var out = {};
  var k, name;
  for (k in (orderedByDate || {})) {
    if (!Object.prototype.hasOwnProperty.call(orderedByDate, k)) continue;
    out[k] = {};
    for (name in orderedByDate[k]) {
      if (Object.prototype.hasOwnProperty.call(orderedByDate[k], name)) {
        out[k][name] = orderedByDate[k][name];
      }
    }
  }
  if (!dateId) return out;
  if (!out[dateId]) out[dateId] = {};
  items = items || [];
  for (var i = 0; i < items.length; i++) {
    var line = items[i];
    if (!line || !line.name) continue;
    var qty = Number(line.qty || 0);
    if (!qty) continue;
    out[dateId][line.name] = (out[dateId][line.name] || 0) + qty;
  }
  return out;
}

function subtractOrderFromRemaining_(payload, dateId, items) {
  var remaining = {};
  var src = (payload && payload.remaining) || {};
  var id, name;
  for (id in src) {
    if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
    remaining[id] = {};
    for (name in src[id]) {
      if (Object.prototype.hasOwnProperty.call(src[id], name)) remaining[id][name] = src[id][name];
    }
  }
  items = items || [];
  if (dateId && !remaining[dateId]) remaining[dateId] = {};
  for (var i = 0; i < items.length; i++) {
    var line = items[i];
    if (!line || !line.name) continue;
    var qty = Number(line.qty || 0);
    if (!qty) continue;
    var cur = remaining[dateId][line.name];
    if (cur === null) continue; // unlimited stays unlimited
    if (typeof cur === 'undefined' || cur === '') cur = 0;
    remaining[dateId][line.name] = Math.max(0, Number(cur) - qty);
  }
  return { ok: true, dates: (payload && payload.dates) || [], remaining: remaining };
}

function stockCacheIsFresh_(cachedJson, gen) {
  if (!cachedJson || gen === '' || gen === null || typeof gen === 'undefined') return false;
  try {
    var obj = JSON.parse(cachedJson);
    return !!(obj && obj._gen != null && String(obj._gen) === String(gen) && obj.remaining);
  } catch (err) {
    return false;
  }
}

/**
 * Public shape of ?action=stock. remaining[dateId][item] is a number or
 * null (unlimited); it is also repeated on each dates[] entry.
 */
function publicStockPayload_(payload) {
  var remaining = (payload && payload.remaining) || {};
  var dates = ((payload && payload.dates) || []).map(function (d) {
    return {
      id: d.id,
      label: d.label,
      closesAt: d.closesAt,
      remaining: remaining[d.id] || {}
    };
  });
  return {
    ok: !!(payload && payload.ok),
    version: typeof SCRIPT_VERSION !== 'undefined' ? SCRIPT_VERSION : '',
    dates: dates,
    remaining: remaining
  };
}

/* ---- end stock compute ---- */

/* ---- order summary (testable) ---- */

var SUMMARY_CACHE_KEY = 'order-summary-v2';
var SUMMARY_CACHE_TTL = 30; // seconds

function normalizeOrderStatus_(status) {
  var s = String(status || '').trim().toLowerCase();
  if (/cancel/.test(s)) return 'Cancelled';
  if (/picked\s*up|collected/.test(s)) return 'Picked up';
  if (/^paid$|\bpaid\b/.test(s) && !/unpaid/.test(s)) return 'Paid';
  // Saved over stock: kept as its own status until staff handle it
  // (it moves on to Paid / Picked up / Cancelled like any order).
  if (/oversold/.test(s)) return 'OVERSOLD';
  // Legacy values such as OK, New, INVALID DATE - CHECK map to Pending.
  return 'Pending';
}

function isCancelledStatus_(status) {
  return normalizeOrderStatus_(status) === 'Cancelled';
}

function isPaidStatus_(status) {
  var n = normalizeOrderStatus_(status);
  return n === 'Paid' || n === 'Picked up';
}

function isPickedUpStatus_(status) {
  return normalizeOrderStatus_(status) === 'Picked up';
}

function normalizePayment_(value) {
  var s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (/upi|gpay|google\s*pay|phonepe|paytm/.test(s)) return 'UPI';
  if (/cash/.test(s)) return 'Cash';
  return '';
}

function isTestOrderName_(name) {
  // Only the Name column, and only when it contains the exact phrase
  // "TEST ORDER" (case-insensitive). Ordinary names are never skipped.
  if (typeof name !== 'string' && typeof name !== 'number') return false;
  return /TEST ORDER/i.test(String(name));
}

function emptyItemsMap_(itemNames) {
  var out = {};
  var i, row;
  for (i = 0; i < itemNames.length; i++) {
    row = { total: 0 };
    row.ordered = 0;
    row.pickedUp = 0;
    row.walkIn = 0;
    row.pending = 0; // cakes on orders still in Pending status
    out[itemNames[i]] = row;
  }
  return out;
}

function emptySalesBlock_() {
  return {
    ordered: { cakes: 0, amount: 0, orders: 0 },
    oversold: { cakes: 0, orders: 0 },
    cancelled: { orders: 0 },
    paid: { cakes: 0, amount: 0 },
    pickedUp: { cakes: 0 },
    pendingPickup: { cakes: 0 },
    walkIn: { cakes: 0, amount: 0, cash: 0, upi: 0 },
    totalSold: { cakes: 0 },
    collected: { amount: 0 }
  };
}

function finalizeSalesBlock_(sales) {
  sales.pendingPickup.cakes = Math.max(0, sales.ordered.cakes - sales.pickedUp.cakes);
  sales.totalSold.cakes = sales.pickedUp.cakes + sales.walkIn.cakes;
  sales.collected.amount = sales.paid.amount + sales.walkIn.amount;
  return sales;
}

function addSalesInto_(target, src) {
  target.ordered.cakes += src.ordered.cakes;
  target.ordered.amount += src.ordered.amount;
  target.ordered.orders += src.ordered.orders;
  target.oversold.cakes += src.oversold.cakes;
  target.oversold.orders += src.oversold.orders;
  target.cancelled.orders += src.cancelled.orders;
  target.paid.cakes += src.paid.cakes;
  target.paid.amount += src.paid.amount;
  target.pickedUp.cakes += src.pickedUp.cakes;
  target.walkIn.cakes += src.walkIn.cakes;
  target.walkIn.amount += src.walkIn.amount;
  target.walkIn.cash += src.walkIn.cash;
  target.walkIn.upi += src.walkIn.upi;
}

function dateStubFromId_(id) {
  var parsed = parseStockDateHeader_(id);
  if (parsed) return { id: parsed.id, label: parsed.label, closesAt: parsed.closesAt || '' };
  return { id: String(id || ''), label: String(id || ''), closesAt: '' };
}

function parseRawJson_(value) {
  if (!value) return null;
  if (isDateObject_(value)) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (err) {
    return null;
  }
}

function qtyFromRawItems_(raw, itemName) {
  if (!raw || !raw.items || !raw.items.length) return 0;
  var total = 0;
  var i, line;
  for (i = 0; i < raw.items.length; i++) {
    line = raw.items[i];
    if (line && line.name === itemName) total += Number(line.qty || 0) || 0;
  }
  return total;
}

function amountFromRaw_(raw) {
  if (!raw) return 0;
  var amount = Number(raw.totalAmount || 0) || 0;
  if (amount) return amount;
  if (!raw.items) return 0;
  var i, line, lineTotal;
  for (i = 0; i < raw.items.length; i++) {
    line = raw.items[i] || {};
    lineTotal = line.lineTotal != null ? Number(line.lineTotal) : (Number(line.qty || 0) * Number(line.price || 0));
    if (!isNaN(lineTotal)) amount += lineTotal;
  }
  return amount;
}

function timestampMs_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return 0;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.getTime();
  }
  var d = new Date(value);
  if (!isNaN(d.getTime())) return d.getTime();
  return 0;
}

function formatSummaryTime_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return '';
  var d = value;
  if (Object.prototype.toString.call(value) !== '[object Date]') {
    d = new Date(value);
  }
  if (Object.prototype.toString.call(d) !== '[object Date]' || isNaN(d.getTime())) {
    return String(value);
  }
  try {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(d, 'Asia/Kolkata', 'dd/MM/yyyy, hh:mm:ss a') + ' IST';
    }
  } catch (err) {}
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(d) + ' IST';
  } catch (err2) {
    return d.toISOString();
  }
}

/**
 * Aggregate Orders (and optional Walk-in Sales) into per-date totals.
 * values / walkInValues are header + data grids. dates is the Stock
 * catalog (in order). Personal fields are never returned.
 * walk-ins on dates not in the catalog are appended.
 */
function computeOrderSummaryFromValues_(values, dates, itemNames, now, walkInValues) {
  itemNames = itemNames && itemNames.length ? itemNames : MENU_ITEM_COLUMNS.slice();
  dates = dates || [];
  values = values || [];
  now = now || new Date();

  var headers = ((values[0] || []).slice()).map(function (h) { return String(h || '').trim(); });
  var col = {};
  var c;
  for (c = 0; c < headers.length; c++) {
    if (headers[c] && typeof col[headers[c]] === 'undefined') col[headers[c]] = c;
  }

  function cell(row, name) {
    return typeof col[name] === 'number' ? row[col[name]] : '';
  }

  var itemCols = {};
  var hasAnyItemCol = false;
  var n;
  for (n = 0; n < itemNames.length; n++) {
    if (typeof col[itemNames[n]] === 'number') {
      itemCols[itemNames[n]] = col[itemNames[n]];
      hasAnyItemCol = true;
    }
  }

  var byId = {};
  var dateOrder = [];
  var d, date, bucket;

  function ensureBucket(id, fallback) {
    if (byId[id]) return byId[id];
    var meta = findStockDate_(id, dates) || fallback || dateStubFromId_(id);
    var rec = {
      id: meta.id || id,
      label: meta.label || id,
      closesAt: meta.closesAt || '',
      items: emptyItemsMap_(itemNames),
      totals: { cakes: 0, amount: 0, orders: 0 },
      pending: { orders: 0, cakes: 0, amount: 0 },
      sales: emptySalesBlock_()
    };
    byId[rec.id] = rec;
    dateOrder.push(rec.id);
    return rec;
  }

  for (d = 0; d < dates.length; d++) {
    date = dates[d];
    ensureBucket(date.id, date);
  }

  var latestMs = 0;
  var latestValue = '';
  var r, row, raw, dateVal, cakes, amount, q, itemName, ts, tsMs, i, status;

  for (r = 1; r < values.length; r++) {
    row = values[r] || [];
    if (isTestOrderName_(cell(row, 'Name'))) continue;

    raw = parseRawJson_(cell(row, 'Raw JSON'));
    dateVal = cell(row, 'Pickup Date');
    date = findStockDate_(dateVal, dates);
    if (!date && raw) date = findStockDate_(raw.pickupDate || raw.pickupDateLabel, dates);
    if (!date) {
      var looseId = normalizePickupDateId_(dateVal) || (raw && normalizePickupDateId_(raw.pickupDate || raw.pickupDateLabel));
      if (looseId) date = dateStubFromId_(looseId);
    }
    if (!date) continue;

    bucket = ensureBucket(date.id, date);
    status = normalizeOrderStatus_(cell(row, 'Status'));
    if (status === 'Cancelled') {
      bucket.sales.cancelled.orders += 1;
      continue;
    }

    cakes = 0;
    for (i = 0; i < itemNames.length; i++) {
      itemName = itemNames[i];
      if (hasAnyItemCol) {
        q = typeof itemCols[itemName] === 'number' ? Number(row[itemCols[itemName]] || 0) : 0;
      } else {
        q = qtyFromRawItems_(raw, itemName);
      }
      if (!q || isNaN(q)) q = 0;
      bucket.items[itemName].total += q;
      bucket.items[itemName].ordered += q;
      if (status === 'Picked up') bucket.items[itemName].pickedUp += q;
      if (status === 'Pending') bucket.items[itemName].pending += q;
      cakes += q;
    }

    amount = Number(cell(row, 'Total Amount (₹)') || 0) || 0;
    if (!amount) amount = amountFromRaw_(raw);
    bucket.totals.cakes += cakes;
    bucket.totals.amount += amount;
    bucket.totals.orders += 1;
    if (status === 'Pending') {
      // Aggregates only (the Orders page has no PIN): exactly Pending, not
      // Paid / Picked up / Cancelled / OVERSOLD.
      bucket.pending.orders += 1;
      bucket.pending.cakes += cakes;
      bucket.pending.amount += amount;
    }
    bucket.sales.ordered.cakes += cakes;
    bucket.sales.ordered.amount += amount;
    bucket.sales.ordered.orders += 1;
    if (status === 'OVERSOLD') {
      // Counted in ordered above; listed separately so staff can see them.
      bucket.sales.oversold.cakes += cakes;
      bucket.sales.oversold.orders += 1;
    }
    if (isPaidStatus_(status)) {
      bucket.sales.paid.cakes += cakes;
      bucket.sales.paid.amount += amount;
    }
    if (status === 'Picked up') {
      bucket.sales.pickedUp.cakes += cakes;
    }

    ts = cell(row, 'Timestamp') || (raw && raw.timestamp) || '';
    tsMs = timestampMs_(ts);
    if (tsMs > latestMs) {
      latestMs = tsMs;
      latestValue = ts;
    }
  }

  addWalkInsToSummary_(byId, ensureBucket, walkInValues, itemNames);

  var list = [];
  var seen = {};
  var grand = {
    cakes: 0,
    amount: 0,
    orders: 0,
    pending: { orders: 0, cakes: 0, amount: 0 },
    items: emptyItemsMap_(itemNames),
    sales: emptySalesBlock_()
  };
  var extra;
  function pushBucket(b) {
    if (!b || seen[b.id]) return;
    seen[b.id] = true;
    finalizeSalesBlock_(b.sales);
    list.push(b);
    grand.cakes += b.totals.cakes;
    grand.amount += b.totals.amount;
    grand.orders += b.totals.orders;
    grand.pending.orders += b.pending.orders;
    grand.pending.cakes += b.pending.cakes;
    grand.pending.amount += b.pending.amount;
    addSalesInto_(grand.sales, b.sales);
    for (i = 0; i < itemNames.length; i++) {
      itemName = itemNames[i];
      grand.items[itemName].total += b.items[itemName].total;
      grand.items[itemName].ordered += b.items[itemName].ordered;
      grand.items[itemName].pickedUp += b.items[itemName].pickedUp;
      grand.items[itemName].walkIn += b.items[itemName].walkIn;
      grand.items[itemName].pending += b.items[itemName].pending;
    }
  }
  for (d = 0; d < dates.length; d++) pushBucket(byId[dates[d].id]);
  extra = [];
  for (d = 0; d < dateOrder.length; d++) {
    if (!seen[dateOrder[d]]) extra.push(dateOrder[d]);
  }
  extra.sort();
  for (d = 0; d < extra.length; d++) pushBucket(byId[extra[d]]);
  finalizeSalesBlock_(grand.sales);

  return {
    ok: true,
    version: typeof SCRIPT_VERSION !== 'undefined' ? SCRIPT_VERSION : '',
    lastUpdated: formatSummaryTime_(now),
    latestOrderAt: latestMs ? formatSummaryTime_(latestValue) : '',
    dates: list,
    grand: grand
  };
}

function isVoidWalkIn_(voidCell, notesCell) {
  if (/^void$/i.test(String(voidCell || '').trim())) return true;
  if (/^\s*VOID\b/i.test(String(notesCell || ''))) return true;
  return false;
}

function addWalkInsToSummary_(byId, ensureBucket, walkInValues, itemNames) {
  walkInValues = walkInValues || [];
  if (walkInValues.length < 2) return;
  var headers = ((walkInValues[0] || []).slice()).map(function (h) { return String(h || '').trim(); });
  var col = {};
  var c, r, row, dateId, date, bucket, name, qty, amount, price, payment, i;
  for (c = 0; c < headers.length; c++) {
    if (headers[c] && typeof col[headers[c]] === 'undefined') col[headers[c]] = c;
  }
  function wcell(row, name) {
    return typeof col[name] === 'number' ? row[col[name]] : '';
  }
  for (r = 1; r < walkInValues.length; r++) {
    row = walkInValues[r] || [];
    dateId = normalizePickupDateId_(wcell(row, 'Date'));
    if (!dateId) {
      date = findStockDate_(wcell(row, 'Date'), []);
      dateId = date ? date.id : '';
    }
    if (!dateId) continue;
    if (isVoidWalkIn_(wcell(row, 'Void'), wcell(row, 'Notes'))) continue;
    name = String(wcell(row, 'Item') || '').trim();
    qty = Number(wcell(row, 'Qty') || 0) || 0;
    if (!qty || !name) continue;
    price = Number(wcell(row, 'Price each') || 0) || 0;
    amount = Number(wcell(row, 'Amount') || 0) || 0;
    if (!amount) amount = qty * price;
    payment = normalizePayment_(wcell(row, 'Payment'));
    bucket = ensureBucket(dateId, dateStubFromId_(dateId));
    if (bucket.items[name]) {
      bucket.items[name].walkIn += qty;
    }
    bucket.sales.walkIn.cakes += qty;
    bucket.sales.walkIn.amount += amount;
    if (payment === 'Cash') bucket.sales.walkIn.cash += amount;
    if (payment === 'UPI') bucket.sales.walkIn.upi += amount;
  }
}

function invalidateSummaryCache_() {
  try {
    var cache = getScriptCacheSafe_();
    if (cache) cache.remove(SUMMARY_CACHE_KEY);
  } catch (err) {}
}

/* ---- end order summary ---- */

function getScriptCacheSafe_() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    return null;
  }
}

function getOrderSummaryPayload_(ss) {
  var cache = getScriptCacheSafe_();
  try {
    var cached = cache && cache.get(SUMMARY_CACHE_KEY);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && parsed.ok) return parsed;
    }
  } catch (err) {}

  var dates = publicStockDates_(getPickupDatesCached_(ss));
  var sheet = ss && ss.getSheetByName(ORDERS_SHEET_NAME);
  var values = [];
  if (sheet) {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow >= 1 && lastCol >= 1) {
      values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    }
  }
  var walkInSheet = ss && ss.getSheetByName(WALKIN_SHEET_NAME);
  if (!walkInSheet && ss) {
    try { walkInSheet = ensureWalkInSalesSheet_(ss); } catch (errWalk) { walkInSheet = null; }
  }
  var walkInValues = [];
  if (walkInSheet) {
    var wLastRow = walkInSheet.getLastRow();
    var wLastCol = walkInSheet.getLastColumn();
    if (wLastRow >= 1 && wLastCol >= 1) {
      walkInValues = walkInSheet.getRange(1, 1, wLastRow, wLastCol).getValues();
    }
  }
  var payload = computeOrderSummaryFromValues_(values, dates, MENU_ITEM_COLUMNS, new Date(), walkInValues);
  try {
    if (cache) cache.put(SUMMARY_CACHE_KEY, JSON.stringify(payload), SUMMARY_CACHE_TTL);
  } catch (err2) {}
  return payload;
}

function readStockCache_() {
  var cache = getScriptCacheSafe_();
  if (!cache) return null;
  try {
    var got = cache.getAll([STOCK_CACHE_KEY, STOCK_CACHE_GEN_KEY]);
    if (!stockCacheIsFresh_(got[STOCK_CACHE_KEY], got[STOCK_CACHE_GEN_KEY])) return null;
    var obj = JSON.parse(got[STOCK_CACHE_KEY]);
    return publicStockPayload_(obj);
  } catch (err) {
    return null;
  }
}

function putStockCache_(payload) {
  var cache = getScriptCacheSafe_();
  if (!cache || !payload) return;
  try {
    var gen = String(Date.now());
    var body = JSON.stringify({
      ok: payload.ok,
      dates: payload.dates || [],
      remaining: payload.remaining || {},
      _gen: gen
    });
    cache.put(STOCK_CACHE_GEN_KEY, gen, STOCK_CACHE_TTL);
    cache.put(STOCK_CACHE_KEY, body, STOCK_CACHE_TTL);
  } catch (err) {}
}

function invalidateStockCache_() {
  var cache = getScriptCacheSafe_();
  if (!cache) return;
  try {
    cache.removeAll([STOCK_CACHE_KEY, STOCK_CACHE_GEN_KEY]);
  } catch (err) {
    try {
      cache.remove(STOCK_CACHE_KEY);
      cache.remove(STOCK_CACHE_GEN_KEY);
    } catch (err2) {}
  }
}

/** Invalidate, then write a fresh 25s payload so the next doGet is warm. */
function bumpStockCache_(payload) {
  invalidateStockCache_();
  putStockCache_(payload);
}

function tallyDatesKey_(dates) {
  return (dates || []).map(function (d) { return d.id; }).join(',');
}

function readTallyMap_(values, dates) {
  var ordered = {};
  if (!values || values.length < 2) return null;
  var meta = values[0];
  if (String(meta[0] || '') !== '#tally') return null;
  var expectedKey = tallyDatesKey_(dates);
  if (String(meta[3] || '') !== expectedKey) return null;
  var header = values[1];
  var dateAt = {};
  var c, parsed, r, name, id;
  for (c = 1; c < header.length; c++) {
    parsed = parseStockDateHeader_(header[c], c + 1);
    if (parsed) dateAt[c] = parsed.id;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(header[c] || '').trim())) {
      dateAt[c] = String(header[c]).trim();
    }
  }
  for (r = 2; r < values.length; r++) {
    name = String(values[r][0] || '').trim();
    if (!name || name.toUpperCase() === 'TOTAL') continue;
    for (c = 1; c < values[r].length; c++) {
      id = dateAt[c];
      if (!id) continue;
      if (!ordered[id]) ordered[id] = {};
      var n = Number(values[r][c] || 0);
      if (n) ordered[id][name] = n;
    }
  }
  return { ordered: ordered, lastRow: Number(meta[1] || 0), lastOrderId: String(meta[2] || '') };
}

function writeTallySheet_(sheet, dates, ordered, lastRow, lastOrderId) {
  var itemNames = uniqueNames_(MENU_ITEM_COLUMNS.concat(tallyItemNames_(ordered)));
  var headers = ['Item'].concat((dates || []).map(function (d) { return d.id; }));
  var values = [
    ['#tally', lastRow || 0, lastOrderId || '', tallyDatesKey_(dates)],
    headers
  ];
  var r, c, id, name;
  for (r = 0; r < itemNames.length; r++) {
    name = itemNames[r];
    var row = [name];
    for (c = 0; c < (dates || []).length; c++) {
      id = dates[c].id;
      row.push((ordered[id] && ordered[id][name]) ? ordered[id][name] : 0);
    }
    values.push(row);
  }
  // Pad every row to the same width: setValues needs a rectangular array
  // (the meta row has 4 cells, the date rows have 1 + number of dates).
  var width = 0;
  for (r = 0; r < values.length; r++) width = Math.max(width, values[r].length);
  for (r = 0; r < values.length; r++) {
    while (values[r].length < width) values[r].push('');
  }
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, width).setValues(values);
}

function tallyItemNames_(ordered) {
  var names = [];
  var id, name;
  for (id in (ordered || {})) {
    if (!Object.prototype.hasOwnProperty.call(ordered, id)) continue;
    for (name in ordered[id]) {
      if (Object.prototype.hasOwnProperty.call(ordered[id], name)) names.push(name);
    }
  }
  return names;
}

function rebuildTallySheet_(ss, orders, dates, stockValues) {
  ss = ss || getSpreadsheet_();
  orders = orders || ss.getSheetByName(ORDERS_SHEET_NAME);
  var stock = ss.getSheetByName(STOCK_SHEET_NAME);
  if (!dates) {
    var sv = stockValues || getSheetValues_(stock);
    dates = getStockDatesFromHeaderRow_(sv[0] || []);
  }
  var sheet = getOrCreateSheet_(ss, TALLY_SHEET_NAME);
  try { sheet.hideSheet(); } catch (err) {}
  var values = (orders && orders.getLastRow() >= 2) ? getSheetValues_(orders) : [];
  var ordered = getOrderedQtysFromValues_(values, dates);
  var lastRow = orders ? orders.getLastRow() : 0;
  var lastOrderId = '';
  if (values.length >= 2) {
    var headers = values[0].map(function (v) { return String(v || '').trim(); });
    var idIdx = headers.indexOf('Order ID');
    if (idIdx >= 0) lastOrderId = String(values[values.length - 1][idIdx] || '').trim();
  }
  writeTallySheet_(sheet, dates, ordered, lastRow, lastOrderId);
  return ordered;
}

function getTallyOrRebuild_(ss, orders, dates, stockValues) {
  return loadTallyState_(ss, orders, dates, stockValues).ordered;
}

function loadTallyState_(ss, orders, dates, stockValues, ordersLastRow) {
  var tally = ss.getSheetByName(TALLY_SHEET_NAME);
  var ordersLast = (typeof ordersLastRow === 'number') ? ordersLastRow : (orders ? orders.getLastRow() : 0);
  if (tally && tally.getLastRow() >= 2) {
    var values = getSheetValues_(tally);
    var parsed = readTallyMap_(values, dates);
    if (parsed && parsed.lastRow === ordersLast) {
      return {
        ordered: parsed.ordered,
        values: values,
        sheet: tally,
        lastRow: parsed.lastRow,
        lastOrderId: parsed.lastOrderId,
        rebuilt: false
      };
    }
  }
  var ordered = rebuildTallySheet_(ss, orders, dates, stockValues);
  return {
    ordered: ordered,
    values: null,
    sheet: ss.getSheetByName(TALLY_SHEET_NAME),
    lastRow: ordersLast,
    lastOrderId: '',
    rebuilt: true
  };
}

function applyTallyPatch_(sheet, plan) {
  sheet.getRange(1, 2, 1, 2).setValues([plan.meta]);
  if (plan.column && plan.column.length) {
    sheet.getRange(plan.startRow, plan.dateCol + 1, plan.column.length, 1).setValues(plan.column);
  }
}

function incrementTallyForOrder_(ss, dateId, items, ordersSheet, context) {
  context = context || {};
  var dates = context.dates;
  var stockValues = context.stockValues;
  if (!dates) {
    var stock = ss.getSheetByName(STOCK_SHEET_NAME);
    stockValues = stockValues || getSheetValues_(stock);
    dates = getStockDatesFromHeaderRow_(stockValues[0] || []);
  }
  var ordersLast = (context.ordersLastRow != null)
    ? context.ordersLastRow
    : (ordersSheet ? ordersSheet.getLastRow() : 0);
  var lastOrderId = (context.lastOrderId != null) ? context.lastOrderId : '';
  var tally = context.tallySheet || ss.getSheetByName(TALLY_SHEET_NAME);
  var values = context.tallyValues;
  if (!values && tally && tally.getLastRow() >= 2) values = getSheetValues_(tally);
  var parsed = values ? readTallyMap_(values, dates) : null;
  if (parsed && (parsed.lastRow === ordersLast - 1 || parsed.lastRow === ordersLast)) {
    var plan = planTallyPatch_(values, dates, dateId, items, ordersLast, lastOrderId);
    if (plan.ok && tally) {
      applyTallyPatch_(tally, plan);
      return incrementTallyMap_(parsed.ordered, dateId, items);
    }
    var ordered = incrementTallyMap_(parsed.ordered, dateId, items);
    if (!tally) tally = getOrCreateSheet_(ss, TALLY_SHEET_NAME);
    writeTallySheet_(tally, dates, ordered, ordersLast, lastOrderId);
    return ordered;
  }
  return rebuildTallySheet_(ss, ordersSheet, dates, stockValues);
}

function remainingMapForDate_(pickupLabel) {
  var payload = getStockRemaining_();
  var date = findStockDate_(pickupLabel, payload.dates);
  if (!date) return {};
  return payload.remaining[date.id] || {};
}

function stockStatusForOrder_(pickupLabel, items) {
  if (!pickupLabel) return 'Pending';
  var remaining = remainingMapForDate_(pickupLabel);
  return orderExceedsRemaining_(items, remaining) ? 'OVERSOLD' : 'Pending';
}

function normalizeOrdersPickupDates_(ordersSheet, dates) {
  if (!ordersSheet || ordersSheet.getLastRow() < 2 || !dates || !dates.length) return;
  var lastCol = ordersSheet.getLastColumn();
  var lastRow = ordersSheet.getLastRow();
  var values = ordersSheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (v) { return String(v || '').trim(); });
  var pickupIdx = headers.indexOf('Pickup Date');
  if (pickupIdx === -1) return;
  for (var r = 1; r < values.length; r++) {
    var raw = values[r][pickupIdx];
    var date = findStockDate_(raw, dates);
    if (date && !(typeof raw === 'string' && raw === date.id)) {
      var cell = ordersSheet.getRange(r + 1, pickupIdx + 1);
      cell.setNumberFormat('@');
      cell.setValue(date.id);
    }
  }
}


/**
 * Status dropdown + colours on the Orders Status column.
 * Called from setupSheets / ensureOrdersSchema_, never from the
 * order-append hot path.
 */
function ensureOrdersStatusValidation_(sheet) {
  if (!sheet) return;
  try {
    var headers = getHeaders_(sheet);
    var idx = headers.indexOf('Status');
    if (idx < 0) return;
    var col = idx + 1;
    var last = Math.max(sheet.getMaxRows ? sheet.getMaxRows() : 1000, 2);
    var range = sheet.getRange(2, col, last - 1, 1);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(ORDER_STATUS_VALUES, true)
      .setAllowInvalid(true)
      .setHelpText('Pending, Paid, Picked up, Cancelled, or OVERSOLD (saved over stock)')
      .build();
    range.setDataValidation(rule);

    var existing = sheet.getConditionalFormatRules ? (sheet.getConditionalFormatRules() || []) : [];
    var kept = [];
    var i, j, ranges, drop;
    for (i = 0; i < existing.length; i++) {
      drop = false;
      ranges = existing[i].getRanges ? existing[i].getRanges() : [];
      for (j = 0; j < ranges.length; j++) {
        if (ranges[j].getColumn && ranges[j].getColumn() === col && ranges[j].getNumColumns && ranges[j].getNumColumns() === 1) {
          drop = true;
        }
      }
      if (!drop) kept.push(existing[i]);
    }
    function statusColour(text, bg, fg, strike) {
      var builder = SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo(text)
        .setBackground(bg)
        .setFontColor(fg)
        .setRanges([range]);
      if (strike && builder.setStrikethrough) builder.setStrikethrough(true);
      return builder.build();
    }
    // Palette: Paid = gold, Picked up = pine green, Cancelled = grey + strikethrough,
    // OVERSOLD = red-orange.
    kept.push(statusColour('Paid', '#f6e4c1', '#904108', false));
    kept.push(statusColour('Picked up', '#e4edd4', '#435718', false));
    kept.push(statusColour('Cancelled', '#e8e6e0', '#6b6658', true));
    // OVERSOLD = saved over the stock left for that date: red-orange so staff spot it.
    kept.push(statusColour('OVERSOLD', '#fbd5cf', '#9c1c10', false));
    if (sheet.setConditionalFormatRules) sheet.setConditionalFormatRules(kept);
  } catch (err) {}
}

function ensureItemPricesSheet_(ss) {
  var tab = getOrCreateSheet_(ss, ITEM_PRICES_SHEET_NAME);
  var rows = [['Item', 'Price']];
  var i, name;
  for (i = 0; i < MENU_ITEM_COLUMNS.length; i++) {
    name = MENU_ITEM_COLUMNS[i];
    rows.push([name, MENU_ITEM_PRICES[name] || 0]);
  }
  tab.getRange(1, 1, rows.length, 2).setValues(rows);
  tab.getRange(1, 1, 1, 2).setFontWeight('bold');
  tab.setColumnWidth(1, 260);
  tab.setColumnWidth(2, 80);
  if (tab.hideSheet) tab.hideSheet();
  return tab;
}

function applyListValidation_(range, values) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(true)
    .build();
  range.setDataValidation(rule);
}

function ensureWalkInSalesSheet_(ss) {
  ensureItemPricesSheet_(ss);
  var tab = getOrCreateSheet_(ss, WALKIN_SHEET_NAME);
  var lastCol = tab.getLastColumn();
  var lastRow = tab.getLastRow();
  if (lastRow === 0 || lastCol === 0 || String(tab.getRange(1, 1).getValue() || '') !== 'Date') {
    tab.getRange(1, 1, 1, WALKIN_HEADERS.length).setValues([WALKIN_HEADERS]);
  }
  // Columns are looked up by header name so a legacy sheet that still has a
  // "Mass" column (until Cake Sale -> Remove Mass columns...) keeps working.
  var hdr = getHeaders_(tab);
  function col(name) { return hdr.indexOf(name) + 1; } // 1-based, 0 = missing
  var header = tab.getRange(1, 1, 1, hdr.length);
  header.setFontWeight('bold');
  header.setBackground('#7a0a10');
  header.setFontColor('#ffffff');
  tab.setFrozenRows(1);
  var widths = { 'Date': 130, 'Item': 260, 'Qty': 70, 'Price each': 100, 'Amount': 100, 'Payment': 100, 'Notes': 220 };
  Object.keys(widths).forEach(function (name) {
    if (col(name)) tab.setColumnWidth(col(name), widths[name]);
  });

  var maxRows = Math.max(tab.getMaxRows ? tab.getMaxRows() : 1000, 2);
  var dataRows = maxRows - 1;
  if (col('Date')) tab.getRange(2, col('Date'), dataRows, 1).setNumberFormat('yyyy-mm-dd');
  try {
    var dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build();
    if (col('Date')) tab.getRange(2, col('Date'), dataRows, 1).setDataValidation(dateRule);
    if (col('Item')) applyListValidation_(tab.getRange(2, col('Item'), dataRows, 1), MENU_ITEM_COLUMNS.slice());
    if (col('Payment')) applyListValidation_(tab.getRange(2, col('Payment'), dataRows, 1), WALKIN_PAYMENT_VALUES);
  } catch (err) {}

  var itemL = col('Item') ? colLetter_(col('Item')) : 'B';
  var qtyL = col('Qty') ? colLetter_(col('Qty')) : 'C';
  var priceL = col('Price each') ? colLetter_(col('Price each')) : 'D';
  if (col('Price each')) {
    var priceCell = String(tab.getRange(2, col('Price each')).getFormula ? tab.getRange(2, col('Price each')).getFormula() : '');
    if (!priceCell) {
      tab.getRange(2, col('Price each')).setFormula(
        '=ARRAYFORMULA(IF(' + itemL + '2:' + itemL + '="",,IFERROR(VLOOKUP(' + itemL + '2:' + itemL + ',' + ITEM_PRICES_SHEET_NAME + '!$A:$B,2,FALSE),"")))'
      );
    }
  }
  if (col('Amount')) {
    var amountCell = String(tab.getRange(2, col('Amount')).getFormula ? tab.getRange(2, col('Amount')).getFormula() : '');
    if (!amountCell) {
      tab.getRange(2, col('Amount')).setFormula(
        '=ARRAYFORMULA(IF(' + qtyL + '2:' + qtyL + '="",,IFERROR(' + qtyL + '2:' + qtyL + '*' + priceL + '2:' + priceL + ',"")))'
      );
    }
  }
  ensureWalkInExtraColumns_(tab);
  return tab;
}


/* ---------- Weekly Summary (live formulas over Orders) ---------- */

function refreshWeeklySummaryIfNeeded_(ss, ordersSheet, dates) {
  if (!dates) {
    var stock = ss.getSheetByName(STOCK_SHEET_NAME);
    dates = stock ? getStockDatesFromSheet_(stock) : [];
  }
  var tab = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (!tab || tab.getLastRow() < 4) {
    refreshWeeklySummary_(ss, ordersSheet);
    return;
  }
  var expected = dates.length; // one row per pickup date
  var labels = tab.getRange(4, 1, Math.max(tab.getLastRow() - 3, 1), 1).getValues();
  var found = {};
  var n = 0;
  for (var i = 0; i < labels.length; i++) {
    var v = String(labels[i][0] || '').trim();
    if (!v) continue;
    if (v.toUpperCase() === 'TOTAL') break;
    found[v] = true;
    n += 1;
  }
  if (n !== expected) {
    refreshWeeklySummary_(ss, ordersSheet);
    return;
  }
  for (var d = 0; d < dates.length; d++) {
    if (!found[dates[d].label]) {
      refreshWeeklySummary_(ss, ordersSheet);
      return;
    }
  }
}

function refreshWeeklySummary_(ss, ordersSheet) {
  var tab = getOrCreateSheet_(ss, SUMMARY_SHEET_NAME);
  var itemNames = getItemColumnNames_(ordersSheet);
  if (!itemNames.length) itemNames = MENU_ITEM_COLUMNS.slice();

  var stock = ss.getSheetByName(STOCK_SHEET_NAME);
  var dates = stock ? getStockDatesFromSheet_(stock) : [];
  normalizeOrdersPickupDates_(ordersSheet, dates);

  tab.clear();
  tab.getRange(1, 1).setValue('Weekly Summary — Vailankanni Matha Youth Cake Sale');
  tab.getRange(1, 1).setFontWeight('bold');
  tab.getRange(1, 1).setFontSize(14);
  tab.getRange(2, 1).setValue(
    'Live ordered totals from the Orders tab (Cancelled rows are excluded; OVERSOLD orders count as ordered). Picked up and Walk-in columns are cakes. A Walk-in block by date sits below the total. The Stock tab holds the batch quantity per date — add a date there, then use Cake Sale → Refresh Weekly Summary. Placing an order does not rebuild this tab.'
  );

  var headers = ['Pickup Date', 'Orders'].concat(itemNames).concat(['Total Cakes', 'Total ₹', 'Picked up', 'Walk-in']);
  tab.getRange(3, 1, 1, headers.length).setValues([headers]);
  var headerRange = tab.getRange(3, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#b91c1c');
  headerRange.setFontColor('#ffffff');
  tab.setFrozenRows(3);

  var firstData = 4;
  var i, j, row, n;
  n = 0;
  for (i = 0; i < dates.length; i++) {
    row = firstData + n;
    n += 1;
    tab.getRange(row, 1).setValue(dates[i].label);
    var pickupLit = quoteSheetString_(dates[i].id);
    tab.getRange(row, 2).setFormula(countIfPickupFormula_(pickupLit));
    for (j = 0; j < itemNames.length; j++) {
      tab.getRange(row, 3 + j).setFormula(sumIfPickupFormula_(pickupLit, itemNames[j]));
    }
    var firstItemCol = 3;
    var lastItemCol = 2 + itemNames.length;
    var totalCakesCol = lastItemCol + 1;
    var totalRsCol = lastItemCol + 2;
    tab.getRange(row, totalCakesCol).setFormula(
      '=SUM(' + colLetter_(firstItemCol) + row + ':' + colLetter_(lastItemCol) + row + ')'
    );
    tab.getRange(row, totalRsCol).setFormula(sumIfPickupFormula_(pickupLit, 'Total Amount (₹)'));
    tab.getRange(row, totalRsCol + 1).setFormula(sumIfPickupPickedUpFormula_(pickupLit));
    tab.getRange(row, totalRsCol + 2).setFormula(sumWalkInForPickupFormula_(pickupLit, walkInLetter_('Qty')));
  }

  var totalRow;
  if (n > 0) {
    var lastData = firstData + n - 1;
    totalRow = lastData + 1;
    tab.getRange(totalRow, 1).setValue('TOTAL');
    tab.getRange(totalRow, 1, totalRow, headers.length).setFontWeight('bold');
    for (j = 2; j <= headers.length; j++) {
      tab.getRange(totalRow, j).setFormula(
        '=SUM(' + colLetter_(j) + firstData + ':' + colLetter_(j) + lastData + ')'
      );
    }
  } else {
    totalRow = firstData;
    tab.getRange(totalRow, 1).setValue('TOTAL');
    tab.getRange(totalRow, 1, totalRow, headers.length).setFontWeight('bold');
  }

  var walkInStart = totalRow + 2;
  tab.getRange(walkInStart, 1).setValue('Walk-in sales');
  tab.getRange(walkInStart, 1).setFontWeight('bold');
  tab.getRange(walkInStart + 1, 1, 1, 5).setValues([['Pickup Date', 'Cakes', 'Amount (₹)', 'Cash', 'UPI']]);
  tab.getRange(walkInStart + 1, 1, 1, 5).setFontWeight('bold');
  tab.getRange(walkInStart + 1, 1, 1, 5).setBackground('#7a0a10');
  tab.getRange(walkInStart + 1, 1, 1, 5).setFontColor('#ffffff');
  var wr, wi, wrow, wPickup;
  for (wi = 0; wi < dates.length; wi++) {
    wrow = walkInStart + 2 + wi;
    wPickup = quoteSheetString_(dates[wi].id);
    tab.getRange(wrow, 1).setValue(dates[wi].label);
    tab.getRange(wrow, 2).setFormula(sumWalkInForPickupFormula_(wPickup, walkInLetter_('Qty')));
    tab.getRange(wrow, 3).setFormula(sumWalkInForPickupFormula_(wPickup, walkInLetter_('Amount')));
    tab.getRange(wrow, 4).setFormula(sumWalkInPaymentFormula_(wPickup, 'Cash'));
    tab.getRange(wrow, 5).setFormula(sumWalkInPaymentFormula_(wPickup, 'UPI'));
  }
  if (dates.length) {
    wr = walkInStart + 2 + dates.length;
    tab.getRange(wr, 1).setValue('WALK-IN TOTAL');
    tab.getRange(wr, 1, wr, 5).setFontWeight('bold');
    for (wi = 2; wi <= 5; wi++) {
      tab.getRange(wr, wi).setFormula('=SUM(' + colLetter_(wi) + (walkInStart + 2) + ':' + colLetter_(wi) + (wr - 1) + ')');
    }
  }

  tab.setColumnWidth(1, 180);
  tab.setColumnWidth(2, 90);
  tab.setColumnWidth(headers.length, 120);
}

function formatHeaderWithTime_(parsed) {
  var parts = parsed.id.split('-');
  var y = +parts[0], m = +parts[1], d = +parts[2];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var t = String(parsed.closesAt || '').match(/T(\d{2}):(\d{2})/);
  var h = t ? +t[1] : 8;
  var min = t ? +t[2] : 30;
  var ap = 'AM';
  var h12 = h;
  if (h === 0) { h12 = 12; ap = 'AM'; }
  else if (h === 12) { h12 = 12; ap = 'PM'; }
  else if (h > 12) { h12 = h - 12; ap = 'PM'; }
  return d + ' ' + months[m - 1] + ' ' + y + ' ' + h12 + ':' + pad2_(min) + ' ' + ap;
}

function addPickupDateColumn_(parsed) {
  var ss = getSpreadsheet_();
  var stock = ensureStockSheet_(ss, MENU_ITEM_COLUMNS);
  var existing = getStockDatesFromSheet_(stock);
  if (findStockDate_(parsed.id, existing)) return 'exists';
  ensureTotalColumnIsLast_(stock);
  var totalCol = findStockTotalCol_(stock);
  var insertAt;
  if (totalCol) {
    stock.insertColumnBefore(totalCol);
    insertAt = totalCol;
  } else {
    insertAt = stock.getLastColumn() + 1;
  }
  var cell = stock.getRange(1, insertAt);
  var parts = parsed.id.split('-');
  var y = +parts[0], m = +parts[1], d = +parts[2];
  var defaultClose = closesAtIso_(y, m, d, 8, 30);
  if (parsed.closesAt && parsed.closesAt !== defaultClose) {
    cell.setValue(formatHeaderWithTime_(parsed));
  } else {
    cell.setValue(new Date(y, m - 1, d));
    cell.setNumberFormat('d mmm yyyy');
  }
  refreshStockTotals_(stock);
  styleStockHeader_(stock);
  var orders = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
  rebuildTallySheet_(ss, orders, getStockDatesFromSheet_(stock));
  refreshWeeklySummary_(ss, orders);
  invalidateStockCache_();
  invalidatePickupDatesCache_();
  return 'added';
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Cake Sale')
    .addItem('Refresh Weekly Summary', 'refreshSummary')
    .addItem('Open Walk-in Sales', 'openWalkInSales')
    .addItem('Set staff PIN…', 'promptSetStaffPin')
    .addItem('Add pickup date…', 'promptAddPickupDate')
    .addItem('Remove Mass columns…', 'promptRemoveMassColumns')
    .addItem('Remove Assigned To column…', 'promptRemoveAssignedToColumn')
    .addToUi();
}

/**
 * Mass time is no longer collected. Existing sheets keep their old "Mass"
 * column (it is ignored everywhere) until you run this menu item, which
 * permanently deletes the column from Orders and Walk-in Sales and then
 * rebuilds the Weekly Summary. Nothing is deleted without the confirmation.
 */
function promptRemoveMassColumns() {
  var ui = SpreadsheetApp.getUi();
  var ss = getSpreadsheet_();
  var targets = [ORDERS_SHEET_NAME, WALKIN_SHEET_NAME].filter(function (name) {
    var tab = ss.getSheetByName(name);
    return tab && tab.getLastColumn() > 0 && getHeaders_(tab).indexOf('Mass') !== -1;
  });
  if (!targets.length) {
    ui.alert('No "Mass" column found on the Orders or Walk-in Sales tabs. Nothing to remove.');
    return;
  }
  var res = ui.alert(
    'Remove Mass columns?',
    'This PERMANENTLY deletes the "Mass" column (and its values) from: ' + targets.join(', ') +
    '. The Weekly Summary will be rebuilt without Mass rows. This cannot be undone ' +
    '(use File > Version history to recover). Continue?',
    ui.ButtonSet.OK_CANCEL
  );
  if (res !== ui.Button.OK) return;
  var removed = removeMassColumns_(ss);
  ui.alert('Removed ' + removed + ' Mass column(s) and rebuilt the Weekly Summary.');
}

/**
 * Orders are no longer assigned to a contact (there is no WhatsApp step).
 * Existing sheets keep their old "Assigned To" column (it is ignored
 * everywhere) until you run this menu item, which permanently deletes the
 * column from Orders after a confirmation. Nothing is deleted automatically.
 */
function promptRemoveAssignedToColumn() {
  var ui = SpreadsheetApp.getUi();
  var ss = getSpreadsheet_();
  var tab = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (!tab || tab.getLastColumn() < 1 || getHeaders_(tab).indexOf('Assigned To') === -1) {
    ui.alert('No "Assigned To" column found on the Orders tab. Nothing to remove.');
    return;
  }
  var res = ui.alert(
    'Remove Assigned To column?',
    'This PERMANENTLY deletes the "Assigned To" column (and its values) from the Orders tab. ' +
    'This cannot be undone (use File > Version history to recover). Continue?',
    ui.ButtonSet.OK_CANCEL
  );
  if (res !== ui.Button.OK) return;
  var removed = removeAssignedToColumn_(ss);
  ui.alert('Removed ' + removed + ' Assigned To column.');
}

function removeAssignedToColumn_(ss) {
  var tab = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (!tab || tab.getLastColumn() < 1) return 0;
  var idx = getHeaders_(tab).indexOf('Assigned To');
  if (idx < 0) return 0;
  tab.deleteColumn(idx + 1);
  invalidateSummaryCache_();
  return 1;
}

function removeMassColumns_(ss) {
  var removed = 0;
  [ORDERS_SHEET_NAME, WALKIN_SHEET_NAME].forEach(function (name) {
    var tab = ss.getSheetByName(name);
    if (!tab || tab.getLastColumn() < 1) return;
    var idx = getHeaders_(tab).indexOf('Mass');
    if (idx >= 0) {
      tab.deleteColumn(idx + 1);
      removed += 1;
    }
  });
  var orders = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
  refreshWeeklySummary_(ss, orders);
  invalidateStockCache_();
  invalidateSummaryCache_();
  return removed;
}

function openWalkInSales() {
  var ss = getSpreadsheet_();
  var tab = ensureWalkInSalesSheet_(ss);
  ss.setActiveSheet(tab);
}

function refreshSummary() {
  var ss = getSpreadsheet_();
  var orders = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
  ensureOrdersSchema_(orders, MENU_ITEM_COLUMNS);
  ensureOrdersStatusValidation_(orders);
  ensureWalkInSalesSheet_(ss);
  ensureStockSheet_(ss, MENU_ITEM_COLUMNS);
  rebuildTallySheet_(ss, orders);
  refreshWeeklySummary_(ss, orders);
  invalidateStockCache_();
  invalidatePickupDatesCache_();
  invalidateSummaryCache_();
}

function promptAddPickupDate() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'Add pickup date',
    'Enter a pickup date (e.g. 27 Dec 2026). Optional cutoff time: 27 Dec 2026 10:00 AM. Default cutoff is 8:30 AM IST.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var text = String(res.getResponseText() || '').trim();
  var parsed = parseStockDateHeader_(text);
  if (!parsed) {
    ui.alert('Could not read that as a date. Try e.g. 27 Dec 2026.');
    return;
  }
  var result = addPickupDateColumn_(parsed);
  if (result === 'exists') {
    ui.alert('That date is already on the Stock tab (' + parsed.label + ').');
    return;
  }
  ui.alert('Added ' + parsed.label + '. Fill quantities in the new column. Blank = no limit; enter 0 to mark sold out.');
}

function quoteSheetString_(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function matchHeaderFormula_(headerName) {
  return 'MATCH(' + quoteSheetString_(headerName) + ', Orders!$1:$1, 0)';
}

function pickupKeyExpr_(rangeExpr) {
  return 'IFERROR(TEXT(' + rangeExpr + ',"yyyy-mm-dd"),""&' + rangeExpr + ')';
}

function ordersCol_(headerName) {
  return 'INDEX(Orders!$1:$1048576, 0, ' + matchHeaderFormula_(headerName) + ')';
}

function notCancelledExpr_() {
  return '(NOT(REGEXMATCH(LOWER(""&' + ordersCol_('Status') + '),"cancel")))';
}

function countIfPickupFormula_(pickupCell) {
  return '=SUMPRODUCT((' + pickupKeyExpr_(ordersCol_('Pickup Date')) + '=' + pickupCell + ')*' +
    notCancelledExpr_() + ')';
}

function sumIfPickupFormula_(pickupCell, headerName) {
  return '=SUMPRODUCT((' + pickupKeyExpr_(ordersCol_('Pickup Date')) + '=' + pickupCell + ')*' +
    notCancelledExpr_() + '*' +
    'IFERROR(1*' + ordersCol_(headerName) + ',0))';
}

function sumIfPickupPickedUpFormula_(pickupCell) {
  return '=SUMPRODUCT((' + pickupKeyExpr_(ordersCol_('Pickup Date')) + '=' + pickupCell + ')*' +
    '(REGEXMATCH(LOWER(""&' + ordersCol_('Status') + '),"picked\\s*up"))*' +
    'IFERROR(1*' + ordersCol_('Total Items') + ',0))';
}

/**
 * Column letter of a Walk-in Sales header, read from the live tab so legacy
 * sheets that still carry a "Mass" column keep working. Falls back to the
 * Mass-free default layout (Date, Item, Qty, Price each, Amount, Payment).
 */
function walkInLetter_(name) {
  var defaults = { 'Date': 'A', 'Item': 'B', 'Qty': 'C', 'Price each': 'D', 'Amount': 'E', 'Payment': 'F' };
  try {
    var tab = getSpreadsheet_().getSheetByName(WALKIN_SHEET_NAME);
    if (tab) {
      var idx = getHeaders_(tab).indexOf(name);
      if (idx >= 0) return colLetter_(idx + 1);
    }
  } catch (err) {}
  return defaults[name];
}

function walkInCol_(letter) {
  return "'" + WALKIN_SHEET_NAME + "'!" + letter + '2:' + letter;
}

function sumWalkInForPickupFormula_(pickupCell, qtyOrAmountLetter) {
  return '=SUMPRODUCT((' + pickupKeyExpr_(walkInCol_(walkInLetter_('Date'))) + '=' + pickupCell +
    ')*IFERROR(1*' + walkInCol_(qtyOrAmountLetter) + ',0))';
}

function sumWalkInPaymentFormula_(pickupCell, payment) {
  return '=SUMPRODUCT((' + pickupKeyExpr_(walkInCol_('A')) + '=' + pickupCell +
    ')*(LOWER(""&' + walkInCol_(walkInLetter_('Payment')) + ')=' + quoteSheetString_(String(payment).toLowerCase()) + ')*' +
    'IFERROR(1*' + walkInCol_(walkInLetter_('Amount')) + ',0))';
}

function colLetter_(n) {
  var s = '';
  var num = n;
  while (num > 0) {
    var m = (num - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

function uniqueNames_(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var n = arr[i];
    if (n && !seen[n]) {
      seen[n] = true;
      out.push(n);
    }
  }
  return out;
}

/* ---------- Shared ---------- */

function formatItems_(items) {
  if (!items || !items.length) return '';
  var lines = [];
  for (var i = 0; i < items.length; i++) {
    var line = items[i];
    var qty = line.qty || 0;
    var name = line.name || '';
    var total = line.lineTotal != null ? line.lineTotal : (qty * (line.price || 0));
    lines.push(qty + ' x ' + name + ' – ₹' + total);
  }
  return lines.join('\n');
}


/* ---------- Staff PIN and phone UI APIs ---------- */

var STAFF_PIN_PROPERTY = 'STAFF_PIN';
var STAFF_FAIL_LIMIT = 5;
var STAFF_FAIL_WINDOW_SEC = 600;

function isStaffAction_(action) {
  return /^(staff_login|staff_orders|staff_set_status|staff_add_walkin|staff_walkins|staff_delete_walkin)$/.test(String(action || ''));
}

function getStaffPin_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(STAFF_PIN_PROPERTY) || '').trim();
  } catch (err) {
    return '';
  }
}

function pinsEqual_(a, b) {
  var left = String(a == null ? '' : a);
  var right = String(b == null ? '' : b);
  var max = Math.max(left.length, right.length, 1);
  var diff = left.length ^ right.length;
  var i, lc, rc;
  for (i = 0; i < max; i++) {
    lc = i < left.length ? left.charCodeAt(i) : 0;
    rc = i < right.length ? right.charCodeAt(i) : 0;
    diff |= lc ^ rc;
  }
  return diff === 0;
}

function sanitizeClientToken_(token) {
  var t = String(token || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return t.length >= 8 ? t : 'anon';
}

function checkStaffAuth_(data, opts) {
  opts = opts || {};
  var pin = opts.pin != null ? String(opts.pin) : getStaffPin_();
  var cache = opts.cache || getScriptCacheSafe_();
  var token = sanitizeClientToken_(data && data.clientToken);
  var key = 'staff-fail:' + token;
  var failCount = 0;
  try {
    failCount = Number((cache && cache.get(key)) || 0) || 0;
  } catch (err) {
    failCount = 0;
  }
  if (failCount >= STAFF_FAIL_LIMIT) {
    return { ok: false, status: 'locked', error: 'Too many attempts. Try again in a few minutes.' };
  }
  if (!pin) {
    return {
      ok: false,
      status: 'pin_unset',
      error: 'Staff PIN is not set. Ask an organiser to use Cake Sale → Set staff PIN…'
    };
  }
  var given = String((data && (data.pin != null ? data.pin : data.staffPin)) || '');
  if (!pinsEqual_(given, pin)) {
    failCount += 1;
    try {
      if (cache) cache.put(key, String(failCount), STAFF_FAIL_WINDOW_SEC);
    } catch (err) {}
    if (failCount >= STAFF_FAIL_LIMIT) {
      return { ok: false, status: 'locked', error: 'Too many attempts. Try again in a few minutes.' };
    }
    return {
      ok: false,
      status: 'unauthorized',
      error: 'Wrong PIN.',
      attemptsLeft: STAFF_FAIL_LIMIT - failCount
    };
  }
  try {
    if (cache) cache.remove(key);
  } catch (err) {}
  return { ok: true, status: 'ok' };
}

function handleStaffAction_(data) {
  var auth = checkStaffAuth_(data);
  if (!auth.ok) return auth;
  var action = String(data && data.action || '');
  if (action === 'staff_login') {
    return { ok: true, status: 'ok', version: SCRIPT_VERSION };
  }
  if (action === 'staff_orders') return staffListOrders_(data);
  if (action === 'staff_set_status') return staffSetStatus_(data);
  if (action === 'staff_add_walkin') return staffAddWalkIn_(data);
  if (action === 'staff_walkins') return staffListWalkIns_(data);
  if (action === 'staff_delete_walkin') return staffDeleteWalkIn_(data);
  return { ok: false, error: 'Unknown staff action' };
}

function headerIndexMap_(headers) {
  var col = {};
  var i;
  for (i = 0; i < (headers || []).length; i++) {
    col[String(headers[i])] = i;
  }
  return col;
}

function nextUpcomingPickupDateId_(dates, now) {
  var i, d, t, upcoming = [];
  now = now instanceof Date ? now : new Date();
  var nowMs = now.getTime();
  for (i = 0; i < (dates || []).length; i++) {
    d = dates[i];
    if (!d || !d.id) continue;
    t = d.closesAt ? Date.parse(d.closesAt) : NaN;
    if (!isNaN(t) && t >= nowMs) upcoming.push({ id: d.id, t: t });
  }
  if (!upcoming.length && dates && dates.length) return dates[dates.length - 1].id;
  upcoming.sort(function (a, b) { return a.t - b.t; });
  return upcoming.length ? upcoming[0].id : '';
}

function itemsSummaryFromQtyRow_(row, col, headers) {
  var i, name, qty, bits = [];
  for (i = 0; i < (headers || []).length; i++) {
    name = headers[i];
    if (BASE_HEADERS.indexOf(name) !== -1 || LEGACY_HEADERS.indexOf(name) !== -1) continue;
    qty = Number(row[i] || 0) || 0;
    if (qty > 0) bits.push(qty + ' × ' + name);
  }
  return bits.join(', ');
}

function staffOrdersFromValues_(values, opts) {
  opts = opts || {};
  var headers = (values && values[0] ? values[0] : []).map(function (h) { return String(h); });
  var col = headerIndexMap_(headers);
  var dates = opts.dates || [];
  var now = opts.now || new Date();
  var requested = normalizePickupDateId_(opts.pickupDate || opts.date || '');
  var pickupDate = requested || nextUpcomingPickupDateId_(dates, now);
  var q = String(opts.q || '').trim().toLowerCase();
  var qDigits = q.replace(/\D/g, '');
  var includeTest = !!opts.includeTest;
  var list = [];
  var r, row, name, phone, orderId, status, dateId, items, total, stamp, d;
  var toCollect = 0, toCollectAmount = 0, pickedUp = 0, pending = 0;

  function cell(row, name) {
    return typeof col[name] === 'number' ? row[col[name]] : '';
  }

  for (r = 1; r < (values || []).length; r++) {
    row = values[r] || [];
    name = String(cell(row, 'Name') || '').trim();
    if (!includeTest && /TEST ORDER/i.test(name)) continue;
    dateId = normalizePickupDateId_(cell(row, 'Pickup Date'));
    if (!dateId) {
      d = findStockDate_(cell(row, 'Pickup Date'), dates);
      dateId = d ? d.id : '';
    }
    if (pickupDate && dateId !== pickupDate) continue;
    orderId = String(cell(row, 'Order ID') || '').trim();
    phone = String(cell(row, 'Phone') || '').trim();
    status = normalizeOrderStatus_(cell(row, 'Status'));
    items = String(cell(row, 'Items') || '').trim();
    if (!items) items = itemsSummaryFromQtyRow_(row, col, headers);
    total = Number(cell(row, 'Total Amount (₹)') || cell(row, 'Total') || 0) || 0;
    stamp = formatSummaryTime_(cell(row, 'Timestamp')) || String(cell(row, 'Timestamp') || '');

    if (q) {
      var hayName = name.toLowerCase();
      var hayId = orderId.toLowerCase();
      var phoneDigits = String(phone).replace(/\D/g, '');
      var match = hayName.indexOf(q) !== -1 || hayId.indexOf(q) !== -1;
      var qIsNumeric = qDigits.length > 0 && q.replace(/[\s\-()+]/g, '') === qDigits;
      if (!match && qIsNumeric && phoneDigits.slice(-qDigits.length) === qDigits) match = true;
      if (!match) continue;
    }

    if (isPickedUpStatus_(status)) {
      pickedUp += 1;
    } else if (!isCancelledStatus_(status)) {
      pending += 1;
      if (!isPaidStatus_(status)) {
        toCollect += 1;
        toCollectAmount += total;
      }
    }

    list.push({
      row: r + 1,
      orderId: orderId,
      name: name,
      phone: phone,
      pickupDate: dateId,
      items: items,
      total: total,
      status: status,
      timestamp: stamp,
      statusUpdated: formatSummaryTime_(cell(row, 'Status Updated')) || ''
    });
  }

  return {
    ok: true,
    pickupDate: pickupDate,
    q: opts.q || '',
    orders: list,
    counts: {
      toCollect: toCollect,
      toCollectAmount: toCollectAmount,
      pickedUp: pickedUp,
      pending: pending,
      total: list.length
    },
    dates: (dates || []).map(function (d) {
      return { id: d.id, label: d.label, display: d.display || d.label, closesAt: d.closesAt || '' };
    }),
    version: SCRIPT_VERSION
  };
}

function staffListOrders_(data) {
  var ss = getSpreadsheet_();
  var orders = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
  var lastRow = orders.getLastRow();
  var lastCol = orders.getLastColumn();
  var values = lastRow >= 1 && lastCol >= 1
    ? orders.getRange(1, 1, lastRow, lastCol).getValues()
    : [['Timestamp']];
  return staffOrdersFromValues_(values, {
    pickupDate: data && (data.pickupDate || data.date) || '',
    q: data && (data.q || data.search) || '',
    includeTest: !!(data && data.includeTest),
    dates: getPickupDatesCached_(ss),
    now: new Date()
  });
}

function findOrderRowById_(sheet, headers, orderId) {
  var col = headers.indexOf('Order ID');
  var wanted = String(orderId || '').trim();
  if (col < 0 || !wanted) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  try {
    var found = sheet.getRange(2, col + 1, last - 1, 1)
      .createTextFinder(wanted)
      .matchEntireCell(true)
      .matchCase(true)
      .findNext();
    if (found && found.getRow) return found.getRow();
  } catch (err) {}
  var vals = sheet.getRange(2, col + 1, last - 1, 1).getValues();
  var i;
  for (i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() === wanted) return i + 2;
  }
  return 0;
}

function ensureStatusUpdatedColumn_(sheet, headers) {
  headers = headers || getHeaders_(sheet);
  if (headers.indexOf('Status Updated') >= 0) return getHeaders_(sheet);
  var statusIdx = headers.indexOf('Status');
  try {
    if (statusIdx >= 0 && sheet.insertColumnAfter) {
      sheet.insertColumnAfter(statusIdx + 1);
      sheet.getRange(1, statusIdx + 2).setValue('Status Updated');
    } else {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue('Status Updated');
    }
  } catch (err) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('Status Updated');
  }
  return getHeaders_(sheet);
}

function staffSetStatus_(data) {
  var orderId = String(data && data.orderId || '').trim();
  var nextStatus = normalizeOrderStatus_(data && data.status);
  var expectedRaw = data && data.expectedStatus;
  var expected = expectedRaw != null && String(expectedRaw) !== ''
    ? normalizeOrderStatus_(expectedRaw)
    : '';
  if (!orderId) return { ok: false, error: 'Missing orderId' };
  // OVERSOLD is set by the system when an order is saved over stock. Staff
  // move an order out of it (expectedStatus may be OVERSOLD), never into it.
  if (ORDER_STATUS_VALUES.indexOf(nextStatus) === -1 || nextStatus === 'OVERSOLD') {
    return { ok: false, error: 'Invalid status' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = getSpreadsheet_();
    var sheet = getOrCreateSheet_(ss, ORDERS_SHEET_NAME);
    var headers = getHeaders_(sheet);
    if (headers.indexOf('Order ID') < 0 || headers.indexOf('Status') < 0) {
      return { ok: false, error: 'Orders sheet is missing required columns' };
    }
    headers = ensureStatusUpdatedColumn_(sheet, headers);
    var statusCol = headers.indexOf('Status');
    var updatedCol = headers.indexOf('Status Updated');
    var row = findOrderRowById_(sheet, headers, orderId);
    if (!row) return { ok: false, error: 'Order not found', status: 'not_found' };
    var current = normalizeOrderStatus_(sheet.getRange(row, statusCol + 1).getValue());
    if (expected && current !== expected) {
      return {
        ok: false,
        status: 'conflict',
        error: 'Status changed',
        currentStatus: current,
        orderId: orderId,
        row: row
      };
    }
    sheet.getRange(row, statusCol + 1).setValue(nextStatus);
    if (updatedCol >= 0) {
      var now = new Date();
      var stamp = formatSummaryTime_(now);
      if (!stamp) {
        try {
          stamp = Utilities.formatDate(now, TZ, 'dd MMM yyyy, HH:mm');
        } catch (err) {
          stamp = now.toISOString();
        }
      }
      sheet.getRange(row, updatedCol + 1).setValue(stamp);
    }
    invalidateSummaryCache_();
    invalidateStockCache_(); // Cancelled frees stock; un-cancelling takes it again
    return {
      ok: true,
      status: nextStatus,
      orderId: orderId,
      row: row,
      previousStatus: current
    };
  } finally {
    lock.releaseLock();
  }
}

function ensureWalkInExtraColumns_(tab) {
  var headers = getHeaders_(tab);
  var extras = ['Walk-in ID', 'Void', 'Customer', 'Recorded At'];
  var hadVoidHeader = headers.indexOf('Void') !== -1;
  var i, name;
  for (i = 0; i < extras.length; i++) {
    name = extras[i];
    if (headers.indexOf(name) === -1) {
      tab.getRange(1, headers.length + 1).setValue(name);
      headers.push(name);
    }
  }
  var idCol = headers.indexOf('Walk-in ID');
  var voidCol = headers.indexOf('Void');
  var voidWasMissing = !hadVoidHeader;
  try {
    // ISO timestamps must stay text so Sheets never converts/mangles them.
    var recCol = headers.indexOf('Recorded At');
    if (recCol >= 0 && tab.getMaxRows) {
      tab.getRange(2, recCol + 1, Math.max(tab.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    }
  } catch (err0) {}
  try {
    if (idCol >= 0 && tab.hideColumns) tab.hideColumns(idCol + 1);
  } catch (err) {}
  try {
    // The Void column is visible so undone sales are obvious; unhide it if an
    // older version hid it.
    if (voidCol >= 0) {
      var voidHidden = tab.isColumnHiddenByUser ? !!tab.isColumnHiddenByUser(voidCol + 1) : false;
      if (voidHidden && tab.showColumns) tab.showColumns(voidCol + 1);
      if ((voidHidden || voidWasMissing) && tab.setColumnWidth) tab.setColumnWidth(voidCol + 1, 70);
    }
  } catch (err2) {}
}

var VOID_ROW_FONT_COLOR = '#9aa0a6';
var VOID_ROW_BACKGROUND = '#f1f3f4';

/** Grey + strikethrough one walk-in row. Never throws: a formatting failure must not fail an undo. */
function styleVoidedWalkInRow_(tab, row, lastCol) {
  try {
    var range = tab.getRange(row, 1, 1, Math.max(lastCol || 1, 1));
    range.setFontColor(VOID_ROW_FONT_COLOR);
    range.setBackground(VOID_ROW_BACKGROUND);
    range.setFontLine('line-through');
  } catch (err) {}
}

/** setupSheets only: restyle rows that were undone before the visible marker existed. */
function restyleVoidedWalkIns_(tab) {
  try {
    if (!tab) return 0;
    var headers = getHeaders_(tab);
    var lastRow = tab.getLastRow();
    if (!headers.length || lastRow < 2) return 0;
    var voidIdx = headers.indexOf('Void');
    var notesIdx = headers.indexOf('Notes');
    var values = tab.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var count = 0;
    var r, row;
    for (r = 0; r < values.length; r++) {
      row = values[r] || [];
      if (isVoidWalkIn_(voidIdx >= 0 ? row[voidIdx] : '', notesIdx >= 0 ? row[notesIdx] : '')) {
        styleVoidedWalkInRow_(tab, r + 2, headers.length);
        count++;
      }
    }
    return count;
  } catch (err) {
    return 0;
  }
}

function nextWalkInDataRow_(sheet, headers) {
  headers = headers || getHeaders_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return 2;
  var dateIdx = headers.indexOf('Date');
  var itemIdx = headers.indexOf('Item');
  var idIdx = headers.indexOf('Walk-in ID');
  var values = sheet.getRange(2, 1, last - 1, Math.max(headers.length, 1)).getValues();
  var r, used = 1, row, hasInput;
  for (r = 0; r < values.length; r++) {
    row = values[r] || [];
    hasInput = false;
    if (dateIdx >= 0 && row[dateIdx] !== '' && row[dateIdx] != null) hasInput = true;
    if (itemIdx >= 0 && String(row[itemIdx] || '').trim()) hasInput = true;
    if (idIdx >= 0 && String(row[idIdx] || '').trim()) hasInput = true;
    if (hasInput) used = r + 2;
  }
  return used + 1;
}

function findWalkInRowById_(sheet, headers, walkinId) {
  var col = headers.indexOf('Walk-in ID');
  var wanted = String(walkinId || '').trim();
  if (!wanted) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  if (col >= 0) {
    try {
      var found = sheet.getRange(2, col + 1, last - 1, 1)
        .createTextFinder(wanted)
        .matchEntireCell(true)
        .matchCase(true)
        .findNext();
      if (found && found.getRow) return found.getRow();
    } catch (err) {}
    var vals = sheet.getRange(2, col + 1, last - 1, 1).getValues();
    var i;
    for (i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === wanted) return i + 2;
    }
  }
  return 0;
}

function getWalkInCell_(sheet, headers, row, name) {
  var col = headers.indexOf(name);
  if (col < 0) return '';
  return sheet.getRange(row, col + 1).getValue();
}

function staffWalkInsFromValues_(values, opts) {
  opts = opts || {};
  var headers = (values && values[0] ? values[0] : []).map(function (h) { return String(h); });
  var col = headerIndexMap_(headers);
  var dates = opts.dates || [];
  var requested = normalizePickupDateId_(opts.date || opts.pickupDate || '');
  var dateId = requested || nextUpcomingPickupDateId_(dates, opts.now || new Date());
  var includeVoid = !!opts.includeVoid;
  var list = [];
  var r, row, date, item, qty, amount, price, payment, notes, walkinId, voided, d;

  function wcell(row, name) {
    return typeof col[name] === 'number' ? row[col[name]] : '';
  }

  for (r = 1; r < (values || []).length; r++) {
    row = values[r] || [];
    date = normalizePickupDateId_(wcell(row, 'Date'));
    if (!date) {
      d = findStockDate_(wcell(row, 'Date'), dates);
      date = d ? d.id : '';
    }
    if (dateId && date !== dateId) continue;
    voided = isVoidWalkIn_(wcell(row, 'Void'), wcell(row, 'Notes'));
    if (voided && !includeVoid) continue;
    item = String(wcell(row, 'Item') || '').trim();
    qty = Number(wcell(row, 'Qty') || 0) || 0;
    walkinId = String(wcell(row, 'Walk-in ID') || '').trim();
    if (!item && !qty && !walkinId) continue;
    price = Number(wcell(row, 'Price each') || 0) || Number(MENU_ITEM_PRICES[item] || 0) || 0;
    amount = Number(wcell(row, 'Amount') || 0) || (qty * price);
    payment = normalizePayment_(wcell(row, 'Payment'));
    notes = String(wcell(row, 'Notes') || '').trim();
    var customer = String(wcell(row, 'Customer') || '').trim();
    var recordedAt = recordedAtCellToString_(wcell(row, 'Recorded At'));
    list.push({
      row: r + 1,
      walkinId: walkinId,
      date: date,
      item: item,
      qty: qty,
      price: price,
      amount: amount,
      payment: payment,
      notes: notes,
      customer: customer,
      recordedAt: recordedAt,
      voided: voided
    });
  }
  return { ok: true, date: dateId, walkins: list, version: SCRIPT_VERSION };
}

var RECORDED_AT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
var RECORDED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Client-supplied sale time (offline-queued sales keep their real time).
 * Returns an ISO 8601 string. Anything that is not a real date within the
 * last 14 days (and at most 5 minutes in the future) falls back to now.
 */
function normalizeRecordedAt_(value, nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : new Date().getTime();
  var ms = NaN;
  if (typeof value === 'string' && value.trim() && value.length <= 40) {
    ms = new Date(value.trim()).getTime();
  }
  if (isNaN(ms) || ms < now - RECORDED_AT_MAX_AGE_MS || ms > now + RECORDED_AT_MAX_FUTURE_MS) {
    ms = now;
  }
  return new Date(ms).toISOString();
}

function recordedAtCellToString_(cell) {
  if (cell === null || typeof cell === 'undefined' || cell === '') return '';
  if (Object.prototype.toString.call(cell) === '[object Date]') {
    return isNaN(cell.getTime()) ? '' : cell.toISOString();
  }
  return String(cell).trim();
}

function staffListWalkIns_(data) {
  var ss = getSpreadsheet_();
  var tab = ensureWalkInSalesSheet_(ss);
  var lastRow = tab.getLastRow();
  var lastCol = tab.getLastColumn();
  var values = lastRow >= 1 && lastCol >= 1
    ? tab.getRange(1, 1, lastRow, lastCol).getValues()
    : [WALKIN_HEADERS.slice()];
  return staffWalkInsFromValues_(values, {
    date: data && (data.date || data.pickupDate) || '',
    includeVoid: !!(data && data.includeVoid),
    dates: getPickupDatesCached_(ss),
    now: new Date()
  });
}

function staffAddWalkIn_(data) {
  var walkinId = String(data && (data.walkinId || data.id) || '').trim();
  var dateId = normalizePickupDateId_(data && (data.date || data.pickupDate));
  var item = String(data && data.item || '').trim();
  var qty = Math.max(0, Math.floor(Number(data && data.qty) || 0));
  var payment = normalizePayment_(data && data.payment);
  var notes = String(data && data.notes || '').trim();
  var customer = String(data && data.customer || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!walkinId) return { ok: false, error: 'Missing walkinId' };
  if (!dateId) return { ok: false, error: 'Missing date' };
  if (!item) return { ok: false, error: 'Missing item' };
  if (!qty) return { ok: false, error: 'Invalid quantity' };
  if (MENU_ITEM_COLUMNS.indexOf(item) === -1) return { ok: false, error: 'Unknown item' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = getSpreadsheet_();
    var tab = ensureWalkInSalesSheet_(ss);
    var headers = getHeaders_(tab);
    var existing = findWalkInRowById_(tab, headers, walkinId);
    if (existing) {
      var voided = isVoidWalkIn_(
        getWalkInCell_(tab, headers, existing, 'Void'),
        getWalkInCell_(tab, headers, existing, 'Notes')
      );
      return {
        ok: true,
        duplicate: true,
        walkinId: walkinId,
        row: existing,
        voided: voided
      };
    }
    var nextRow = nextWalkInDataRow_(tab, headers);
    var dateCol = headers.indexOf('Date');
    var itemCol = headers.indexOf('Item');
    var qtyCol = headers.indexOf('Qty');
    var payCol = headers.indexOf('Payment');
    var notesCol = headers.indexOf('Notes');
    var idCol = headers.indexOf('Walk-in ID');
    var voidCol = headers.indexOf('Void');
    var customerCol = headers.indexOf('Customer');
    var recordedAtCol = headers.indexOf('Recorded At');
    var recordedAt = normalizeRecordedAt_(data && data.recordedAt);
    if (recordedAtCol >= 0) tab.getRange(nextRow, recordedAtCol + 1).setNumberFormat('@').setValue(recordedAt);
    if (customerCol >= 0 && customer) tab.getRange(nextRow, customerCol + 1).setNumberFormat('@').setValue(customer);
    if (dateCol >= 0) tab.getRange(nextRow, dateCol + 1).setValue(dateId);
    if (itemCol >= 0) tab.getRange(nextRow, itemCol + 1).setValue(item);
    if (qtyCol >= 0) tab.getRange(nextRow, qtyCol + 1).setValue(qty);
    if (payCol >= 0) tab.getRange(nextRow, payCol + 1).setValue(payment || 'Cash');
    if (notesCol >= 0 && notes) tab.getRange(nextRow, notesCol + 1).setValue(notes);
    if (idCol >= 0) tab.getRange(nextRow, idCol + 1).setValue(walkinId);
    if (voidCol >= 0) tab.getRange(nextRow, voidCol + 1).setValue('');
    var price = Number(MENU_ITEM_PRICES[item] || 0) || 0;
    invalidateSummaryCache_();
    invalidateStockCache_(); // a walk-in sale uses up the batch
    return {
      ok: true,
      walkinId: walkinId,
      row: nextRow,
      item: item,
      qty: qty,
      price: price,
      amount: qty * price,
      payment: payment || 'Cash',
      date: dateId,
      recordedAt: recordedAt
    };
  } finally {
    lock.releaseLock();
  }
}

function staffDeleteWalkIn_(data) {
  var walkinId = String(data && (data.walkinId || data.id) || '').trim();
  if (!walkinId) return { ok: false, error: 'Missing walkinId' };
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = getSpreadsheet_();
    var tab = ensureWalkInSalesSheet_(ss);
    var headers = getHeaders_(tab);
    var row = findWalkInRowById_(tab, headers, walkinId);
    if (!row) return { ok: false, error: 'Walk-in not found', status: 'not_found' };
    var voidCol = headers.indexOf('Void');
    var notesCol = headers.indexOf('Notes');
    if (voidCol >= 0) {
      tab.getRange(row, voidCol + 1).setValue('VOID');
    } else if (notesCol >= 0) {
      var existingNotes = String(tab.getRange(row, notesCol + 1).getValue() || '');
      if (!/^\s*VOID\b/i.test(existingNotes)) {
        tab.getRange(row, notesCol + 1).setValue(existingNotes ? ('VOID ' + existingNotes) : 'VOID');
      }
    }
    styleVoidedWalkInRow_(tab, row, headers.length); // visible grey + strikethrough, best effort
    invalidateSummaryCache_();
    invalidateStockCache_(); // a voided walk-in gives the stock back
    return { ok: true, walkinId: walkinId, row: row, voided: true };
  } finally {
    lock.releaseLock();
  }
}

function remindStaffPinIfMissing_() {
  if (getStaffPin_()) return;
  try {
    SpreadsheetApp.getUi().alert(
      'Staff PIN is not set',
      'Open Cake Sale → Set staff PIN… before using the staff phone page. Until a PIN is set, staff login is refused.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (err) {}
}

function promptSetStaffPin() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    'Set staff PIN',
    'Enter a staff PIN (at least 4 digits). Organisers will enter this on the staff phone page.',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;
  var pin = String(result.getResponseText() || '').trim();
  if (!/^\d{4,}$/.test(pin)) {
    ui.alert('The PIN must be at least 4 digits (numbers only).');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(STAFF_PIN_PROPERTY, pin);
  ui.alert('Staff PIN saved. Share it only with organisers who will mark payments and walk-in sales.');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpOrJson_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(callback))) {
    return ContentService
      .createTextOutput(callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}
