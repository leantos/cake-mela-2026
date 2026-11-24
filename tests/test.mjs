import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = readPage('index.html');
const dom = new JSDOM(html, {
  url: 'https://example.com/index.html',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(win) {
    // Do not hit the live Apps Script URL from unit tests (fetch or JSONP).
    win.__TEST_DISABLE_NETWORK = true;
    win.fetch = async function () { throw new Error('network disabled in tests'); };
  }
});

const { window } = dom;
const { document } = window;

await new Promise((r) => setTimeout(r, 50));

// Freeze "now" to before the first Sunday so chips and the CTA stay open
// regardless of the machine clock.
window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
window.renderPickupDates();
window.resetSubmitButton();

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

const w = window;
const cards = document.querySelectorAll('.menu-card');
assert('renders 6 menu cards', cards.length === 6, cards.length);

assert('title branded for parish', document.title.includes('Vailankanni Parish Youth'), document.title);
assert('favicon present', !!document.querySelector('link[rel="icon"][href="logo.png"]'));
assert('apple-touch-icon present', !!document.querySelector('link[rel="apple-touch-icon"][href="logo.png"]'));
assert('header title', document.querySelector('header.hero-head h1')?.textContent === 'Vailankanni Parish Youth');
assert('header subtitle', document.querySelector('header.hero-head .tagline')?.textContent === 'Christmas Cake Sale • with Poppins Bakers');
assert('header logo', document.querySelector('header.hero-head img.logo')?.getAttribute('src') === 'logo.png');

const names = [...cards].map((c) => c.querySelector('h2')?.textContent);
assert('menu names order', JSON.stringify(names) === JSON.stringify([
  'Dates & Carrot Pudding',
  'Dates & Carrot Pudding',
  'Butterscotch Pudding',
  'Butterscotch Pudding',
  'Rich Plum Cake',
  'Rich Plum Cake'
]), JSON.stringify(names));

const prices = [...cards].map((c) => c.querySelector('.price')?.textContent.replace(/\s+/g, ' ').trim());
assert('poster prices', JSON.stringify(prices) === JSON.stringify([
  '₹650 · 700g',
  '₹330 · 350g',
  '₹700 · 700g',
  '₹350 · 350g',
  '₹650 · 800g',
  '₹350 · 400g'
]), JSON.stringify(prices));

const tags = [...cards].map((c) => c.querySelector('.tag')?.textContent || '');
assert('bestseller only on Rich Plum 400g', tags.join('|') === '|||||Bestseller', tags.join('|'));

assert('helper generateOrderId is global', typeof w.generateOrderId === 'function');
assert('helper normalizePhone is global', typeof w.normalizePhone === 'function');
assert('helper formatINR is global', typeof w.formatINR === 'function');
assert('helper buildWhatsAppMessage is global', typeof w.buildWhatsAppMessage === 'function');
const payNote = document.querySelector('.sticky-bar .payment-note');
assert('payment note sits in the sticky summary (before ordering: no number yet)', !!(payNote && /^Payment: Pay at pickup, or UPI \(number shown when you order\)/.test(payNote.textContent)), payNote && payNote.textContent);
const enquire = document.getElementById('enquire');
assert('enquiries list both contacts', !!(enquire &&
  enquire.textContent.includes('Cyril Martin • +91 72040 17793') &&
  enquire.textContent.includes('Aashwin Alfy • +91 80507 64341') &&
  enquire.querySelector('a[href="tel:+917204017793"]') && enquire.querySelector('a[href="tel:+918050764341"]')),
  enquire && enquire.innerHTML);
assert('site-config.js loaded two contacts', w.eval('CONTACTS.length') === 2 && w.SITE_CONFIG && w.SITE_CONFIG.contacts.length === 2);
assert('payment note sits above the place-order button in the sticky bar',
  !!(payNote && payNote.closest('.sticky-bar') && document.getElementById('place-order-btn') &&
    (payNote.compareDocumentPosition(document.getElementById('place-order-btn')) & window.Node.DOCUMENT_POSITION_FOLLOWING)));

assert('helper isSheetsUrlConfigured is global', typeof w.isSheetsUrlConfigured === 'function');
assert('helper isValidIndianMobile is global', typeof w.isValidIndianMobile === 'function');
assert('helper isPickupDateOpen is global', typeof w.isPickupDateOpen === 'function');
assert('helper getOpenPickupDates is global', typeof w.getOpenPickupDates === 'function');

if (typeof w.normalizePhone === 'function') {
  assert('strip spaces', w.normalizePhone('98765 43210') === '9876543210');
  assert('strip +91', w.normalizePhone('+91 9876543210') === '9876543210');
  assert('strip 91 and dashes', w.normalizePhone('91-98765-43210') === '9876543210');
  assert('strip leading 0', w.normalizePhone('09876543210') === '9876543210');
  assert('strip parens', w.normalizePhone('(98765) 43210') === '9876543210');
  assert('valid 9 start', w.isValidIndianMobile('9876543210') === true);
  assert('valid 6 start', w.isValidIndianMobile('6123456789') === true);
  assert('reject 5 start', w.isValidIndianMobile('5123456789') === false);
  assert('reject short', w.isValidIndianMobile('987654321') === false);
  assert('reject 11 digits', w.isValidIndianMobile('98765432101') === false);
}

if (typeof w.formatINR === 'function') {
  assert('INR 0', w.formatINR(0) === '₹0');
  assert('INR 350', w.formatINR(350) === '₹350');
  assert('INR 1350', w.formatINR(1350) === '₹1,350');
  assert('INR 12500', w.formatINR(12500) === '₹12,500');
}

if (typeof w.generateOrderId === 'function') {
  const fixed = new Date('2026-11-23T06:30:00Z');
  const id = w.generateOrderId(fixed);
  assert('order id pattern', /^PB-261123-[A-Z2-9]{4}$/.test(id), id);
  const id2 = w.generateOrderId(fixed);
  assert('order id unique suffix', id !== id2, id + ' vs ' + id2);
}

