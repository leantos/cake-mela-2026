import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = readPage('index.html');
// jsdom would try to download tailwind.css from the fake origin and block the
// scripts behind it, so the stylesheet link is removed before parsing (the raw
// markup is still asserted on below).
const TAILWIND_LINK = '<link rel="stylesheet" href="tailwind.css">';
const dom = new JSDOM(html.replace(TAILWIND_LINK, ''), {
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
// index.html as written on disk (readPage() also inlines site-config.js, whose comments are not this page).
const rawIndexHtml = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
const confirmView = () => document.getElementById('order-confirmation');
const confirmShown = () => confirmView().hidden === false;
const confirmTitle = () => document.getElementById('order-confirmation-title').textContent;
const cards = document.querySelectorAll('.menu-card');
assert('renders 6 menu cards', cards.length === 6, cards.length);

assert('title branded for parish', document.title.includes('Vailankanni Matha Youth'), document.title);
assert('favicon present', !!document.querySelector('link[rel="icon"][href="logo.png"]'));
assert('apple-touch-icon present', !!document.querySelector('link[rel="apple-touch-icon"][href="logo.png"]'));
assert('header title', document.querySelector('header.hero-head h1')?.textContent === 'Vailankanni Matha Youth');
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
assert('helper showOrderConfirmation is global', typeof w.showOrderConfirmation === 'function');
assert('WhatsApp is gone: no message builder, opener or url helper', typeof w.buildWhatsAppMessage === 'undefined' && typeof w.openWhatsApp === 'undefined' && typeof w.whatsAppUrl === 'undefined');
assert('WhatsApp is gone: no WhatsApp text, and exactly one wa.me link in the page (the UPI screenshot button)', !/whatsapp/i.test(rawIndexHtml) && (rawIndexHtml.match(/wa\.me/g) || []).length === 1, String((rawIndexHtml.match(/wa\.me/g) || []).length));
assert('contact assignment is gone: no random contact or assignment helpers', typeof w.pickRandomContact === 'undefined' && typeof w.applyContactToOrder === 'undefined' && typeof w.resolveContact === 'undefined');
const payNote = document.querySelector('.sticky-bar .payment-note');
assert('payment note sits in the sticky summary and names both UPI numbers',
  !!(payNote && /^Payment: Pay at pickup, or UPI to /.test(payNote.textContent) &&
    payNote.textContent.includes('+91 72040 17793 (Cyril Martin)') && payNote.textContent.includes('+91 80507 64341 (Aashwin Alfy)') &&
    !/[{}]/.test(payNote.textContent)), payNote && payNote.textContent);
assert('payment line is the same plain sentence in code',
  w.eval('PAYMENT_LINE') === payNote.textContent.replace(/^Payment: /, ''), w.eval('PAYMENT_LINE'));
const enquire = document.getElementById('enquire');
assert('enquiries list both contacts', !!(enquire &&
  enquire.textContent.includes('Cyril Martin • +91 72040 17793') &&
  enquire.textContent.includes('Aashwin Alfy • +91 80507 64341') &&
  enquire.querySelector('a[href="tel:+917204017793"]') && enquire.querySelector('a[href="tel:+918050764341"]')),
  enquire && enquire.innerHTML);
assert('site-config.js loaded two contacts', w.eval('CONTACTS.length') === 2 && w.SITE_CONFIG && w.SITE_CONFIG.contacts.length === 2);

// ---- Contact us lives in the top bar (inline pills on wide screens, menu on narrow) ----
{
  const header = document.querySelector('header.hero-head');
  const cfg = w.SITE_CONFIG.contacts;
  assert('Contact us: old contact card below the poster is gone', !document.querySelector('.contact-card'));
  assert('Contact us: inline tel links are inside the top bar',
    !!header && cfg.every((c) => header.querySelector('#enquire a[href="tel:+' + c.number + '"]')));
  const btn = document.getElementById('contact-btn');
  const menu = document.getElementById('contact-menu');
  assert('Contact menu button has menu semantics',
    !!btn && btn.getAttribute('aria-haspopup') === 'menu' && btn.getAttribute('aria-expanded') === 'false' &&
    btn.getAttribute('aria-controls') === 'contact-menu' && !!menu && menu.getAttribute('role') === 'menu' && menu.hidden === true);
  const links = Array.from(menu.querySelectorAll('a[role="menuitem"]'));
  assert('Contact menu links are built from SITE_CONFIG.contacts',
    links.length === cfg.length && cfg.every((c, i) => links[i].getAttribute('href') === 'tel:+' + c.number && links[i].textContent.includes(c.name)),
    menu.innerHTML);
  assert('Contact menu items are at least 48px tall (min-h-12)', links.every((a) => a.className.includes('min-h-12')));

  btn.click();
  assert('Contact menu opens on click and focuses the first link',
    menu.hidden === false && btn.getAttribute('aria-expanded') === 'true' && document.activeElement === links[0]);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert('Contact menu closes on Escape and returns focus to the button',
    menu.hidden === true && btn.getAttribute('aria-expanded') === 'false' && document.activeElement === btn);

  btn.click();
  document.body.click();
  assert('Contact menu closes on an outside click', menu.hidden === true && btn.getAttribute('aria-expanded') === 'false');

  btn.click();
  menu.click();
  assert('Clicking inside the menu (not on a link) keeps it open', menu.hidden === false);
  links[0].addEventListener('click', (e) => e.preventDefault());
  links[0].click();
  assert('Choosing a contact closes the menu', menu.hidden === true);
}

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

{
  // The confirmation screen content is built from a sample order (no network, no WhatsApp).
  const sample = {
    orderId: 'PB-251123-K7MQ',
    items: [
      { qty: 2, name: 'Rich Plum Cake (400g)', lineTotal: 700 },
      { qty: 1, name: 'Dates & Carrot Pudding (700g)', lineTotal: 650 }
    ],
    totalItems: 3,
    totalAmount: 1350,
    name: 'Asha Rao',
    phone: '9876543210',
    pickupDateShort: 'Sun, 29 Nov'
  };
  w.showOrderConfirmation(sample);
  const view = confirmView();
  assert('confirmation: view is shown, role=status, with Order placed as the heading',
    confirmShown() && view.getAttribute('role') === 'status' && confirmTitle() === 'Order placed');
  assert('confirmation: focus moves to the heading', document.activeElement && document.activeElement.id === 'order-confirmation-title', document.activeElement && document.activeElement.id);
  assert('confirmation: order id and pickup date', document.getElementById('confirm-order-id').textContent === 'PB-251123-K7MQ' && document.getElementById('confirm-pickup').textContent === 'Sun, 29 Nov');
  const cl = document.getElementById('confirm-lines').textContent.replace(/\s+/g, ' ');
  assert('confirmation: lists the cakes with quantities and line totals', cl.includes('2 × Rich Plum Cake (400g)') && cl.includes('₹700') && cl.includes('1 × Dates & Carrot Pudding (700g)') && cl.includes('₹650'), cl);
  assert('confirmation: shows the total', document.getElementById('confirm-total').textContent === '₹1,350', document.getElementById('confirm-total').textContent);
  assert('confirmation: shows the payment line', document.getElementById('confirm-payment').textContent === w.eval('PAYMENT_LINE'), document.getElementById('confirm-payment').textContent);
  const calls = Array.from(document.querySelectorAll('#confirm-call a'));
  assert('confirmation: two tonal tel: Call us links from SITE_CONFIG.contacts',
    calls.length === 2 && calls[0].getAttribute('href') === 'tel:+917204017793' && calls[1].getAttribute('href') === 'tel:+918050764341' &&
    calls.every((a) => a.className.includes('bg-m3-secondary-container') && a.className.includes('min-h-12')),
    calls.map((a) => a.outerHTML).join(' '));
  assert('confirmation: has a filled Place another order button', document.getElementById('place-another').textContent.trim() === 'Place another order' && document.getElementById('place-another').className.includes('bg-m3-primary'));
  w.showOrderConfirmation(sample, { offline: true });
  assert('confirmation: offline variant says the order is saved and will be sent when online',
    /Order saved/.test(confirmTitle()) && /as soon as you.re online/.test(confirmTitle()) && view.classList.contains('offline'), confirmTitle());
  w.hideOrderConfirmation();
  assert('confirmation: hideOrderConfirmation hides it', confirmView().hidden === true);
}

// ---- Pay by UPI: QR + the single "Send screenshot" link (the only wa.me link) ----
{
  const sampleUpi = {
    orderId: 'PB-251123-K7MQ',
    items: [{ qty: 2, name: 'Rich Plum Cake (400g)', lineTotal: 700 }, { qty: 1, name: 'Dates & Carrot Pudding (700g)', lineTotal: 650 }],
    totalItems: 3, totalAmount: 1350, name: 'Asha Rao', phone: '9876543210', pickupDateShort: 'Sun, 29 Nov'
  };
  w.showOrderConfirmation(sampleUpi);
  const box = document.getElementById('confirm-upi');
  const img = box.querySelector('img.upi-qr');
  assert('upi: the confirmation screen shows the QR image with its alt text',
    !!img && img.getAttribute('src') === 'cyril-upi-qr.jpg' && img.getAttribute('alt') === 'UPI QR code to pay Cyril Martin' && img.getAttribute('loading') === 'lazy',
    img && img.outerHTML);
  assert('upi: the QR is width-limited (~280px), centred and rounded',
    img.className.includes('max-w-[280px]') && img.className.includes('w-full') && img.className.includes('rounded-m3-lg') && box.className.includes('items-center'), img.className);
  assert('upi: the confirmation shows the amount to pay and the order ID reminder',
    box.querySelector('.upi-amount').textContent === 'Pay ₹1,350' && box.querySelector('.upi-note').textContent.includes('PB-251123-K7MQ'),
    box.querySelector('.upi-amount').textContent + ' | ' + box.querySelector('.upi-note').textContent);
  const shot = box.querySelector('a.upi-screenshot');
  const shotUrl = new URL(shot.getAttribute('href'));
  const shotMsg = shotUrl.searchParams.get('text');
  assert('upi: the screenshot button opens wa.me/917204017793 in a new tab with rel=noopener',
    shot.textContent.trim() === 'Send screenshot to Cyril' && shotUrl.origin + shotUrl.pathname === 'https://wa.me/917204017793' &&
    shot.getAttribute('target') === '_blank' && /noopener/.test(shot.getAttribute('rel') || ''), shot.outerHTML);
  assert('upi: the message carries the total and order ID and is BMP-only',
    shotMsg === 'Hi Cyril, I have paid ₹1,350 for order PB-251123-K7MQ. Screenshot attached.' && !/[\uD800-\uDFFF]/.test(shotMsg), shotMsg);
  assert('upi: nothing in the Place order button or the confirmation title mentions WhatsApp',
    !/whatsapp/i.test(document.getElementById('place-order-btn').textContent) && !/whatsapp/i.test(confirmTitle()) && !/whatsapp/i.test(document.getElementById('confirm-payment').textContent));
  w.hideOrderConfirmation();

  // the same QR lives in a collapsible card in the Your details step
  const card = document.getElementById('pay-upi-card');
  assert('upi: a collapsible Pay by UPI card sits in the Your details step',
    !!card && card.tagName === 'DETAILS' && document.getElementById('panel-details').contains(card) && /Pay by UPI/.test(card.querySelector('summary').textContent));
  const cimg = card.querySelector('img.upi-qr');
  assert('upi: the details step shows the same QR with the same alt text',
    !!cimg && cimg.getAttribute('src') === 'cyril-upi-qr.jpg' && cimg.getAttribute('alt') === 'UPI QR code to pay Cyril Martin' && cimg.getAttribute('loading') === 'lazy' && cimg.className.includes('max-w-[280px]'));
  zeroCart();
  assert('upi: with an empty cart the card asks you to pick cakes', card.querySelector('.upi-amount').textContent === 'Pick your cakes to see the amount', card.querySelector('.upi-amount').textContent);
  cards[0].querySelector('.plus').click();
  assert('upi: the details-step amount follows the cart', card.querySelector('.upi-amount').textContent === 'Pay ₹650', card.querySelector('.upi-amount').textContent);
  const cshot = card.querySelector('a.upi-screenshot');
  const cmsg = new URL(cshot.getAttribute('href')).searchParams.get('text');
  assert('upi: before ordering the message has the total but no order ID wording',
    cmsg === 'Hi Cyril, I have paid ₹650 for my cake order. Screenshot attached.' && !/PB-|order PB/.test(cmsg) && cshot.getAttribute('target') === '_blank' && /noopener/.test(cshot.getAttribute('rel')), cmsg);
  zeroCart();
  const waLinks = Array.from(document.querySelectorAll('a[href*="wa.me"]'));
  assert('upi: the only wa.me links in the page are the two screenshot buttons, both to Cyril',
    waLinks.length === 2 && waLinks.every((a) => a.classList.contains('upi-screenshot') && a.getAttribute('href').startsWith('https://wa.me/917204017793?text=')),
    waLinks.map((a) => a.getAttribute('href')).join(' | '));
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
assert('no Mass field or chips exist any more', !document.getElementById('field-mass') && !document.getElementById('mass-options') && !document.getElementById('pickup-mass'));
document.getElementById('pickup-date').value = '';
document.getElementById('place-order-btn').click();
assert('pickup date required once cleared', document.getElementById('field-pickup-date').classList.contains('invalid'));
w.selectPickupDate('2026-11-29');
assert('button not stuck after failed validation', document.getElementById('place-order-btn').disabled === false);
assert('button text unchanged', document.getElementById('place-order-btn').textContent === 'Place order');

assert('no mass option buttons are rendered', document.querySelectorAll('.mass-option').length === 0);
assert('no delivery field', !document.getElementById('field-delivery') && !document.getElementById('field-flat'));
assert('church pickup note', /Vailankanni Matha Church, Muthanallur/.test(document.getElementById('pickup-place')?.textContent || ''));

document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '+91 98765 43210';
document.getElementById('pickup-date').value = '';
document.getElementById('place-order-btn').click();
assert('pickup date still required after name/phone', document.getElementById('field-pickup-date').classList.contains('invalid'));

const formAlert = document.getElementById('form-alert');
assert('invalid submit opens the custom alert dialog', formAlert && !formAlert.hidden && formAlert.classList.contains('is-open'));
assert('alert is an alertdialog', document.getElementById('form-alert-dialog')?.getAttribute('role') === 'alertdialog');
assert('alert is modal', document.getElementById('form-alert-dialog')?.getAttribute('aria-modal') === 'true');
assert('alert title is Almost there!', document.getElementById('form-alert-title')?.textContent === 'Almost there!');
assert('alert lists the missing pickup date', /Pick a pickup date/.test(formAlert.textContent), formAlert.textContent);
assert('alert OK button label', document.getElementById('form-alert-ok')?.textContent === 'OK, fix it');
const checkoutAlert = document.getElementById('checkout-alert');
assert('sticky summary lists missing pickup date', checkoutAlert && !checkoutAlert.hidden && /Pick a pickup date/.test(checkoutAlert.textContent),
  checkoutAlert && checkoutAlert.textContent);
assert('button stays tappable after invalid submit', document.getElementById('place-order-btn').disabled === false);

// Filling a field clears that error live without closing the need to fix others
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-name').dispatchEvent(new window.Event('input', { bubbles: true }));
assert('name highlight clears once filled', !document.getElementById('field-name').classList.contains('invalid'));
assert('name aria-invalid removed once filled', document.getElementById('buyer-name').getAttribute('aria-invalid') !== 'true');

// Close via the OK button: first remaining problem (phone, if emptied) or date
document.getElementById('buyer-phone').value = '';
document.getElementById('buyer-phone').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('form-alert-ok').click();
assert('OK closes the alert', formAlert.hidden === true && !formAlert.classList.contains('is-open'));
assert('closing the alert focuses the first invalid field', document.activeElement === document.getElementById('buyer-phone') ||
  document.activeElement === document.getElementById('buyer-name') ||
  document.activeElement && document.activeElement.classList.contains('plus') ||
  document.activeElement && document.activeElement.classList.contains('date-chip') ||
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
document.getElementById('place-order-btn').click();
assert('empty cart is listed in the alert', /Please add at least one cake/.test(formAlert.textContent), formAlert.textContent);
assert('alert lists name, phone and date',
  /Enter your name/.test(formAlert.textContent) &&
  /Enter a 10-digit phone number/.test(formAlert.textContent) &&
  /Pick a pickup date/.test(formAlert.textContent),
  formAlert.textContent);
assert('sticky alert is a live region', checkoutAlert.getAttribute('role') === 'alert' && checkoutAlert.getAttribute('aria-live') === 'assertive');
assert('reduced-motion is respected for the alert (Tailwind motion-reduce)',
  document.getElementById('form-alert-dialog').className.includes('motion-reduce:animate-none') &&
  document.getElementById('form-alert-backdrop').className.includes('motion-reduce:animate-none'),
  'missing motion-reduce:animate-none');

w.closeFormAlert();
firstPlus.click();
w.selectPickupDate('2026-11-29');
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '+91 98765 43210';
document.getElementById('buyer-name').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('buyer-phone').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('pickup-date').value = '';
document.getElementById('place-order-btn').click();
assert('pickup date still required after name/phone/item restored', document.getElementById('field-pickup-date').classList.contains('invalid'));
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

// Successful place — shows the on-page confirmation; nothing is opened or navigated to.
const opened = [];
w.open = function (u) { opened.push(String(u)); };

w.selectPickupDate('2026-11-29');
// Sheets URL is configured: post to /api/order, show the confirmation screen.
let postCalled = false;
window.fetch = (...args) => {
  const url = String(args[0] || '');
  const opts = args[1] || {};
  if (String(opts.method || 'GET').toUpperCase() === 'POST') postCalled = true;
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, status: 'saved' }) });
};

