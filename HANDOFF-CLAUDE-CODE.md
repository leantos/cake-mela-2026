# Handoff: Vailankanni Matha Youth × Poppins Bakers Christmas cake pre-order site

You are picking up an existing, working project. Read this fully, then `README.md`, before changing anything.

## What it is
- A Christmas cake pre-order fundraiser for Vailankanni Matha Youth with Poppins Bakers, at Vailankanni Matha Church, Muthanallur (Harohalli, Sarjapura Road, Bengaluru 560099).
- **Pickup only**, every Sunday from 29 Nov 2026, after the 6:30 AM or 8:30 AM Mass. There is no delivery.
- **Menu (₹):**
  - Dates & Carrot Pudding: 700g 650, 350g 330
  - Butterscotch Pudding: 700g 700, 350g 350
  - Rich Plum Cake: 800g 650, 400g 350
- **Contacts.** Orders alternate between two WhatsApp numbers:
  - Cyril Martin, 917204017793 (+91 72040 17793)
  - Aashwin Alfy, 918050764341 (+91 80507 64341)
- **Payment line:** "Pay at pickup, or UPI to {number} ({name})", filled in with whoever the order is assigned to. It appears both on the page and in the WhatsApp message.
- **Backend.** A Google Apps Script web app (`apps-script/Code.gs`) logs everything to the Google Sheet "VMY Cake Sales 2026".

## Architecture (current repo, branch `main`)
- `public/` is the static site that Netlify publishes (`netlify.toml`: publish `public`, functions `netlify/functions`, no build step).
  - `index.html`: the customer order page.
  - `orders.html` (served at `/orders`; `/admin` and `/admin.html` redirect to it): a read-only dashboard (noindex) behind the **staff PIN gate** (same `staff_login` / `staff_orders` protocol and the same `poppinsStaffPin` sessionStorage key as `staff.html`, so unlocking either page unlocks the other in that tab; Lock button; `?preview=1` shows example data with no gate and no network). Totals and orders only load after unlock. It shows "cakes to order" per date, ordered vs sold, sales cards, collapsible `<details>` sections per date, an all-dates matrix on desktop, Copy for Poppins, and an auto-refresh every 60s.
  - `staff.html`: a PIN-gated staff page. The Orders tab marks orders Pending / Paid / Picked up / Cancelled. The Walk-in tab records cash or UPI walk-in sales, with Undo. It has a localStorage outbox and refreshes every 30s.
  - `site-config.js`: **the one place for settings**. It holds the poster files and size, the contacts list (the order of the list is the alternation order), the payment line template, the Apps Script URL and `orderApiPath` `/api/order`. Pages use `window.SITE_CONFIG`, and the function imports it.
  - `logo.png`, `poster.jpg`, `poster.webp`: the new poster, 1024×1536.