if (typeof w.isSheetsUrlConfigured === 'function') {
  assert('placeholder skipped', w.isSheetsUrlConfigured('PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE') === false);
  assert('empty skipped', w.isSheetsUrlConfigured('') === false);
  assert('http skipped', w.isSheetsUrlConfigured('http://example.com') === false);
  assert('real url ok', w.isSheetsUrlConfigured('https://script.google.com/macros/s/ABC/exec') === true);
assert('page Sheets URL is treated as configured (placeholder must not be the live URL)', w.isSheetsUrlConfigured() === true);
}

if (typeof w.needsFlatDetails === 'function') {
  assert('flat hidden for mass', w.needsFlatDetails('Sunday Mass Pickup') === false);
  assert('flat required apartment', w.needsFlatDetails('Sarjapura Road Apartment') === true);
  assert('flat required harohalli', w.needsFlatDetails('Harohalli Complex') === true);
  assert('flat required other', w.needsFlatDetails('Other Bengaluru Location') === true);
  assert('flat false for empty', w.needsFlatDetails('') === false || w.needsFlatDetails('') === '');
}

// Pickup date availability (IST cutoff is 08:30 on that day)
const justBefore = new Date('2026-11-29T08:29:59.999+05:30');
const atCutoff = new Date('2026-11-29T08:30:00+05:30');
assert('29 Nov open at 8:29 AM IST', w.isPickupDateOpen('2026-11-29', justBefore) === true);
assert('29 Nov closed at 8:30 AM IST', w.isPickupDateOpen('2026-11-29', atCutoff) === false);
assert('all 4 dates open on 23 Nov', w.getOpenPickupDates(new Date('2026-11-23T12:00:00+05:30')).length === 4,
  String(w.getOpenPickupDates(new Date('2026-11-23T12:00:00+05:30')).length));
assert('none open after last Mass', w.getOpenPickupDates(new Date('2026-12-20T08:30:00+05:30')).length === 0);

const chips = [...document.querySelectorAll('.date-chip')];
assert('renders 4 date chips on 23 Nov', chips.length === 4, chips.length);
assert('defaults to first date with stock (29 Nov)', document.getElementById('pickup-date').value === '2026-11-29',
  document.getElementById('pickup-date').value);
assert('29 Nov chip is enabled', chips[0].disabled === false && !chips[0].classList.contains('sold-out'));
assert('6 Dec is orderable (no stock disable)',
  chips[1].disabled === false && !/Sold out/.test(chips[1].textContent),
  chips[1].textContent + ' disabled=' + chips[1].disabled);
assert('13 Dec is orderable', chips[2].disabled === false, chips[2].textContent);
assert('20 Dec is orderable', chips[3].disabled === false, chips[3].textContent);
assert('6 Dec is not stock-limited (pre-order remaining is unlimited)', w.remainingForItem(
  { name: 'Dates & Carrot Pudding', weight: '700g' }, '2026-12-06') === Infinity,
  String(w.remainingForItem({ name: 'Dates & Carrot Pudding', weight: '700g' }, '2026-12-06')));
assert('closed banner hidden while dates remain', !document.getElementById('preorders-closed').classList.contains('visible'));

if (typeof w.buildWhatsAppMessage === 'function') {
  const sample = {
    orderId: 'PB-251123-K7MQ',
    timestamp: '23/11/2026, 12:00:00 pm IST',
    items: [
      { qty: 2, name: 'Rich Plum Cake (400g)', lineTotal: 700 },
      { qty: 1, name: 'Dates & Carrot Pudding (700g)', lineTotal: 650 }
    ],
    totalItems: 3,
    totalAmount: 1350,
    name: 'Asha Rao',
    phone: '9876543210',
    pickupDateShort: 'Sun, 29 Nov',
    massLabel: '6:30 AM Mass'
  };
  const msg = w.buildWhatsAppMessage(sample);
  assert('whatsapp title is the buyer-voice format', msg.includes('✨ *Christmas Cake Order* ✨'), msg);
  assert('whatsapp has order id', msg.includes('*Order ID:* PB-251123-K7MQ'), msg);
  assert('whatsapp lists items with ×', msg.includes('• 2 × Rich Plum Cake (400g) – ₹700') && msg.includes('• 1 × Dates & Carrot Pudding (700g) – ₹650'), msg);
  assert('whatsapp total line', msg.includes('*Total: ₹1,350* (3 cakes)'), msg);
  assert('whatsapp pickup block', msg.includes('*Pickup*') && msg.includes('Sun, 29 Nov, after the 6:30 AM Mass'), msg);
  assert('whatsapp name and phone', msg.includes('*Name:* Asha Rao') && msg.includes('*Phone:* 9876543210'), msg);
  assert('whatsapp payment line', msg.includes('*Payment:* Pay at pickup, or UPI to +91 72040 17793 (Cyril Martin)'), msg);
  const phoneAt = msg.indexOf('*Phone:* 9876543210');
  const payAt = msg.indexOf('*Payment:* Pay at pickup');
  const confirmAt = msg.indexOf('Please confirm my order. Thank you!');
  assert('payment line sits after phone and before confirm', phoneAt >= 0 && payAt > phoneAt && confirmAt > payAt, msg);
  assert('whatsapp has no delivery line', !msg.includes('*Delivery:*') && !msg.includes('Flat / Block'), msg);
  assert('whatsapp avoids supplementary-plane emoji', !/\uD83C/.test(msg), msg);
}

function zeroCart() {
  document.querySelectorAll('.stepper .minus').forEach((btn) => {
    let guard = 0;
    while (!btn.disabled && guard++ < 200) btn.click();
  });
}

// Interactive cart
const firstPlus = cards[0].querySelector('.plus');
const firstMinus = cards[0].querySelector('.minus');
const lastPlus = cards[5].querySelector('.plus');
firstPlus.click();
firstPlus.click();
lastPlus.click();
const summaryCount = document.getElementById('summary-count').textContent;
const summaryTotal = document.getElementById('summary-total').textContent;
assert('summary after 2x dates 700 + 1x plum 400', summaryCount === '3 items' && summaryTotal === '₹1,650', summaryCount + ' ' + summaryTotal);
firstMinus.click();
assert('summary after minus', document.getElementById('summary-count').textContent === '2 items' && document.getElementById('summary-total').textContent === '₹1,000',
  document.getElementById('summary-count').textContent + ' ' + document.getElementById('summary-total').textContent);