await w.placeOrder();
assert('placing an order shows the confirmation screen and opens nothing', confirmShown() && confirmTitle() === 'Order placed' && opened.length === 0, confirmTitle() + ' ' + opened.join(','));
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

assert('confirmation shows the order id', /^PB-\d{6}-[A-Z2-9]{4}$/.test(document.getElementById('confirm-order-id').textContent), document.getElementById('confirm-order-id').textContent);
assert('confirmation shows the pickup date', document.getElementById('confirm-pickup').textContent.includes('Sun, 29 Nov') && !/Mass/.test(document.getElementById('confirm-pickup').textContent), document.getElementById('confirm-pickup').textContent);
assert('confirmation lists the cakes ordered',
  document.getElementById('confirm-lines').textContent.includes('Dates & Carrot Pudding (700g)') && document.getElementById('confirm-lines').textContent.includes('Rich Plum Cake (400g)'),
  document.getElementById('confirm-lines').textContent);
assert('confirmation shows the payment line', document.getElementById('confirm-payment').textContent === w.eval('PAYMENT_LINE'));

// "Place another order" resets the form and goes back to step 1
{
  const sentName = document.getElementById('buyer-name').value;
  const sentPhone = document.getElementById('buyer-phone').value;
  document.getElementById('place-another').click();
  assert('place another order: hides the confirmation', confirmView().hidden === true);
  assert('place another order: empties the cart', Array.from(document.querySelectorAll('.stepper .qty')).every((q) => q.textContent === '0') && /0 items/.test(document.getElementById('summary-count').textContent));
  assert('place another order: clears name and phone', document.getElementById('buyer-name').value === '' && document.getElementById('buyer-phone').value === '');
  assert('place another order: goes back to the first step', document.getElementById('tab-date').getAttribute('aria-selected') === 'true');
  assert('place another order: forgets the finished order id', !window.sessionStorage.getItem('poppinsCheckoutOrderId') && !window.sessionStorage.getItem('poppinsLastPlaced'));
  assert('place another order: the order button is usable again', document.getElementById('place-order-btn').disabled === false && document.getElementById('place-order-btn').textContent === 'Place order');
  // restore the details the following tests rely on
  document.getElementById('buyer-name').value = sentName || 'Asha Rao';
  document.getElementById('buyer-phone').value = sentPhone || '9876543210';
  w.selectPickupDate('2026-11-29');
  zeroCart();
  firstPlus.click();
  lastPlus.click();
}

