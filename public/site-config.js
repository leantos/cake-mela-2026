/*
 * site-config.js — the ONE place to edit sale settings.
 *
 * Used by the order page, orders.html, staff.html (as window.SITE_CONFIG)
 * and by the Netlify order function (via require/import). Edit, commit,
 * push: Netlify redeploys and every page + the function pick it up.
 *
 *   poster       — image files in this folder (swap the files, keep names,
 *                  or change the names here)
 *   contacts     — people customers can call (shown as tap-to-call links in
 *                  the top bar). number = country code + mobile, digits only
 *                  (for tel:). display = how the number is shown. Orders are
 *                  not assigned to anyone: there is no WhatsApp step.
 *   bulkDiscount — { minCakes, percent }: orders with that many cakes or more get
 *                  that percentage off the total (the poster's bulk offer).
 *   pickupDates  — the pickup dates the order page shows the moment it opens,
 *                  before (and without waiting for) the backend. The Stock tab's
 *                  dates still win once the backend answers, so keep this list in
 *                  step with the Stock tab headers. id = yyyy-mm-dd (IST), closesAt =
 *                  the cutoff after which a date is hidden (8:30 AM IST that day).
 *   appsScriptUrl — Google Apps Script web app /exec URL (Sheets backend).
 *                  The Netlify function can override it with the
 *                  APPS_SCRIPT_URL environment variable.
 */
(function (root) {
  var SITE_CONFIG = {
    poster: {
      webp: 'poster.webp',
      jpg: 'poster.jpg',
      width: 1080,
      height: 1620
    },
    contacts: [
      { id: 'cyril', name: 'Cyril Martin', number: '917204017793', display: '+91 72040 17793' },
      { id: 'aashwin', name: 'Aashwin Alfy', number: '918050764341', display: '+91 80507 64341' }
    ],
    // Poster offer: one order with minCakes or more cakes in total gets percent% off the
    // whole order (rounded to whole rupees). Read by the order page AND the Netlify
    // order function, so change it here only.
    bulkDiscount: { minCakes: 50, percent: 10 },
    // Shown instantly on load; the backend list replaces it when it answers.
    pickupDates: [
      { id: '2026-11-29', label: 'Sun, 29 Nov', closesAt: '2026-11-29T08:30:00+05:30' },
      { id: '2026-12-06', label: 'Sun, 6 Dec', closesAt: '2026-12-06T08:30:00+05:30' },
      { id: '2026-12-13', label: 'Sun, 13 Dec', closesAt: '2026-12-13T08:30:00+05:30' },
      { id: '2026-12-20', label: 'Sun, 20 Dec', closesAt: '2026-12-20T08:30:00+05:30' },
      { id: '2026-12-21', label: 'Mon, 21 Dec', closesAt: '2026-12-21T08:30:00+05:30' },
      { id: '2026-12-22', label: 'Tue, 22 Dec', closesAt: '2026-12-22T08:30:00+05:30' },
      { id: '2026-12-23', label: 'Wed, 23 Dec', closesAt: '2026-12-23T08:30:00+05:30' },
      { id: '2026-12-24', label: 'Thu, 24 Dec', closesAt: '2026-12-24T08:30:00+05:30' },
      { id: '2026-12-25', label: 'Fri, 25 Dec', closesAt: '2026-12-25T08:30:00+05:30' }
    ],
    appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyweMtzB7WrgSSzwBczduVaOAZ5dfYHLXBlJoUCU5bj7cU08IzLRfv7r2UpbJsAQyGs/exec',
    orderApiPath: '/api/order',
    stockApiPath: '/api/stock'
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SITE_CONFIG;
  } else {
    root.SITE_CONFIG = SITE_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