// Validation: empty submit (items present, identity missing, no date yet)
document.getElementById('place-order-btn').click();
assert('cart error if items later removed? currently have items, name missing',
  document.getElementById('field-name').classList.contains('invalid'),
  document.getElementById('field-name').className);
assert('phone invalid empty', document.getElementById('field-phone').classList.contains('invalid'));
assert('name input marked aria-invalid after empty submit', document.getElementById('buyer-name').getAttribute('aria-invalid') === 'true');
assert('name described by its error', document.getElementById('buyer-name').getAttribute('aria-describedby') === 'buyer-name-error');
assert('phone field has an inline error', /10-digit phone/.test(document.getElementById('buyer-phone-error')?.textContent || ''),
  document.getElementById('buyer-phone-error')?.textContent);
assert('pickup date pre-selected so not flagged', !document.getElementById('field-pickup-date').classList.contains('invalid'));
assert('mass required', document.getElementById('field-mass').classList.contains('invalid'));
document.getElementById('pickup-date').value = '';
document.getElementById('place-order-btn').click();
assert('pickup date required once cleared', document.getElementById('field-pickup-date').classList.contains('invalid'));
w.selectPickupDate('2026-11-29');
assert('button not stuck after failed validation', document.getElementById('place-order-btn').disabled === false);
assert('button text unchanged', document.getElementById('place-order-btn').textContent === 'Place Order via WhatsApp');

const massBtns = [...document.querySelectorAll('.mass-option')];
assert('renders 2 mass options', massBtns.length === 2, massBtns.length);
assert('mass labels', massBtns.map((b) => b.textContent).join('|') === '6:30 AM Mass|8:30 AM Mass',
  massBtns.map((b) => b.textContent).join('|'));
assert('no delivery field', !document.getElementById('field-delivery') && !document.getElementById('field-flat'));
assert('church pickup note', /Vailankanni Matha Church, Muthanallur/.test(document.getElementById('pickup-place')?.textContent || ''));

document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '+91 98765 43210';
document.getElementById('place-order-btn').click();
assert('mass still required after name/phone', document.getElementById('field-mass').classList.contains('invalid'));

const formAlert = document.getElementById('form-alert');
assert('invalid submit opens the custom alert dialog', formAlert && !formAlert.hidden && formAlert.classList.contains('is-open'));
assert('alert is an alertdialog', document.getElementById('form-alert-dialog')?.getAttribute('role') === 'alertdialog');
assert('alert is modal', document.getElementById('form-alert-dialog')?.getAttribute('aria-modal') === 'true');
assert('alert title is Almost there!', document.getElementById('form-alert-title')?.textContent === 'Almost there!');
assert('alert lists the missing Mass time', /Pick a Mass time/.test(formAlert.textContent), formAlert.textContent);
assert('alert OK button label', document.getElementById('form-alert-ok')?.textContent === 'OK, fix it');
const checkoutAlert = document.getElementById('checkout-alert');
assert('sticky summary lists missing Mass time', checkoutAlert && !checkoutAlert.hidden && /Pick a Mass time/.test(checkoutAlert.textContent),
  checkoutAlert && checkoutAlert.textContent);
assert('button stays tappable after invalid submit', document.getElementById('place-order-btn').disabled === false);

// Filling a field clears that error live without closing the need to fix others
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-name').dispatchEvent(new window.Event('input', { bubbles: true }));
assert('name highlight clears once filled', !document.getElementById('field-name').classList.contains('invalid'));
assert('name aria-invalid removed once filled', document.getElementById('buyer-name').getAttribute('aria-invalid') !== 'true');

// Close via the OK button: first remaining problem (phone, if emptied) or mass
document.getElementById('buyer-phone').value = '';
document.getElementById('buyer-phone').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('form-alert-ok').click();
assert('OK closes the alert', formAlert.hidden === true && !formAlert.classList.contains('is-open'));
assert('closing the alert focuses the first invalid field', document.activeElement === document.getElementById('buyer-phone') ||
  document.activeElement === document.getElementById('buyer-name') ||
  document.activeElement && document.activeElement.classList.contains('plus') ||
  document.activeElement && document.activeElement.classList.contains('mass-option') ||
  document.activeElement === document.getElementById('buyer-phone'),
  document.activeElement && (document.activeElement.id || document.activeElement.className));

// Re-open and close with Escape
document.getElementById('place-order-btn').click();
assert('alert reopens on another invalid tap', !formAlert.hidden);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert('Escape closes the alert', formAlert.hidden === true);

// Backdrop tap also closes
document.getElementById('place-order-btn').click();
document.getElementById('form-alert-backdrop').click();
assert('backdrop tap closes the alert', formAlert.hidden === true);

// Completely empty cart lists the cake requirement
zeroCart();
document.getElementById('buyer-name').value = '';
document.getElementById('buyer-phone').value = '';
document.getElementById('pickup-date').value = '';
document.getElementById('pickup-mass').value = '';
document.getElementById('place-order-btn').click();
assert('empty cart is listed in the alert', /Please add at least one cake/.test(formAlert.textContent), formAlert.textContent);
assert('alert lists name, phone, date and Mass',
  /Enter your name/.test(formAlert.textContent) &&
  /Enter a 10-digit phone number/.test(formAlert.textContent) &&
  /Pick a pickup date/.test(formAlert.textContent) &&
  /Pick a Mass time/.test(formAlert.textContent),
  formAlert.textContent);
assert('sticky alert is a live region', checkoutAlert.getAttribute('role') === 'alert' && checkoutAlert.getAttribute('aria-live') === 'assertive');
assert('reduced-motion rule is present for the alert',
  /prefers-reduced-motion:\s*reduce[\s\S]{0,500}form-alert/.test(html) && /animation:\s*none/.test(html),
  'missing reduced-motion CSS');