// pageshow re-enables button
window.dispatchEvent(new window.Event('pageshow'));
assert('pageshow re-enables button', document.getElementById('place-order-btn').disabled === false);
assert('pageshow restores label', document.getElementById('place-order-btn').textContent === 'Place order');

// Invalid phone after +91 strip leaving bad number
document.getElementById('buyer-phone').value = '12345';
document.getElementById('place-order-btn').click();
assert('rejects short phone', document.getElementById('field-phone').classList.contains('invalid'));

// ---- Atomic reserve + idempotency ----
document.getElementById('buyer-phone').value = '9876543210';
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

// Pre-order: a server "insufficient" response does not block the order or clamp the cart.
w.hideOrderConfirmation();
window.fetch = async function (url, opts) {
  opts = opts || {};
  return {
    ok: true,
    json: async () => ({ ok: false, status: 'insufficient', remaining: nov29Remaining(0) })
  };
};
await w.placeOrder();
assert('pre-order still ends on the confirmation (saved on this phone) if the server mentions stock', confirmShown() && /Order saved/.test(confirmTitle()), confirmTitle());
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
assert('outbox retries are marked retry:true so the server skips the stock check', bodies.length >= 1 && bodies.every((b) => b.retry === true), JSON.stringify(bodies.map((b) => b.retry)));
assert('retry flush POSTs the same order id', bodies.length >= 1 && bodies[0].orderId === idAfterFirstQueue,
  JSON.stringify(bodies.map((b) => b.orderId)) + ' kept=' + idAfterFirstQueue);
