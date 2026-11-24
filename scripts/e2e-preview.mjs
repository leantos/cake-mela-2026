// E2E against `netlify dev` (http://localhost:8888): places an order in a
// mobile viewport, checks the WhatsApp hand-off, and saves screenshots.
// Requests to script.google.com are blocked so the live Sheet is never touched.
// Usage: node scripts/e2e-preview.mjs [baseUrl]   (needs puppeteer-core + Chrome)
import { createRequire } from 'module';
const require = createRequire(process.env.PUPPETEER_FROM || import.meta.url);
const puppeteer = require('puppeteer-core');
const base = process.argv[2] || 'http://localhost:8888/';
const out = new URL('..', import.meta.url).pathname;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setRequestInterception(true);
const wa = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('script.google.com')) return req.abort();
  if (u.includes('api.whatsapp.com') || u.includes('wa.me')) { wa.push(u); return req.respond({ status: 204, body: '' }); } // 204 keeps the page
  req.continue();
});
await page.evaluateOnNewDocument(() => { window.__TEST_NOW = new Date('2026-11-24T12:00:00+05:30'); });
await page.goto(base, { waitUntil: 'networkidle2' });
await page.screenshot({ path: out + 'preview-mobile-top.png' });

const results = [];
const check = (n, c, d) => { results.push(c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + (d || ''))); };
const enquire = await page.$eval('#enquire', (el) => el.textContent);
check('enquiries show both contacts', enquire.includes('Cyril Martin') && enquire.includes('Aashwin Alfy'), enquire);

// Add 1 × first cake + 2 × last cake, fill details
const plus = await page.$$('.menu-card button.plus');
if (plus.length) { await plus[0].click(); await plus[plus.length - 1].click(); await plus[plus.length - 1].click(); }
await page.type('#buyer-name', 'Preview Tester');
await page.type('#buyer-phone', '9876543210');
await page.click('#date-chips .date-chip');
await page.click('#mass-options .mass-option');
await page.click('#place-order-btn');
await new Promise((r) => setTimeout(r, 1500));
check('WhatsApp opened', wa.length === 1, JSON.stringify(wa));
const waUrl = new URL(wa[0] || 'https://x/');
const phone = waUrl.searchParams.get('phone');
const text = waUrl.searchParams.get('text') || '';
check('WhatsApp number is one of the two contacts', phone === '917204017793' || phone === '918050764341', phone);
const expectName = phone === '918050764341' ? 'Aashwin Alfy' : 'Cyril Martin';
check('message payment line matches the WhatsApp number', text.includes('UPI to ' + (phone === '918050764341' ? '+91 80507 64341' : '+91 72040 17793') + ' (' + expectName + ')'), text);
const confirm = await page.$eval('#order-confirm', (el) => (el.hidden ? '' : el.textContent));
const note = await page.$eval('#payment-note', (el) => el.textContent);
check('page shows order placed', /Order PB-\S+ placed/.test(confirm) && confirm.includes(expectName), confirm);
check('page payment line matches', note.includes(expectName), note);
await page.screenshot({ path: out + 'preview-mobile-placed.png' });
// Sticky bar close-up after placing
const bar = await page.$('.sticky-bar');
if (bar) await bar.screenshot({ path: out + 'preview-mobile-sticky.png' });
await browser.close();
console.log(results.every(Boolean) ? 'E2E OK' : 'E2E FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