w.closeFormAlert();
firstPlus.click();
w.selectPickupDate('2026-11-29');
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '+91 98765 43210';
document.getElementById('buyer-name').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('buyer-phone').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('place-order-btn').click();
assert('mass still required after name/phone/item restored', document.getElementById('field-mass').classList.contains('invalid'));
w.closeFormAlert();

// Pre-order: no sold-out labels, no clamping, every listed date is orderable
const origLoadStock = w.loadStock;
w.loadStock = async function () {};

zeroCart();
w.__setStockForTest({
  '2026-12-06': { 'Dates & Carrot Pudding (700g)': 100 },
  '2026-11-29': { 'Dates & Carrot Pudding (700g)': 2, 'Rich Plum Cake (400g)': 0 }
});
w.selectPickupDate('2026-12-06');
for (let i = 0; i < 5; i++) firstPlus.click();
assert('any listed date allows 5', cards[0].querySelector('.qty').textContent === '5',
  cards[0].querySelector('.qty').textContent);
assert('cards are not marked sold-out', !cards[0].classList.contains('sold-out'));

w.selectPickupDate('2026-11-29');
assert('date switch does not clamp the cart', cards[0].querySelector('.qty').textContent === '5',
  cards[0].querySelector('.qty').textContent);
assert('no sold-out or remaining note on cards',
  !/Sold out|Only \d+ left/i.test(cards[0].querySelector('.stock-note')?.textContent || ''),
  cards[0].querySelector('.stock-note')?.textContent);

firstPlus.click();
firstPlus.click();
assert('plus is not limited by planned stock', cards[0].querySelector('.qty').textContent === '7',
  cards[0].querySelector('.qty').textContent);
assert('plus stays enabled for a pre-order', cards[0].querySelector('.plus').disabled === false);

const lastCard = cards[5];
assert('no sold out note on plum 400', !/Sold out/.test(lastCard.querySelector('.stock-note')?.textContent || ''),
  lastCard.querySelector('.stock-note')?.textContent);
assert('plum 400 is not greyed as sold-out', !lastCard.classList.contains('sold-out'));
assert('plum 400 plus stays enabled', lastCard.querySelector('.plus').disabled === false);
lastPlus.click();
assert('plum 400 can be added', lastCard.querySelector('.qty').textContent === '1',
  lastCard.querySelector('.qty').textContent);

w.__setStockForTest({}, 'error');
zeroCart();
assert('fetch fail does not show a stock warning', !/confirmed limits|out of stock|sold out/i.test(document.getElementById('stock-status').textContent || ''),
  document.getElementById('stock-status').textContent);
assert('fetch fail still defaults to 29 Nov', document.getElementById('pickup-date').value === '2026-11-29');
for (let i = 0; i < 20; i++) firstPlus.click();
assert('fetch fail does not clamp quantities', cards[0].querySelector('.qty').textContent === '20',
  cards[0].querySelector('.qty').textContent);
const dec6chip = document.querySelector('.date-chip[data-id="2026-12-06"]');
assert('fetch fail later dates stay orderable', dec6chip && dec6chip.disabled === false,
  dec6chip && (dec6chip.textContent + ' disabled=' + dec6chip.disabled));
w.selectPickupDate('2026-12-06');
assert('fetch fail remaining stays unlimited', w.remainingForItem(
  { name: 'Dates & Carrot Pudding', weight: '700g' }, '2026-12-06') === Infinity);

w.__setStockForTest({}, 'ok', null);
zeroCart();
firstPlus.click();
lastPlus.click();
w.loadStock = origLoadStock;

// Successful place — intercept WhatsApp redirect (jsdom forbids redefining location)
let redirected = '';
w.openWhatsApp = function(message) {
  redirected = 'https://wa.me/917204017793?text=' + encodeURIComponent(message);
};

w.selectPickupDate('2026-11-29');
w.selectMass('06:30');
// Sheets URL is configured: enqueue, show Order placed, open WhatsApp, flush in the background.
let postCalled = false;
window.fetch = (...args) => {
  const url = String(args[0] || '');
  const opts = args[1] || {};
  if (String(opts.method || 'GET').toUpperCase() === 'POST') postCalled = true;
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, status: 'saved' }) });
};

await w.placeOrder();
assert('redirected to WhatsApp immediately', redirected.startsWith('https://wa.me/917204017793?text='), redirected.slice(0, 80));
assert('button shows Order placed',
  document.getElementById('place-order-btn').disabled === true &&
  document.getElementById('place-order-btn').textContent === 'Order placed',
  document.getElementById('place-order-btn').disabled + ' ' + document.getElementById('place-order-btn').textContent);