assert('confirmed flush clears the outbox',
  typeof w.readOrderOutbox !== 'function' || w.readOrderOutbox().length === 0,
  typeof w.readOrderOutbox === 'function' ? JSON.stringify(w.readOrderOutbox()) : 'no reader');

// duplicate also confirms (idempotent success)
window.dispatchEvent(new window.Event('pageshow'));
w.hideOrderConfirmation();
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-DUP1'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.selectPickupDate('2026-11-29');
w.__setStockForTest(nov29Remaining(15));
window.fetch = async function () {
  return { ok: true, json: async () => ({ ok: true, status: 'duplicate', orderId: 'PB-261123-DUP1' }) };
};
await w.placeOrder();
assert('duplicate is ok and shows the Order placed confirmation', confirmShown() && confirmTitle() === 'Order placed', confirmTitle());
assert('duplicate confirmation uses the same order id', document.getElementById('confirm-order-id').textContent === 'PB-261123-DUP1', document.getElementById('confirm-order-id').textContent);

// Network failure: the confirmation still shows instantly (saved on this phone); the outbox keeps the order for retry.
window.dispatchEvent(new window.Event('pageshow'));
w.hideOrderConfirmation();
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-FB01'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.__setStockForTest(nov29Remaining(15));
w.selectPickupDate('2026-11-29');
const timeoutBodies = [];
window.fetch = async function (url, opts) {
  opts = opts || {};
  if (opts.body) timeoutBodies.push(JSON.parse(opts.body));
  throw new Error('hang');
};
await w.placeOrder();
assert('timeout still shows the saved-on-this-phone confirmation immediately', confirmShown() && /Order saved/.test(confirmTitle()), confirmTitle());
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
document.getElementById('buyer-name').value = 'Asha Rao';
document.getElementById('buyer-phone').value = '9876543210';
zeroCart();
firstPlus.click();
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-Q1'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
w.hideOrderConfirmation();
window.fetch = async function () { throw new Error('offline'); };
await w.placeOrder();
window.dispatchEvent(new window.Event('pageshow'));
try { window.sessionStorage.setItem('poppinsCheckoutOrderId', 'PB-261123-Q2'); window.sessionStorage.removeItem('poppinsLastPlaced'); } catch (e) {}
zeroCart();
firstPlus.click();
w.selectPickupDate('2026-11-29');
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


// ---- Netlify /api/order flow: order is saved, no contact is assigned ----
{
  try { window.localStorage.removeItem('poppinsOrderOutbox'); window.sessionStorage.clear(); } catch (e) {}
  w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
  window.dispatchEvent(new window.Event('pageshow'));
  w.hideOrderConfirmation();
  document.getElementById('buyer-name').value = 'Asha Rao';
  document.getElementById('buyer-phone').value = '9876543210';
  zeroCart();
  firstPlus.click();
  w.selectPickupDate('2026-11-29');
  const apiCalls = [];
  const sheetCalls = [];
  window.fetch = async function (url, opts) {
    opts = opts || {};
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url) === '/api/order') {
      apiCalls.push(body);
      return { ok: true, json: async () => ({ ok: true, status: apiCalls.length > 1 ? 'duplicate' : 'queued', orderId: body.orderId }) };
    }
    sheetCalls.push(body);
    return { ok: true, json: async () => ({ ok: true, status: 'saved' }) };
  };
  await w.placeOrder();
  assert('api: POSTs the order to /api/order', apiCalls.length === 1 && /^PB-/.test(apiCalls[0].orderId), JSON.stringify(apiCalls));
  assert('api: does not post to Apps Script from the browser', sheetCalls.length === 0, JSON.stringify(sheetCalls));
  assert('api: the first send does not carry the retry flag', !('retry' in apiCalls[0]) && !('fallback' in apiCalls[0]), JSON.stringify(Object.keys(apiCalls[0])));
  assert('api: the order has no contact assignment, no mass and no WhatsApp fields',
    !('assignedContactId' in apiCalls[0]) && !('assignedTo' in apiCalls[0]) && !('assignedNumber' in apiCalls[0]) && !('contact' in apiCalls[0]) && !('mass' in apiCalls[0]) && !('massLabel' in apiCalls[0]),
    JSON.stringify(Object.keys(apiCalls[0])));
  assert('api: the page payment line is the same plain sentence for everyone',
    document.getElementById('payment-note').textContent === 'Payment: ' + w.eval('PAYMENT_LINE'), document.getElementById('payment-note').textContent);
  assert('api: the confirmation screen is shown with the order id',
    confirmShown() && confirmTitle() === 'Order placed' && document.getElementById('confirm-order-id').textContent === apiCalls[0].orderId, confirmTitle());
  assert('api: no WhatsApp or other window was opened', opened.length === 0, opened.join(','));
  assert('api: button says Order placed', document.getElementById('place-order-btn').textContent === 'Order placed');
  assert('api: nothing left in the browser outbox', w.readOrderOutbox().length === 0, JSON.stringify(w.readOrderOutbox()));

  // Re-tap with the same cart/details → same order id (server answers duplicate)
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

  // Function unreachable (e.g. plain drag-and-drop deploy → 404): outbox → Apps Script, no contact
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
  w.hideOrderConfirmation();
  await w.placeOrder();
  assert('fallback: the confirmation shows the saved-on-this-phone variant', confirmShown() && /Order saved/.test(confirmTitle()), confirmTitle());
  await new Promise((r) => setTimeout(r, 40));
  await w.flushOrderOutbox({ force: true });
  assert('fallback: order goes straight to Apps Script without any contact fields',
    direct.some((d) => d.url.includes('script.google.com') && /^PB-/.test(d.body.orderId) && !('assignedTo' in d.body) && !('assignedContactId' in d.body) && !('assignedNumber' in d.body) && d.body.retry === true),
    JSON.stringify(direct.map((d) => [d.url, Object.keys(d.body)])));
  assert('fallback: outbox clears after the Sheet confirms', w.readOrderOutbox().length === 0, JSON.stringify(w.readOrderOutbox()));

  // Outbox retry prefers /api/order; old queued entries lose their contact fields
  try { window.localStorage.removeItem('poppinsOrderOutbox'); window.sessionStorage.clear(); } catch (e) {}
  window.dispatchEvent(new window.Event('pageshow'));
  window.fetch = async function () { throw new Error('offline'); };
  await w.placeOrder();
  const queuedHint = w.readOrderOutbox()[0];
  assert('offline: order is queued without any contact fields', !!(queuedHint && queuedHint.order) && !('assignedContactId' in queuedHint.order) && !('assignedTo' in queuedHint.order), JSON.stringify(queuedHint));
  // an entry queued by the old page (with contact + mass fields) is cleaned when read
  window.localStorage.setItem('poppinsOrderOutbox', JSON.stringify([{ order: Object.assign({}, queuedHint.order, { orderId: 'PB-261123-OLD1', assignedContactId: 'aashwin', assignedTo: 'Aashwin Alfy', assignedNumber: '+91 80507 64341', mass: '06:30', massLabel: '6:30 AM Mass', contact: { id: 'aashwin' } }), queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0 }]));
  const retried = [];
  window.fetch = async function (url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    retried.push({ url: String(url), body });
    return { ok: true, json: async () => ({ ok: true, status: 'queued', orderId: body.orderId }) };
  };
  await w.flushOrderOutbox({ force: true });
  assert('offline retry: goes to /api/order first and sends no contact or mass fields',
    retried.length === 1 && retried[0].url === '/api/order' && retried[0].body.orderId === 'PB-261123-OLD1' &&
    retried[0].body.retry === true && !('assignedContactId' in retried[0].body) && !('assignedTo' in retried[0].body) && !('assignedNumber' in retried[0].body) && !('contact' in retried[0].body) && !('mass' in retried[0].body) && !('massLabel' in retried[0].body),
    JSON.stringify(retried.map((r) => [r.url, Object.keys(r.body)])));
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
w.showOrderConfirmation(payloadFri);
assert('confirmation uses the Friday short label', document.getElementById('confirm-pickup').textContent.includes('Fri, 25 Dec') && !/Mass/.test(document.getElementById('confirm-pickup').textContent), document.getElementById('confirm-pickup').textContent);
assert('Friday confirmation has the payment line', document.getElementById('confirm-payment').textContent.includes('Pay at pickup, or UPI to +91 72040 17793 (Cyril Martin)'), document.getElementById('confirm-payment').textContent);
w.hideOrderConfirmation();

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
document.getElementById('buyer-name').value = 'Asha';
document.getElementById('buyer-phone').value = '9876543210';
zeroCart();
firstPlus.click();
window.dispatchEvent(new window.Event('pageshow'));
document.getElementById('pickup-date').value = '2026-12-25';
w.hideOrderConfirmation();
await w.placeOrder();
assert('invalid_date does not place an order or show the confirmation', !confirmShown());
assert('invalid_date shows a date message', /not available|Pick a pickup date/i.test(
    (document.getElementById('field-pickup-date')?.textContent || '') +
    (document.getElementById('cart-error').textContent || '') +
    (document.getElementById('checkout-alert')?.textContent || '')
  ),
  document.getElementById('field-pickup-date')?.textContent + ' | ' + document.getElementById('cart-error').textContent);
