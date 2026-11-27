# Vailankanni Matha Youth × Poppins Bakers — Christmas cake pre-orders

Static order page + Netlify Functions queue + Google Sheets (Apps Script).

```
public/                 ← published site (Netlify "publish" dir)
  index.html            customer order page
  orders.html           order dashboard at /orders, behind the staff PIN (totals + pending orders list; /admin redirects here)
  staff.html            PIN-protected staff tools (status, walk-ins)
  site-config.js        ★ ONE settings file: poster, call contacts, the
                          built-in pickup dates (shown instantly), bulk
                          discount (50+ cakes = 10% off), Apps Script URL
  poster.jpg / .webp, logo.png
netlify/functions/
  order.mjs             POST /api/order  (GET = pending count)
  stock.mjs             GET /api/stock: dates + remaining stock, served from a
                          Blobs snapshot so it never waits on Apps Script
  summary.mjs           GET /api/summary: the /orders totals (aggregates only),
                          served from a Blobs snapshot the same way
  sweep-orders.mjs      every 5 min: re-send anything not yet in the Sheet and
                          refresh the stock and totals snapshots
netlify/lib/orders.mjs  validation, Blobs storage, forwarding
apps-script/Code.gs     paste into the Sheet's Apps Script editor
scripts/                update-poster.py, make-drop-zip.mjs, mock-apps-script.mjs, e2e-preview.mjs
tests/                  node tests (jsdom + local Blobs server + mock Sheet)
```

## How an order flows

1. The customer places the order. There is no WhatsApp step and orders are
   not assigned to anyone. The page POSTs to `/api/order`.
2. The function validates it and stores it in Netlify Blobs under its Order ID.
   If that Order ID was already stored, it returns the same answer as before.
   It replies in about 0.2 s with `{ ok, status, orderId }` (status is
   `queued` or `duplicate`).
3. The page shows the **Order placed** confirmation. The payment line is one
   plain sentence listing both UPI numbers.
4. While that happens, the function sends the order to the Apps Script,
   which writes it to the Sheet.
5. If the Sheet doesn't answer, the order stays pending in Blobs.
   `sweep-orders` retries it every 5 minutes, waiting 1, 2, 4 … up to 30
   minutes between tries. Apps Script ignores an Order ID it already has, so
   a retry never adds a second row.
6. If `/api/order` can't be reached, the page falls back to the old
   behaviour. This covers a Netlify Drop upload with no functions and
   being offline. The page keeps the order in its localStorage outbox and
   posts it directly to Apps Script. Each retry tries `/api/order` first and
   sends `retry: true`, so the server never rejects an order the customer was
   already told was placed (the Sheet flags OVERSOLD if stock ran out).

## Changing things later

Edit `public/site-config.js`, commit and push. Netlify redeploys in under a
minute.

- New poster: `python3 scripts/update-poster.py /path/to/poster.png`. This
  writes the optimised `poster.jpg` and `poster.webp` and updates the
  image size in the page.
- Contacts: edit the `contacts` list (name, `number` as digits with 91 in
  front, `display`). Orders rotate through the list in the order it's written.
- Payment line: edit `paymentLine` (`{number}`, `{name}`).
- Apps Script URL: edit `appsScriptUrl`, or set the `APPS_SCRIPT_URL`
  environment variable in Netlify. The variable only affects the function.

## Local development

```
npm install
npm test                                     # all unit tests
node scripts/mock-apps-script.mjs 8787 &     # fake Sheet
APPS_SCRIPT_URL=http://localhost:8787/exec npx netlify dev --offline
```