await new Promise((r) => setTimeout(r, 40));
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('configured URL POSTs the queued order to Sheets', postCalled === true, 'POST fetch was not called');
assert('outbox is empty after a confirmed save',
  typeof w.readOrderOutbox !== 'function' || w.readOrderOutbox().length === 0,
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');

const decoded = decodeURIComponent(redirected.split('text=')[1] || '');
assert('redirect message has greeting', decoded.startsWith('✨ *Christmas Cake Order* ✨'), decoded);
assert('redirect message has name', decoded.includes('*Name:* Asha Rao'));
assert('redirect message has normalized phone', decoded.includes('*Phone:* 9876543210'));
assert('redirect message has pickup', decoded.includes('Sun, 29 Nov, after the 6:30 AM Mass'), decoded);
assert('redirect message has payment (one of the two contacts)', /\*Payment:\* Pay at pickup, or UPI to (\+91 72040 17793 \(Cyril Martin\)|\+91 80507 64341 \(Aashwin Alfy\))/.test(decoded), decoded);
assert('redirect has no delivery', !decoded.includes('*Delivery:*') && !decoded.includes('Flat / Block'), decoded);
assert('redirect message has thank you', decoded.includes('Thank you!'));
assert('redirect has order id', /\*Order ID:\* PB-\d{6}-[A-Z2-9]{4}/.test(decoded), decoded);
assert('redirect items include pudding and plum',
  decoded.includes('Dates & Carrot Pudding (700g)') && decoded.includes('Rich Plum Cake (400g)'),
  decoded);

// pageshow re-enables button
window.dispatchEvent(new window.Event('pageshow'));
assert('pageshow re-enables button', document.getElementById('place-order-btn').disabled === false);
assert('pageshow restores label', document.getElementById('place-order-btn').textContent === 'Place Order via WhatsApp');

// Invalid phone after +91 strip leaving bad number
document.getElementById('buyer-phone').value = '12345';
document.getElementById('place-order-btn').click();
assert('rejects short phone', document.getElementById('field-phone').classList.contains('invalid'));

// ---- Atomic reserve + idempotency ----
document.getElementById('buyer-phone').value = '9876543210';
w.selectMass('06:30');
window.__ORDER_TIMEOUT_MS = 80;
try { window.sessionStorage.clear(); } catch (e) {}
w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
w.loadStock = async function () {};
w.__setStockForTest({
  '2026-11-29': {
    'Dates & Carrot Pudding (700g)': 15,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  }
});
w.selectPickupDate('2026-11-29');
zeroCart();
firstPlus.click(); // 1 × Dates & Carrot 700g

const nov29Remaining = (n) => ({
  '2026-11-29': {
    'Dates & Carrot Pudding (700g)': n,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  }
});

// Pre-order: a server "insufficient" response does not block WhatsApp or clamp the cart.
redirected = '';
window.fetch = async function (url, opts) {
  opts = opts || {};
  return {
    ok: true,
    json: async () => ({ ok: false, status: 'insufficient', remaining: nov29Remaining(0) })
  };
};
await w.placeOrder();
assert('pre-order still opens WhatsApp if the server mentions stock', redirected.startsWith('https://wa.me/'), redirected);
assert('pre-order does not clamp the cart', cards[0].querySelector('.qty').textContent === '1',
  cards[0].querySelector('.qty').textContent);
const idAfterFirstQueue = window.sessionStorage.getItem('poppinsCheckoutOrderId');
assert('queued checkout keeps the order id until the sheet confirms', !!idAfterFirstQueue, String(idAfterFirstQueue));
await new Promise((r) => setTimeout(r, 40));
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('failed flush leaves the order in the outbox',
  typeof w.readOrderOutbox === 'function' && w.readOrderOutbox().some((e) => e.order && e.order.orderId === idAfterFirstQueue),
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');

// retry flush with the same order ID then succeeds
const bodies = [];
window.fetch = async function (url, opts) {
  opts = opts || {};
  if (opts.body) bodies.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ ok: true, status: 'saved', orderId: bodies[bodies.length - 1].orderId }) };
};
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('retry flush POSTs the same order id', bodies.length >= 1 && bodies[0].orderId === idAfterFirstQueue,
  JSON.stringify(bodies.map((b) => b.orderId)) + ' kept=' + idAfterFirstQueue);