assert('invalid_date leaves the button enabled', document.getElementById('place-order-btn').disabled === false &&
  document.getElementById('place-order-btn').textContent === 'Place order');

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
// Styling is Tailwind: palette lives in the @theme block of src/tailwind.css,
// layout lives in utility classes on the markup.
const themeCss = fs.readFileSync(ROOT + '/src/tailwind.css', 'utf8');
const rootCss = themeCss + (document.querySelector('style')?.textContent || '');
const appCls = document.querySelector('.app').className;
const menuCls = document.getElementById('menu-list').className;
assert('page links the compiled Tailwind stylesheet', html.includes(TAILWIND_LINK));
assert('Tailwind theme defines extracted palette tokens',
  /--color-maroon:\s*#7a0a10/.test(themeCss) &&
  /--color-gold:\s*#c27b13/.test(themeCss) &&
  /--color-cream:\s*#f7ede5/.test(themeCss) &&
  /--color-brand-blue:\s*#0544b3/.test(themeCss) &&
  /--color-ink:\s*#2a2306/.test(themeCss) &&
  /--color-pine:\s*#435718/.test(themeCss),
  'missing token in @theme');
assert('old festive red #b91c1c is gone', !/#b91c1c/i.test(rootCss + document.documentElement.outerHTML));
assert('page background is #fbf9f5', /--color-page:\s*#fbf9f5/.test(themeCss) && document.body.className.includes('bg-page'));
assert('app uses padding (no outer margin), full height below the bar', /(^|\s)px-3(\s|$)/.test(appCls) && appCls.includes('lg:p-4') && appCls.includes('min-h-[calc(100vh-var(--topbar-h))]') && !/(^|\s)(lg:)?mx-/.test(appCls), appCls);
assert('desktop left column is minmax(340px, 32%)', appCls.includes('lg:grid-cols-[minmax(340px,32%)_minmax(0,1fr)]'), appCls);
assert('wide desktop summary is minmax(300px, 22%)', appCls.includes('xl:grid-cols-[minmax(340px,32%)_minmax(0,1fr)_minmax(300px,22%)]'), appCls);
assert('menu grid fills with auto-fill 260px', menuCls.includes('lg:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]'), menuCls);
assert('xl (1280px) breakpoint puts the summary in a third column',
  document.querySelector('.sticky-bar').className.includes('xl:col-start-3'));
assert('CTA says Place order with a check icon and no WhatsApp', document.getElementById('place-order-btn').textContent === 'Place order' && /\.cta::before/.test(html) && !/25D366/i.test(rawIndexHtml) && !/aria-label="[^"]*whatsapp/i.test(rawIndexHtml));

// ---- Stock limits: out of stock, caps, clamp, 409, pre-submit refresh ----
{
  const DC = 'Dates & Carrot Pudding (700g)';
  const BS = 'Butterscotch Pudding (700g)';
  const PL = 'Rich Plum Cake (400g)';
  const stockDates = (remaining29) => [
    { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30', remaining: remaining29 },
    { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: '2026-12-06T08:30:00+05:30' },
    { id: '2026-12-13', label: 'Sun, 13 Dec', closesAt: '2026-12-13T08:30:00+05:30', remaining: { [PL]: null } }
  ];
  window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
  w.loadStock = async function () {};
  w.__setStockForTest({}, 'ok', stockDates({ [DC]: 3, [PL]: 0, [BS]: 12 }));
  w.selectPickupDate('2026-11-29');
  zeroCart();
  const bsCard = cards[2];
  const plumCard = cards[5];
  const note = (c) => c.querySelector('.stock-note');

  assert('stock: sold-out cake is dimmed (sold-out class)', plumCard.classList.contains('sold-out'));
  assert('stock: sold-out note says Out of stock and next batch',
    !note(plumCard).hidden && /Out of stock/.test(note(plumCard).textContent) && /More will arrive in the next batch/.test(note(plumCard).textContent),
    note(plumCard).textContent);
  assert('stock: plus is disabled when out of stock', plumCard.querySelector('.plus').disabled === true);
  lastPlus.click();
  assert('stock: cannot add an out-of-stock cake', plumCard.querySelector('.qty').textContent === '0');

  for (let i = 0; i < 6; i++) firstPlus.click();
  assert('stock: stepper is capped at the remaining count', cards[0].querySelector('.qty').textContent === '3', cards[0].querySelector('.qty').textContent);
  assert('stock: plus disabled at the cap', cards[0].querySelector('.plus').disabled === true);
  assert('stock: low stock shows "Only N left"', /Only 3 left/.test(note(cards[0]).textContent), note(cards[0]).textContent);
  assert('stock: low-stock cake is not marked sold-out', !cards[0].classList.contains('sold-out'));
  assert('stock: a bigger remainder shows no note', note(bsCard).hidden === true && note(bsCard).textContent === '', note(bsCard).textContent);
  for (let i = 0; i < 15; i++) bsCard.querySelector('.plus').click();
  assert('stock: cap applies to larger remainders too (12)', bsCard.querySelector('.qty').textContent === '12', bsCard.querySelector('.qty').textContent);

  // unlimited date: no label, no cap
  w.selectPickupDate('2026-12-06');
  assert('stock: date without limits clears labels and sold-out', !plumCard.classList.contains('sold-out') && note(plumCard).hidden === true);
  assert('stock: unlimited remaining is Infinity', w.remainingForItem({ name: 'Rich Plum Cake', weight: '400g' }, '2026-12-06') === Infinity);
  assert('stock: plus is enabled again on an unlimited date', plumCard.querySelector('.plus').disabled === false);
  assert('stock: cart within limits is untouched on switch', cards[0].querySelector('.qty').textContent === '3');
  for (let i = 0; i < 4; i++) firstPlus.click();
  assert('stock: unlimited date has no cap', cards[0].querySelector('.qty').textContent === '7', cards[0].querySelector('.qty').textContent);

  // null remaining = unlimited too
  w.selectPickupDate('2026-12-13');
  assert('stock: null remaining is unlimited', w.remainingForItem({ name: 'Rich Plum Cake', weight: '400g' }) === Infinity && !plumCard.classList.contains('sold-out'));

  // switching back to the limited date clamps the cart and tells the customer
  document.getElementById('toast').classList.remove('visible');
  w.selectPickupDate('2026-11-29');
  assert('stock: cart is clamped when switching to a limited date', cards[0].querySelector('.qty').textContent === '3', cards[0].querySelector('.qty').textContent);
  assert('stock: clamp shows a toast', document.getElementById('toast').classList.contains('visible') && /only 3 left/i.test(document.getElementById('toast').textContent),
    document.getElementById('toast').textContent);
  assert('stock: summary reflects the clamped cart', /3\s*×/.test(document.getElementById('cart-lines').textContent));

  // fail open: stock unknown -> no limits
  w.__setStockForTest({}, 'error');
  assert('stock: fetch failure leaves cakes unlimited', !plumCard.classList.contains('sold-out') && plumCard.querySelector('.plus').disabled === false);

  // ---- checkout: 409 from /api/order -> modal, no confirmation ----
  w.__setStockForTest({}, 'ok', stockDates({ [DC]: 5, [PL]: 5 }));
  w.selectPickupDate('2026-11-29');
  zeroCart();
  firstPlus.click();
  document.getElementById('buyer-name').value = 'Asha Rao';
  document.getElementById('buyer-phone').value = '9876543210';
  try { window.sessionStorage.clear(); window.localStorage.clear(); } catch (e) {}
  w.hideOrderConfirmation();
  const realFetch = window.fetch;
  let orderPosts = 0;
  window.fetch = async function (url) {
    if (String(url).indexOf('/api/order') >= 0) {
      orderPosts++;
      return {
        ok: false, status: 409,
        json: async () => ({ ok: false, error: 'out_of_stock', items: [DC] })
      };
    }
    throw new Error('unexpected ' + url);
  };
  await w.placeOrder();
  const stockAlert = document.getElementById('form-alert');
  assert('stock 409: opens the custom alertdialog', stockAlert.classList.contains('is-open') && stockAlert.hidden === false &&
    document.getElementById('form-alert-dialog').getAttribute('role') === 'alertdialog');
  assert('stock 409: title is Out of stock', document.getElementById('form-alert-title').textContent === 'Out of stock');
  assert('stock 409: names the cake and the next batch',
    /Dates & Carrot Pudding \(700g\)/.test(stockAlert.textContent) && /next batch/.test(stockAlert.textContent), stockAlert.textContent);
  assert('stock 409: no confirmation screen is shown', !confirmShown());
  assert('stock 409: no fallback outbox entry is queued', !window.localStorage.getItem('poppinsOrderOutbox') || window.localStorage.getItem('poppinsOrderOutbox') === '[]');
  assert('stock 409: order is not shown as placed', !confirmShown() && !/PB-X/.test(document.getElementById('confirm-order-id').textContent));
  assert('stock 409: button is usable again', document.getElementById('place-order-btn').disabled === false &&
    document.getElementById('place-order-btn').textContent === 'Place order', document.getElementById('place-order-btn').textContent);
  assert('stock 409: only one API call, no direct-to-Sheet fallback', orderPosts === 1, String(orderPosts));
  w.closeFormAlert();

  // ---- checkout: pre-submit stock refresh blocks a stale cart ----
  w.__setStockForTest({}, 'ok', stockDates({ [DC]: 5, [PL]: 5 }));
  w.selectPickupDate('2026-11-29');
  zeroCart();
  firstPlus.click();
  firstPlus.click();
  window.__TEST_DISABLE_NETWORK = false;
  orderPosts = 0;
  let stockGets = 0;
  window.fetch = async function (url) {
    if (String(url).indexOf('action=stock') >= 0) {
      stockGets++;
      return { ok: true, status: 200, json: async () => ({ ok: true, dates: stockDates({ [DC]: 1, [PL]: 5 }) }) };
    }
    if (String(url).indexOf('/api/order') >= 0) orderPosts++;
    throw new Error('should not post: ' + url);
  };
  await w.placeOrder();
  assert('stock refresh: re-fetched stock before submitting', stockGets === 1, String(stockGets));
  assert('stock refresh: stale cart is stopped with the Out of stock alert',
    document.getElementById('form-alert').classList.contains('is-open') && document.getElementById('form-alert-title').textContent === 'Out of stock');
  assert('stock refresh: no order was posted and no confirmation shown', orderPosts === 0 && !confirmShown());
  assert('stock refresh: cart is clamped to what is left', cards[0].querySelector('.qty').textContent === '1', cards[0].querySelector('.qty').textContent);
  w.closeFormAlert();

  // refresh failing must not block ordering (fail open)
  window.fetch = async function (url) {
    if (String(url).indexOf('action=stock') >= 0) throw new Error('stock down');
    if (String(url).indexOf('/api/order') >= 0) {
      orderPosts++;
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'queued', orderId: 'PB-X' }) };
    }
    throw new Error('unexpected ' + url);
  };
  await w.placeOrder();
  assert('stock refresh: fails open when stock cannot be read', orderPosts === 1 && confirmShown() && confirmTitle() === 'Order placed', orderPosts + '/' + confirmTitle());
  w.hideOrderConfirmation();

  window.__TEST_DISABLE_NETWORK = true;
  window.fetch = realFetch;
  w.__setStockForTest({}, 'ok', null);
  zeroCart();
}