- `netlify/functions/order.mjs`: handles POST `/api/order`. It validates the order and stores it in Netlify Blobs keyed by orderId (`onlyIfNew`, so it's idempotent). It assigns the next contact using a counter in Blobs with conditional writes; a resubmitted orderId gets the same contact back. It replies quickly with `{ok, orderId, contact}`, then forwards the order to Apps Script with `assignedTo`, `assignedContactId`, `assignedNumber` and `source:'netlify'`, and marks it sent. GET returns only `{ok, pending}`.
- `netlify/functions/sweep-orders.mjs`: a scheduled function that runs every 5 minutes and retries unsent orders, with backoff of 1, 2, 4… up to 30 minutes. If Apps Script returns `invalid_date`, it re-sends the order with `fallback:true` so the order isn't lost.
- `netlify/lib/orders.mjs`: shared logic.
- **Order page flow.** The page POSTs to `/api/order` with a 5s timeout. It shows "✓ Order PB-… placed · sent to <name> on WhatsApp" instantly and opens `wa.me/<assigned number>` with the message.
  - If the same cart and details are tapped again, the page reuses the same orderId.
  - **Fallback.** If `/api/order` can't be reached (offline, or a Netlify Drop deploy returning 404), the page uses its localStorage outbox, picks a random contact and posts straight to Apps Script (text/plain POST, sendBeacon/keepalive). Later retries try `/api/order` first and pass along the chosen contact.
- Async Workloads were deliberately **not** used, because they need a team extension and an API key on Starter. The scheduled sweep is used instead.

## Apps Script (`apps-script/Code.gs`, SCRIPT_VERSION `2026-11-24.7`)
- **Live deployment URL (keep this one):** `https://script.google.com/macros/s/AKfycbyweMtzB7WrgSSzwBczduVaOAZ5dfYHLXBlJoUCU5bj7cU08IzLRfv7r2UpbJsAQyGs/exec` (the "QyGs" deployment). Check `?action=debug` for the version it currently serves; redeploy after any Code.gs change.
  - **Redeploy without changing the URL:** paste the code → Save → Deploy → Manage deployments → pencil on the existing deployment → Version: New version → Deploy. Choosing "New deployment" creates a new URL, so avoid that.
  - Old unused deployments ending `...RstCz` and `...67X5n` can be deleted.
- **doGet:**
  - `action=stock`
  - `action=debug`: shows the version, cell types sample, `lastOrderTiming` and `lastOrderError`.
  - `action=summary`: aggregates only. Gives ordered, cancelled, paid, pickedUp, pendingPickup, walk-ins (cash/UPI), totalSold and collected, per date, per item and grand total. It excludes "TEST ORDER" rows and VOID walk-ins, is cached for 30s and is invalidated when an order is saved.
- **doPost (orders):**
  - Dedupes by orderId using CacheService plus a bounded TextFinder.
  - Writes with one append and one flush, with Status set to Pending. It takes about 0.8s on the server.
  - `invalid_date` is enforced, and pickup dates whose cutoff has passed are hidden.
  - **There is no stock validation, on purpose.** The user's call: it makes sense for a POS, not for pre-orders. Never add sold-out labels.
- **Staff POST actions** (all need the PIN): `staff_login`, `staff_orders` (now includes `assignedTo`), `staff_set_status` (expected-status concurrency under LockService), `staff_add_walkin` (idempotent on walkinId), `staff_walkins` and `staff_delete_walkin` (marks the row VOID).
  - The PIN is `STAFF_PIN` in Script Properties. The user sets it from the Sheet menu Cake Sale → "Set staff PIN…" (at least 4 digits).
  - Wrong attempts lock out after 5 failures in 10 minutes per device token. If no PIN is set, every staff call is refused.
  - Never print, store or ask for the PIN in chat or code.
- **`setupSheets`** sets up:
  - The Status dropdown and its colours: Paid gold, Picked up green, Cancelled grey strikethrough.
  - The Walk-in Sales tab and a hidden `_ItemPrices` sheet.
  - The Status Updated, Walk-in ID, Void and **Assigned To** columns. Assigned To is added as the last column, and existing rows are untouched.
  - **Undone walk-ins stay in the Sheet, visibly marked.** `staff_delete_walkin` sets the Void cell to `VOID` (summaries, the Recent list and stock all ignore VOID rows) and also greys the row with strikethrough. The Void column is now visible (Walk-in ID stays hidden). `setupSheets` restyles rows that were undone before this version. Styling is best effort and can never fail an undo.
  - The Weekly Summary, which excludes Cancelled and has Picked up and Walk-in columns.
- **Known Sheets gotchas (already fixed, don't regress):**
  - Sheets auto-converts "2026-11-29" and "06:30" into Date objects. Normalise them in Asia/Calcutta when reading, and write those cells as `@` text format.
  - Weekly Summary SUMPRODUCT formulas use `TEXT()` keys and `IFERROR(1*col,0)`, so header text in row 1 doesn't cause `#VALUE!`.
  - Menu actions (setupSheets, Refresh Weekly Summary) run the code saved in the editor and don't need a redeploy. doGet and doPost changes do need a New version.

## Rules / user decisions to respect
- Keep idempotency, meaning dedupe by orderId everywhere.
- The customer must see the order as saved instantly. Saving to the Sheet happens in the background.
- Use a custom JS modal (role=alertdialog, "Almost there!") plus inline field errors when details are missing. Never use the browser `alert()`.
- Use strict poster and logo colours, put the poster at the top, and make the layout responsive and full width on desktop.
- WhatsApp message text uses BMP-only symbols, so no emoji outside the BMP.
- In `index.html`, the `SHEETS_PLACEHOLDER` constant must stay the literal placeholder `PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE`, never the live URL. An earlier bug came from putting the live URL there.
- Don't send live POSTs (orders or staff calls) to the production Apps Script while testing. Use `scripts/mock-apps-script.mjs`. Read-only `?action=debug` and `?action=summary` GETs are fine.
- Test rows "TEST ORDER - delete me" (PB-TEST-261123-A1, -B2) may still be in the Sheet, and the user should delete them.
- A true WhatsApp auto-reply (for example sending the UPI QR) would need the paid Business API. The suggested free option is WhatsApp Business quick replies, such as `/pay` with the QR attached.

## Tests / tooling
- Run `npm test`. It covers 529 checks across `tests/test*.mjs` (node + jsdom), all passing at commit `daa0984`:
  - `test.mjs`: 208
  - `test-functions.mjs`: 32
  - `test-process-order.mjs`: 34
  - `test-staff.mjs`: 53
  - `test-staff-ui.mjs`: 42
  - `test-orders.mjs`: 36
  - `test-stock.mjs`: 51
  - `test-summary.mjs`: 53
  - `test-dates.mjs`: 20
- `scripts/update-poster.py <image>` regenerates `poster.jpg` and `poster.webp` (1080px max width) and updates the sizes in `site-config.js` and `index.html`. After running it, update the hero width/height assertion in `tests/test.mjs` (around line 802) to match the new size.
- `npm run zip` builds a Netlify Drop zip at `drop-zip/poppins-bakers-site.zip`. That zip has no functions, so it uses the random-contact fallback.
- `netlify dev` was tested offline with the mock Sheet on localhost:8787, and the rotation alternated correctly. `netlify-cli` and `puppeteer-core` are installed outside the repo in `/workspace/tools-netlify` on the old machine, so install them locally if needed.
- **Untested:** whether a true burst of simultaneous orders splits evenly on hosted Blobs. The local Blobs emulator isn't atomic, but an in-memory atomic store split 5/5. The worst case is two people in a row assigned to the same contact.
- `scripts/e2e-preview.mjs` (puppeteer previews) failed on its last run and needs a look, since it probably expects a running server.

## Commits
- `aed119b`: Netlify repo: /api/order queue in Blobs, alternating WhatsApp contacts, site-config.js, Code.gs 2026-11-23.12 (Assigned To).
- `daa0984`: New poster (and updated alt text and test size).

## Next steps (not done yet)
1. Create a private GitHub repo, then run `git remote add origin <url> && git push -u origin main`.
2. In Netlify, import from Git, or link the repo to the existing site. No env vars are needed; `APPS_SCRIPT_URL` can optionally override the Apps Script URL.
3. In Apps Script, paste `apps-script/Code.gs`, Save, and run `setupSheets`. Then publish a New version on the existing QyGs deployment.
4. Verify:
   - `?action=debug` reports `2026-11-24.6`.
   - `https://<site>/api/order` returns `{"ok":true,"pending":0}`.
   - One real test order lands in the Sheet with Assigned To filled in. Delete it afterwards.
5. Optional polish: on mobile, the confirmation line wraps to two lines, which makes the sticky bar taller after ordering.

## Update 2026-11-24 (Mass time removed, 3-step order flow, stock limits)
- **Name:** the group is now "Vailankanni Matha Youth" everywhere (it was "Parish Youth").
- **No Mass time.** Pickup is by date only; the Mass choice is gone from the order page, the order payload, the Sheet, the summary and the staff/walk-in flows. The poster still says pickup is after the 6:30 / 8:30 AM Mass.
  - `/api/order` and `Code.gs` still ACCEPT a legacy `mass` / `massLabel` (old cached pages, outbox entries) and silently drop it.
  - New sheets get no Mass column. Existing sheets keep theirs, ignored, until you run **Cake Sale → Remove Mass columns…** (confirms first, then permanently deletes the Mass column from Orders and Walk-in Sales and rebuilds the Weekly Summary). `setupSheets` never deletes data by itself.
  - Weekly Summary is one row per pickup date (no per-Mass rows). `?action=summary` items per date are `{total, ordered, pickedUp, walkIn, pending}`; each date and `grand` also has `pending: {orders, cakes, amount}` (orders whose Status is exactly Pending; aggregates only, shown in the /orders page's "Pending orders" section) (no `06:30` / `08:30` keys). `computeOrderSummaryFromValues_(values, dates, itemNames, now, walkInValues)` lost its `massIds` argument.
  - Walk-in Sales formulas look columns up by header name, so both the old layout (with Mass) and the new one work.
- **Order page:** 3 tabs / steps — 1 pickup date, 2 cakes, 3 contact details — with consistent nav buttons (see `public/index.html`).
- **Stock rules unchanged:** a typed number on the Stock tab = limited batch (+ leftovers carried forward), blank = unlimited, OVERSOLD flags simultaneous last-cake orders.
- **Walk-in recorded time:** Walk-in Sales gets a `Recorded At` text column (ISO 8601, added automatically like `Customer`). `staff_add_walkin` accepts an optional `recordedAt` from the client (offline-queued sales keep their real time); it must be a real date within the last 14 days and at most 5 minutes ahead, otherwise the server time is used. `staff_walkins` rows return `recordedAt` (`''` for legacy rows). A duplicate `walkinId` never overwrites the time.
- **/orders is PIN-gated and lists pending orders:** each date's "Pending orders" card also lists the orders whose status is exactly Pending (name, tel: link, items, total, "To: <assignee>"), oldest first, loaded lazily per open date panel through the PIN-protected `staff_orders` action (no `Code.gs` change) and refreshed with the 60s timer. A failed load shows the real error with a Retry button; a wrong/locked/unauthorized answer returns to the gate.
  - **Privacy, honestly:** names and phone numbers are returned ONLY by PIN-protected `staff_orders`. The Apps Script `?action=summary` GET is still public and returns aggregates only (no names, phones or order IDs); gating the page does not make that URL private.
- **Apps Script:** SCRIPT_VERSION `2026-11-24.7`; redeploy as a New version of the existing deployment and run `setupSheets`.

## Update 2026-11-24 (WhatsApp and contact assignment removed)
**Supersedes** every older line in this file about WhatsApp, alternating contacts, "Assigned To", `formatPaymentLine` and the `contact` field.
- **No WhatsApp step.** Placing an order only saves it (the page shows its own confirmation). Nothing opens `wa.me`, and the order is not assigned to anyone.
- **`/api/order` response is exactly `{ ok: true, status: 'queued' | 'duplicate', orderId }`** (no `contact`). Errors are unchanged: 400 `{ok:false, error:'invalid', fields}`, 409 `{ok:false, error:'out_of_stock', items}`, 405 for other methods.
- **Netlify:** the round-robin counter (`meta/counter`, `nextContactIndex`), contact selection, `publicContact` and `findContact` are deleted. Stored order records no longer carry `contact`. The Sheet payload no longer has `assignedTo` / `assignedContactId` / `assignedNumber`; it keeps `source: 'netlify'`.
- **Legacy clients are tolerated.** An old page or outbox entry that still sends `assignedContactId`, `assignedTo` or `mass` is accepted and those fields are dropped.
- **Stock check bypass.** An order the customer was already told was placed is never rejected by the stock check. The bypass used to be the contact hint; it is now any of `retry: true`, `fallback: true`, or a legacy `assignedContactId`. The page must send `retry: true` on outbox retries.
- **`site-config.js`:** `contacts` stays (name / number / display, used for the tap-to-call links); `paymentLine` is one plain sentence naming both UPI numbers; `formatPaymentLine` is gone.
- **Code.gs `2026-11-24.7`:** new orders never write "Assigned To"; the column is no longer in `BASE_HEADERS` (it is in `LEGACY_HEADERS`, so an existing column is ignored and never treated as a cake column). `staff_orders` no longer returns `assignedTo`. New menu item **Cake Sale → Remove Assigned To column…** confirms first, then permanently deletes that column from Orders. Nothing is deleted automatically, including by `setupSheets`.
- **Redeploy** `Code.gs` as a New version of the existing deployment.