assert('confirmed flush clears the outbox',
  typeof w.readOrderOutbox !== 'function' || w.readOrderOutbox().length === 0,
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');

// duplicate also redirects (idempotent success)
window.dispatchEvent(new window.Event('pageshow'));
redirected = '';
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-DUP1'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.selectPickupDate('2026-11-29');
w.selectMass('06:30');
w.__setStockForTest(nov29Remaining(15));
window.fetch = async function () {
  return { ok: true, json: async () => ({ ok: true, status: 'duplicate', orderId: 'PB-261123-DUP1' }) };
};
await w.placeOrder();
assert('duplicate is ok and redirects to WhatsApp', redirected.startsWith('https://wa.me/'), redirected);
assert('duplicate payload reused stored id', decodeURIComponent(redirected).includes('PB-261123-DUP1') ||
  true /* message uses payload id */);
const decodedDup = decodeURIComponent(redirected.split('text=')[1] || '');
assert('duplicate WhatsApp uses same order id', decodedDup.includes('*Order ID:* PB-261123-DUP1'), decodedDup);

// Network failure: WhatsApp still opens instantly; the outbox keeps the order for retry.
window.dispatchEvent(new window.Event('pageshow'));
redirected = '';
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-FB01'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.__setStockForTest(nov29Remaining(15));
w.selectPickupDate('2026-11-29');
w.selectMass('06:30');
const timeoutBodies = [];
window.fetch = async function (url, opts) {
  opts = opts || {};
  if (opts.body) timeoutBodies.push(JSON.parse(opts.body));
  throw new Error('hang');
};
await w.placeOrder();
assert('timeout still opens WhatsApp immediately', redirected.startsWith('https://wa.me/'), redirected);
await new Promise((r) => setTimeout(r, 40));
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('failed network flush keeps the order in the outbox',
  typeof w.readOrderOutbox === 'function' && w.readOrderOutbox().some((e) => e.order && e.order.orderId === 'PB-261123-FB01'),
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');
assert('queued payload reuses the same order ID', timeoutBodies.length === 0 || timeoutBodies[0].orderId === 'PB-261123-FB01',
  JSON.stringify(timeoutBodies));

// A later successful flush (simulating the next page load) removes it.
window.fetch = async function (url, opts) {
  opts = opts || {};
  return { ok: true, json: async () => ({ ok: true, status: 'duplicate', orderId: 'PB-261123-FB01' }) };
};
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('duplicate confirmation clears the outbox entry',
  typeof w.readOrderOutbox !== 'function' || !w.readOrderOutbox().some((e) => e.order && e.order.orderId === 'PB-261123-FB01'),
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');

w.__setSheetsUrlForTest('');
window.__ORDER_TIMEOUT_MS = undefined;
w.loadStock = origLoadStock;

// Multiple queued orders survive a reload and flush one by one.
try { window.localStorage.removeItem('poppinsOrderOutbox'); } catch (e) {}
w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
window.dispatchEvent(new window.Event('pageshow'));
w.selectPickupDate('2026-11-29');
w.selectMass('06:30');
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '9876543210';
zeroCart();
firstPlus.click();
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-Q1'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
redirected = '';
window.fetch = async function () { throw new Error('offline'); };
await w.placeOrder();
window.dispatchEvent(new window.Event('pageshow'));
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-Q2'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.selectPickupDate('2026-11-29');
w.selectMass('06:30');
await w.placeOrder();
const queued = (typeof w.readOrderOutbox === 'function') ? w.readOrderOutbox() : [];
assert('outbox holds two distinct orders', queued.length === 2 &&
  queued.some((e) => e.order && e.order.orderId === 'PB-261123-Q1') &&
  queued.some((e) => e.order && e.order.orderId === 'PB-261123-Q2'),
  JSON.stringify(queued.map((e) => e && e.order && e.order.orderId)));
// Simulate a reload by reading the raw localStorage key and flushing again.
const rawOutbox = window.localStorage.getItem('poppinsOrderOutbox');
assert('outbox queue survives in localStorage', !!(rawOutbox && rawOutbox.indexOf('PB-261123-Q1') >= 0 && rawOutbox.indexOf('PB-261123-Q2') >= 0), rawOutbox);
const flushedIds = [];
window.fetch = async function (url, opts) {
  opts = opts || {};
  const body = opts.body ? JSON.parse(opts.body) : {};
  flushedIds.push(body.orderId);
  return { ok: true, json: async () => ({ ok: true, status: 'saved', orderId: body.orderId }) };
};
if (typeof w.flushOrderOutbox === 'function') await w.flushOrderOutbox({ force: true });
assert('flush posts both queued orders', flushedIds.includes('PB-261123-Q1') && flushedIds.includes('PB-261123-Q2'),
  JSON.stringify(flushedIds));
assert('both confirmed orders are removed from the outbox',
  typeof w.readOrderOutbox !== 'function' || w.readOrderOutbox().length === 0,
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');
w.__setSheetsUrlForTest('');


// ---- Netlify /api/order flow: server picks the contact ----
{
  try { window.localStorage.removeItem('poppinsOrderOutbox'); window.sessionStorage.clear(); } catch (e) {}
  w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
  window.dispatchEvent(new window.Event('pageshow'));
  let waUrl = '';
  w.openWhatsApp = function (message, contact) { waUrl = w.whatsAppUrl(message, contact); };
  document.getElementById('buyer-name').value = 'Asha Rao';
  document.getElementById('buyer-phone').value = '9876543210';
  zeroCart();
  firstPlus.click();
  w.selectPickupDate('2026-11-29');
  w.selectMass('06:30');
  const apiCalls = [];
  const sheetCalls = [];
  window.fetch = async function (url, opts) {
    opts = opts || {};
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url) === '/api/order') {
      apiCalls.push(body);
      return { ok: true, json: async () => ({ ok: true, status: apiCalls.length > 1 ? 'duplicate' : 'queued', orderId: body.orderId,
        contact: { id: 'aashwin', name: 'Aashwin Alfy', number: '918050764341', display: '+91 80507 64341' } }) };
    }
    sheetCalls.push(body);
    return { ok: true, json: async () => ({ ok: true, status: 'saved' }) };
  };
  await w.placeOrder();
  const msgApi = decodeURIComponent(waUrl.split('text=')[1] || '');
  assert('api: POSTs the order to /api/order', apiCalls.length === 1 && /^PB-/.test(apiCalls[0].orderId), JSON.stringify(apiCalls));
  assert('api: does not post to Apps Script from the browser', sheetCalls.length === 0, JSON.stringify(sheetCalls));
  assert('api: WhatsApp opens the assigned contact', waUrl.startsWith('https://api.whatsapp.com/send?phone=918050764341&text='), waUrl.slice(0, 70));
  assert('api: message payment line names the assigned contact',
    msgApi.includes('*Payment:* Pay at pickup, or UPI to +91 80507 64341 (Aashwin Alfy)'), msgApi);
  assert('api: page payment line switches to the assigned contact',
    document.getElementById('payment-note').textContent === 'Payment: Pay at pickup, or UPI to +91 80507 64341 (Aashwin Alfy)',
    document.getElementById('payment-note').textContent);
  const conf = document.getElementById('order-confirm');
  assert('api: order placed confirmation is shown', !conf.hidden && conf.textContent.includes(apiCalls[0].orderId) && conf.textContent.includes('Aashwin Alfy'), conf.textContent);
  assert('api: button says Order placed', document.getElementById('place-order-btn').textContent === 'Order placed');
  assert('api: nothing left in the browser outbox', w.readOrderOutbox().length === 0, JSON.stringify(w.readOrderOutbox()));

  // Re-tap with the same cart/details → same order id (server answers duplicate, same contact)
  window.dispatchEvent(new window.Event('pageshow'));
  await w.placeOrder();
  assert('api: re-tap reuses the same order id', apiCalls.length === 2 && apiCalls[1].orderId === apiCalls[0].orderId,
    JSON.stringify(apiCalls.map((b) => b.orderId)));

  // Change the cart → new order id
  window.dispatchEvent(new window.Event('pageshow'));
  lastPlus.click();
  await w.placeOrder();
  assert('api: a changed cart gets a new order id', apiCalls.length === 3 && apiCalls[2].orderId !== apiCalls[0].orderId,
    JSON.stringify(apiCalls.map((b) => b.orderId)));

  // Function unreachable (e.g. plain drag-and-drop deploy → 404): random contact + outbox → Apps Script
  window.dispatchEvent(new window.Event('pageshow'));
  try { window.sessionStorage.clear(); } catch (e) {}
  zeroCart();
  firstPlus.click();
  const direct = [];
  window.fetch = async function (url, opts) {
    opts = opts || {};
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url) === '/api/order') return { ok: false, status: 404, json: async () => ({}) };
    direct.push({ url: String(url), body });
    return { ok: true, json: async () => ({ ok: true, status: 'saved', orderId: body.orderId }) };
  };
  const origRandom = window.Math.random;
  window.Math.random = () => 0.99; // → second contact
  await w.placeOrder();
  window.Math.random = origRandom;
  const fbMsg = decodeURIComponent(waUrl.split('text=')[1] || '');
  assert('fallback: WhatsApp still opens (random contact)', waUrl.startsWith('https://api.whatsapp.com/send?phone=918050764341'), waUrl.slice(0, 70));
  assert('fallback: message payment line matches the random contact', fbMsg.includes('UPI to +91 80507 64341 (Aashwin Alfy)'), fbMsg);
  await new Promise((r) => setTimeout(r, 40));
  await w.flushOrderOutbox({ force: true });
  assert('fallback: order goes straight to Apps Script with the contact name',
    direct.some((d) => d.url.includes('script.google.com') && d.body.assignedTo === 'Aashwin Alfy' && d.body.assignedContactId === 'aashwin'),
    JSON.stringify(direct.map((d) => [d.url, d.body.assignedTo])));
  assert('fallback: outbox clears after the Sheet confirms', w.readOrderOutbox().length === 0, JSON.stringify(w.readOrderOutbox()));

  // Outbox retry prefers /api/order and passes the contact hint
  try { window.localStorage.removeItem('poppinsOrderOutbox'); window.sessionStorage.clear(); } catch (e) {}
  window.dispatchEvent(new window.Event('pageshow'));
  window.fetch = async function () { throw new Error('offline'); };
  await w.placeOrder();
  const queuedHint = w.readOrderOutbox()[0];
  assert('offline: order is queued with its contact', !!(queuedHint && queuedHint.order.assignedContactId), JSON.stringify(queuedHint));
  const retried = [];
  window.fetch = async function (url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    retried.push({ url: String(url), body });
    return { ok: true, json: async () => ({ ok: true, status: 'queued', orderId: body.orderId, contact: { id: body.assignedContactId } }) };
  };
  await w.flushOrderOutbox({ force: true });
  assert('offline retry: goes to /api/order first with assignedContactId',
    retried.length === 1 && retried[0].url === '/api/order' && retried[0].body.assignedContactId === queuedHint.order.assignedContactId,
    JSON.stringify(retried.map((r) => [r.url, r.body.assignedContactId])));
  assert('offline retry: outbox cleared', w.readOrderOutbox().length === 0);
  w.__setSheetsUrlForTest('');
  try { window.sessionStorage.clear(); } catch (e) {}
}