// ---- Fast stock loading: cached first paint, /api/stock first, background refresh ----
{
  const DC = 'Dates & Carrot Pudding (700g)';
  const mk = (dc) => [
    { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30', remaining: { [DC]: dc } },
    { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: '2026-12-06T08:30:00+05:30' }
  ];
  const KEY = w.__stockCacheKey();
  const realFetchFast = window.fetch;
  const urls = [];
  const ok = (dates) => ({ ok: true, status: 200, json: async () => ({ ok: true, dates }) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__TEST_NOW = new Date('2026-11-23T12:00:00+05:30');
  w.__setSheetsUrlForTest('https://script.google.com/macros/s/TEST/exec');
  w.__setStockForTest({}, 'ok', null);
  w.selectPickupDate('2026-11-29');
  zeroCart();

  // 1. last good stock paints instantly, before any network
  window.localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), dates: mk(0) }));
  assert('fast stock: cached stock is applied without network', w.__applyCachedStockForTest() === true);
  assert('fast stock: cached 0 greys the cake out immediately', cards[0].classList.contains('sold-out') && /Out of stock/.test(cards[0].textContent));
  assert('fast stock: the selected date is kept', document.getElementById('pickup-date').value === '2026-11-29');

  // 2. stale / corrupt cache is ignored
  window.localStorage.setItem(KEY, JSON.stringify({ at: Date.now() - 31 * 60 * 1000, dates: mk(0) }));
  assert('fast stock: a cache older than 30 minutes is ignored', w.__applyCachedStockForTest() === false);
  window.localStorage.setItem(KEY, '{not json');
  assert('fast stock: a corrupt cache is ignored', w.__applyCachedStockForTest() === false);

  // 3. /api/stock is tried first and the result is cached
  w.__setStockForTest({}, 'ok', mk(0));
  window.localStorage.removeItem(KEY);
  window.__TEST_DISABLE_NETWORK = false;
  window.fetch = async function (url) {
    urls.push(String(url));
    if (String(url).indexOf('/api/stock') >= 0) return ok(mk(5));
    throw new Error('unexpected ' + url);
  };
  await w.__loadPickupDatesForTest({ silent: true });
  assert('fast stock: asks /api/stock first, not Apps Script', urls.length === 1 && /\/api\/stock$/.test(urls[0]), JSON.stringify(urls));
  assert('fast stock: fresh numbers replace the cached ones', !cards[0].classList.contains('sold-out'));
  const saved = JSON.parse(window.localStorage.getItem(KEY) || 'null');
  assert('fast stock: the good payload is saved for the next visit', saved && saved.dates.length === 2 && typeof saved.at === 'number');

  // 4. falls back to Apps Script when /api/stock is unavailable
  urls.length = 0;
  window.fetch = async function (url) {
    urls.push(String(url));
    if (String(url).indexOf('/api/stock') >= 0) return { ok: false, status: 502, json: async () => ({ ok: false }) };
    if (String(url).indexOf('action=stock') >= 0) return ok(mk(0));
    throw new Error('unexpected ' + url);
  };
  await w.__loadPickupDatesForTest({ silent: true });
  assert('fast stock: falls back to Apps Script when /api/stock fails',
    urls.length === 2 && /\/api\/stock$/.test(urls[0]) && /script\.google\.com.*action=stock/.test(urls[1]), JSON.stringify(urls));
  assert('fast stock: fallback data is applied', cards[0].classList.contains('sold-out'));

  // 5. pre-submit refresh bypasses caches, and is skipped when stock is already fresh
  urls.length = 0;
  window.fetch = async function (url) {
    urls.push(String(url));
    if (String(url).indexOf('/api/stock') >= 0) return ok(mk(5));
    throw new Error('unexpected ' + url);
  };
  w.stockState.fetchedAt = 0;
  await w.refreshStockBeforeSubmit();
  assert('fast stock: pre-submit refresh asks for fresh=1', urls.length === 1 && /fresh=1/.test(urls[0]), JSON.stringify(urls));
  await w.refreshStockBeforeSubmit();
  assert('fast stock: pre-submit refresh is skipped when stock was just read', urls.length === 1, JSON.stringify(urls));

  // 6. background refresh: when the tab becomes visible again
  urls.length = 0;
  const handle = w.__startStockRefreshForTest();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  await sleep(30);
  assert('fast stock: nothing is fetched while the tab is hidden', urls.length === 0, JSON.stringify(urls));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  await sleep(30);
  assert('fast stock: stock is re-fetched (fresh) when the tab is visible again', urls.length === 1 && /fresh=1/.test(urls[0]), JSON.stringify(urls));
  handle.stop();

  // 7. a refresh that shrinks stock below the cart tells the customer
  w.__setStockForTest({}, 'ok', mk(null));
  w.selectPickupDate('2026-11-29');
  zeroCart();
  cards[0].querySelector('.plus').click();
  cards[0].querySelector('.plus').click();
  window.fetch = async function (url) {
    if (String(url).indexOf('/api/stock') >= 0) return ok(mk(1));
    throw new Error('unexpected ' + url);
  };
  await w.__loadPickupDatesForTest({ fresh: true });
  assert('fast stock: background refresh clamps the cart and keeps the date',
    cards[0].querySelector('.qty').textContent === '1' && document.getElementById('pickup-date').value === '2026-11-29', cards[0].querySelector('.qty').textContent);
  assert('fast stock: the customer is told the cart changed', /Cart updated/.test(document.getElementById('toast').textContent), document.getElementById('toast').textContent);

  window.__TEST_DISABLE_NETWORK = true;
  window.fetch = realFetchFast;
  window.localStorage.removeItem(KEY);
  w.__setSheetsUrlForTest('');
  w.__setStockForTest({}, 'ok', null);
  zeroCart();
}

// ---- Three-step tabs: Pickup date | Cakes | Your details ----
{
  w.closeFormAlert();
  w.resetSubmitButton();
  zeroCart();
  const ids = ['date', 'cakes', 'details'];
  const tab = (n) => document.getElementById('tab-' + n);
  const panel = (n) => document.getElementById('panel-' + n);
  const selected = () => ids.filter((n) => tab(n).getAttribute('aria-selected') === 'true').join(',');
  const visible = () => ids.filter((n) => !panel(n).hidden).join(',');
  w.selectPickupDate('2026-11-29');
  w.setOrderTab('date');

  const bar = document.getElementById('order-tabs');
  assert('steps: three tabs in a tablist', bar.getAttribute('role') === 'tablist' && bar.querySelectorAll('[role="tab"]').length === 3);
  assert('steps: tab order is Pickup date, Cakes, Your details',
    /Pickup date/.test(tab('date').textContent) && /Cakes/.test(tab('cakes').textContent) && /Your details/.test(tab('details').textContent));
  assert('steps: all panels are tabpanels wired to their tabs',
    ids.every((n) => panel(n).getAttribute('role') === 'tabpanel' && panel(n).getAttribute('aria-labelledby') === 'tab-' + n && tab(n).getAttribute('aria-controls') === 'panel-' + n));
  assert('steps: starts on Pickup date only', selected() === 'date' && visible() === 'date', selected() + '/' + visible());
  assert('steps: date chips live in the first tab', !!panel('date').querySelector('#date-chips') && !panel('date').querySelector('#menu-list'));
  assert('steps: cake list lives in the second tab', !!panel('cakes').querySelector('#menu-list') && !!panel('cakes').querySelector('#cart-error'));
  assert('steps: name and phone live in the third tab, inside the one #order-form',
    !!panel('details').querySelector('#order-form #buyer-name') && !!panel('details').querySelector('#order-form #buyer-phone') && document.querySelectorAll('form').length === 1);
  assert('steps: unselected tabs are out of the tab order', tab('cakes').tabIndex === -1 && tab('details').tabIndex === -1 && tab('date').tabIndex === 0);

  tab('cakes').click();
  assert('steps: clicking Cakes shows only its panel', selected() === 'cakes' && visible() === 'cakes', selected() + '/' + visible());
  tab('details').click();
  assert('steps: clicking Your details shows only its panel', selected() === 'details' && visible() === 'details');
  const key = (k) => bar.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('Home');
  assert('steps: Home goes to the first tab', selected() === 'date');
  key('ArrowRight');
  assert('steps: ArrowRight goes to the next tab', selected() === 'cakes');
  key('End');
  assert('steps: End goes to the last tab', selected() === 'details');
  key('ArrowRight');
  assert('steps: ArrowRight wraps to the first tab', selected() === 'date');
  key('ArrowLeft');
  assert('steps: ArrowLeft wraps to the last tab', selected() === 'details');
  w.setOrderTab('date');

  // Consistent nav buttons
  const nexts = [...document.querySelectorAll('.step-next')];
  const backs = [...document.querySelectorAll('.step-back')];
  assert('nav: 2 Next buttons and 2 Back buttons, one row per panel', nexts.length === 2 && backs.length === 2 && document.querySelectorAll('.step-nav').length === 3);
  assert('nav: every Next shares one style, every Back shares another',
    new Set(nexts.map((b) => b.className)).size === 1 && new Set(backs.map((b) => b.className)).size === 1);
  assert('nav: buttons are at least 48px tall', nexts.concat(backs).every((b) => /min-h-12/.test(b.className)));
  assert('nav: labels are Next and Back', nexts.every((b) => /^Next/.test(b.textContent.trim())) && backs.every((b) => /Back$/.test(b.textContent.trim())));
  assert('nav: first step has Next only', !!panel('date').querySelector('#next-to-cakes') && !panel('date').querySelector('.step-back'));
  assert('nav: middle step has Back and Next', !!panel('cakes').querySelector('#back-to-date') && !!panel('cakes').querySelector('#next-to-details'));
  assert('nav: last step has Back only (the order bar is the CTA)', !!panel('details').querySelector('#back-to-cakes') && !panel('details').querySelector('.step-next'));
  assert('nav: the order bar and summary sit outside the tab panels', !ids.some((n) => panel(n).contains(document.getElementById('place-order-btn'))));

  // Gating: Next needs a date, then a cake
  document.getElementById('pickup-date').value = '';
  document.getElementById('next-to-cakes').click();
  assert('gate: Next without a date stays on step 1 with an inline error',
    selected() === 'date' && document.getElementById('field-pickup-date').classList.contains('invalid'));
  w.selectPickupDate('2026-11-29');
  document.getElementById('next-to-cakes').click();
  assert('gate: with a date, Next goes to Cakes', selected() === 'cakes');
  document.getElementById('next-to-details').click();
  assert('gate: Next with an empty cart stays on Cakes and shows the cart error',
    selected() === 'cakes' && document.getElementById('cart-error').classList.contains('visible') && /at least one cake/.test(document.getElementById('cart-error').textContent));
  cards[0].querySelector('.plus').click();
  cards[1].querySelector('.plus').click();
  cards[1].querySelector('.plus').click();
  assert('badge: the Cakes tab shows how many cakes are selected', document.getElementById('tab-cakes-badge').textContent === '3' && !document.getElementById('tab-cakes-badge').classList.contains('hidden'));
  document.getElementById('next-to-details').click();
  assert('gate: with a cake, Next goes to Your details', selected() === 'details');
  document.getElementById('back-to-cakes').click();
  assert('nav: Back returns to Cakes', selected() === 'cakes');
  document.getElementById('back-to-date').click();
  assert('nav: Back returns to Pickup date', selected() === 'date');

  // Place Order with problems jumps to the tab that needs fixing
  document.getElementById('buyer-name').value = '';
  document.getElementById('buyer-phone').value = '';
  w.setOrderTab('cakes');
  document.getElementById('place-order-btn').click();
  assert('errors: missing name/phone jumps to Your details with a dot on that tab', selected() === 'details' && !document.getElementById('tab-details-dot').classList.contains('hidden') && document.getElementById('tab-date-dot').classList.contains('hidden'));
  w.closeFormAlert();
  assert('errors: closing the alert focuses the first invalid field', document.activeElement === document.getElementById('buyer-name'), document.activeElement && document.activeElement.id);
  zeroCart();
  w.setOrderTab('details');
  document.getElementById('place-order-btn').click();
  assert('errors: an empty cart jumps to Cakes', selected() === 'cakes' && !document.getElementById('tab-cakes-dot').classList.contains('hidden'), selected());
  w.closeFormAlert();
  document.getElementById('pickup-date').value = '';
  w.setOrderTab('details');
  document.getElementById('place-order-btn').click();
  assert('errors: a missing date jumps to Pickup date first', selected() === 'date' && !document.getElementById('tab-date-dot').classList.contains('hidden'), selected());
  w.closeFormAlert();
  w.selectPickupDate('2026-11-29');
  w.setOrderTab('date');
  zeroCart();

  // Mass time is gone from the order
  cards[0].querySelector('.plus').click();
  document.getElementById('buyer-name').value = 'Asha Rao';
  document.getElementById('buyer-phone').value = '9876543210';
  const payload = w.buildOrderPayload();
  assert('payload has no mass or massLabel', !('mass' in payload) && !('massLabel' in payload), JSON.stringify(Object.keys(payload)));
  assert('payload still has the pickup date', payload.pickupDate === '2026-11-29' && !!payload.pickupDateShort);
  window.localStorage.setItem('poppinsOrderOutbox', JSON.stringify([{ order: { orderId: 'PB-OLD-MASS1', name: 'Old', phone: '9876543210', pickupDate: '2026-11-29', mass: '06:30', massLabel: '6:30 AM Mass', items: [] }, attempts: 0, nextAttemptAt: 0 }]));
  const oldEntry = w.readOrderOutbox().find((e) => e.order.orderId === 'PB-OLD-MASS1');
  assert('old queued orders have their mass fields ignored', oldEntry && !('mass' in oldEntry.order) && !('massLabel' in oldEntry.order) && oldEntry.order.pickupDate === '2026-11-29');
  window.localStorage.removeItem('poppinsOrderOutbox');
  zeroCart();
  document.getElementById('buyer-name').value = '';
  document.getElementById('buyer-phone').value = '';
}

// ---- Renamed to Vailankanni Matha Youth ----
assert('rename: no visible or meta text still says Parish Youth', !/Parish Youth/.test(document.documentElement.outerHTML.replace(/alt="[^"]*poster[^"]*"/i, '')));
assert('rename: header, title and description say Vailankanni Matha Youth',
  document.querySelector('header.hero-head h1').textContent === 'Vailankanni Matha Youth' && /Vailankanni Matha Youth/.test(document.title) && /Vailankanni Matha Youth/.test(document.querySelector('meta[name="description"]').content));
assert('rename: index.html no longer mentions WhatsApp anywhere', !/whatsapp/i.test(rawIndexHtml));

const failed = results.filter((r) => !r.ok);
console.log('\n--- ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) {
  console.error(failed);
  process.exit(1);
}