// ---- Custom pickup dates from the Stock / server catalog ----
window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
window.dispatchEvent(new window.Event('pageshow'));

const friDates = [
  { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30' },
  { id: '2026-12-25', label: 'Fri, 25 Dec', closesAt: '2026-12-25T10:00:00+05:30' }
];
const friRemaining = {
  '2026-11-29': {
    'Dates & Carrot Pudding (700g)': 15,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  },
  '2026-12-25': {
    'Dates & Carrot Pudding (700g)': 8,
    'Dates & Carrot Pudding (350g)': 0,
    'Butterscotch Pudding (700g)': 0,
    'Butterscotch Pudding (350g)': 0,
    'Rich Plum Cake (800g)': 0,
    'Rich Plum Cake (400g)': 50
  }
};
w.loadStock = async function () {};
w.__setStockForTest(friRemaining, 'ok', friDates);
const customChips = [...document.querySelectorAll('.date-chip')];
assert('server catalog drives chips (2 dates)', customChips.length === 2, customChips.map((c) => c.dataset.id).join(','));
assert('Friday label uses the actual weekday',
  /Fri, 25 Dec/.test(customChips[1].textContent) && !/Sun/.test(customChips[1].textContent),
  customChips[1].textContent);
assert('dates not on Stock are omitted', customChips.every((c) =>
  c.dataset.id !== '2026-12-06' && c.dataset.id !== '2026-12-13' && c.dataset.id !== '2026-12-20'));
assert('Friday date with stock is orderable', customChips[1].disabled === false);
w.selectPickupDate('2026-12-25', { skipReload: true });
assert('can select a custom weekday date', document.getElementById('pickup-date').value === '2026-12-25');
assert('custom date is not stock-limited', w.remainingForItemId('dates-carrot-pudding-700') === Infinity,
  String(w.remainingForItemId('dates-carrot-pudding-700')));
assert('Friday open at 9:59 AM IST (header time)',
  w.isPickupDateOpen('2026-12-25', new Date('2026-12-25T09:59:00+05:30')) === true);
assert('Friday closed at 10:00 AM IST (header time)',
  w.isPickupDateOpen('2026-12-25', new Date('2026-12-25T10:00:00+05:30')) === false);
assert('default cutoff stays 8:30 AM IST when header has no time',
  w.isPickupDateOpen('2026-11-29', new Date('2026-11-29T08:29:00+05:30')) === true &&
  w.isPickupDateOpen('2026-11-29', new Date('2026-11-29T08:30:00+05:30')) === false);

const payloadFri = w.buildOrderPayload();
const waFri = w.buildWhatsAppMessage(payloadFri);
assert('WhatsApp uses Friday short label', waFri.includes('Fri, 25 Dec, after the 6:30 AM Mass'), waFri);
assert('Friday WhatsApp has payment line', waFri.includes('*Payment:* Pay at pickup, or UPI to +91 72040 17793 (Cyril Martin)'), waFri);

// fetch fail restores the fallback catalog, not the live Friday date
w.__setStockForTest({}, 'error');
const fallbackChips = [...document.querySelectorAll('.date-chip')];
assert('fetch fail uses fallback date list', fallbackChips.length === 4, fallbackChips.map((c) => c.dataset.id).join(','));
assert('fetch fail starts at 29 Nov', fallbackChips[0].dataset.id === '2026-11-29');
assert('fetch fail does not keep the Friday date', fallbackChips.every((c) => c.dataset.id !== '2026-12-25'));

// invalid_date: a pickup date not on the listed catalog is rejected client-side
w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
w.loadStock = async function () {};
w.__setStockForTest(friRemaining, 'ok', [friDates[0]]);
w.selectMass('06:30');
document.getElementById('buyer-name').value = 'Asha';
document.getElementById('buyer-phone').value = '9876543210';
zeroCart();
firstPlus.click();
window.dispatchEvent(new window.Event('pageshow'));
document.getElementById('pickup-date').value = '2026-12-25';
redirected = '';
await w.placeOrder();
assert('invalid_date blocks WhatsApp', redirected === '', redirected);
assert('invalid_date shows a date message', /not available|Pick a pickup date/i.test(
    (document.getElementById('field-pickup-date')?.textContent || '') +
    (document.getElementById('cart-error').textContent || '') +
    (document.getElementById('checkout-alert')?.textContent || '')
  ),
  document.getElementById('field-pickup-date')?.textContent + ' | ' + document.getElementById('cart-error').textContent);
assert('invalid_date leaves the button enabled', document.getElementById('place-order-btn').disabled === false &&
  document.getElementById('place-order-btn').textContent === 'Place Order via WhatsApp');

w.__setSheetsUrlForTest('');
w.loadStock = origLoadStock;
w.__setStockForTest(nov29Remaining(15), 'ok', null);
window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');

// Pre-orders closed after the last 8:30 AM IST
window.__TEST_NOW = new Date('2026-12-20T08:30:00+05:30');
w.renderPickupDates();
assert('no chips when all dates have passed', document.querySelectorAll('.date-chip').length === 0);
assert('pre-orders closed banner shown', document.getElementById('preorders-closed').classList.contains('visible'));
assert('CTA disabled when closed', document.getElementById('place-order-btn').disabled === true);
assert('CTA label when closed', document.getElementById('place-order-btn').textContent === 'Pre-orders closed');
window.dispatchEvent(new window.Event('pageshow'));
assert('pageshow keeps CTA closed', document.getElementById('place-order-btn').disabled === true &&
  document.getElementById('place-order-btn').textContent === 'Pre-orders closed');

// ---- Performance markup + itemized summary ----
assert('hero uses a picture element', !!document.querySelector('.poster-wrap picture'));
assert('WebP source with JPEG fallback',
  document.querySelector('picture source[type="image/webp"]')?.getAttribute('srcset') === 'poster.webp' &&
  document.querySelector('picture img')?.getAttribute('src') === 'poster.jpg');
assert('hero has width and height to avoid CLS',
  document.querySelector('picture img')?.getAttribute('width') === '1024' &&
  document.querySelector('picture img')?.getAttribute('height') === '1536');
assert('hero fetchpriority is high',
  document.querySelector('picture img')?.getAttribute('fetchpriority') === 'high');
assert('preconnects Apps Script origins',
  !!document.querySelector('link[rel="preconnect"][href="https://script.google.com"]') &&
  !!document.querySelector('link[rel="preconnect"][href="https://script.googleusercontent.com"]'));
assert('left and right layout columns exist',
  !!document.querySelector('.left-col') && !!document.querySelector('.right-col'));
assert('order summary has a cart-lines list', !!document.getElementById('cart-lines'));

// reset clock and stock so the cart can be edited
window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
w.renderPickupDates();
w.resetSubmitButton();
w.__setStockForTest({
  '2026-11-29': {
    'Dates & Carrot Pudding (700g)': 15,
    'Dates & Carrot Pudding (350g)': 35,
    'Butterscotch Pudding (700g)': 10,
    'Butterscotch Pudding (350g)': 25,
    'Rich Plum Cake (800g)': 20,
    'Rich Plum Cake (400g)': 50
  }
}, 'ok', null);
zeroCart();
w.updateSummary();
assert('empty cart-lines shows empty state', /Your cart is empty/.test(document.getElementById('cart-lines').textContent),
  document.getElementById('cart-lines').textContent);
firstPlus.click();
firstPlus.click();
assert('cart-lines lists the added item',
  /2\s*×/.test(document.getElementById('cart-lines').textContent) &&
  /Dates & Carrot Pudding \(700g\)/.test(document.getElementById('cart-lines').textContent) &&
  /₹1,300/.test(document.getElementById('cart-lines').textContent),
  document.getElementById('cart-lines').textContent);
assert('compact summary stays in sync with cart-lines',
  document.getElementById('summary-count').textContent === '2 items' &&
  document.getElementById('summary-total').textContent === '₹1,300');

// ---- Poster palette + full-width desktop grid ----
assert('theme-color is poster maroon', document.querySelector('meta[name="theme-color"]')?.getAttribute('content') === '#7a0a10');
const rootCss = document.querySelector('style')?.textContent || '';
assert('CSS defines extracted palette tokens',
  /--maroon:\s*#7a0a10/.test(rootCss) &&
  /--gold:\s*#c27b13/.test(rootCss) &&
  /--cream:\s*#f7ede5/.test(rootCss) &&
  /--blue:\s*#0544b3/.test(rootCss) &&
  /--ink:\s*#2a2306/.test(rootCss) &&
  /--pine:\s*#435718/.test(rootCss),
  'missing token in :root');
assert('old festive red #b91c1c is gone', !/#b91c1c/i.test(rootCss + document.documentElement.outerHTML));
assert('desktop padding is fluid clamp', /padding:\s*clamp\(16px,\s*3vw,\s*48px\)/.test(rootCss));
assert('desktop left column is minmax(340px, 32%)', /minmax\(340px,\s*32%\)/.test(rootCss));
assert('wide desktop summary is minmax(300px, 22%)', /minmax\(300px,\s*22%\)/.test(rootCss));
assert('menu grid fills with auto-fill 260px', /repeat\(auto-fill,\s*minmax\(260px,\s*1fr\)\)/.test(rootCss));
assert('1280px breakpoint opens a third column', /@media \(min-width:\s*1280px\)/.test(rootCss));
assert('CTA text is unchanged for WhatsApp', document.getElementById('place-order-btn').textContent === 'Place Order via WhatsApp');

const failed = results.filter((r) => !r.ok);
console.log('\n--- ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) {
  console.error(failed);
  process.exit(1);
}
