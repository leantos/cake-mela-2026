/*
 * site-config.js — the ONE place to edit sale settings.
 *
 * Used by the order page, orders.html, staff.html (as window.SITE_CONFIG)
 * and by the Netlify order function (via require/import). Edit, commit,
 * push: Netlify redeploys and every page + the function pick it up.
 *
 *   poster       — image files in this folder (swap the files, keep names,
 *                  or change the names here)
 *   contacts     — WhatsApp numbers orders alternate between (in order).
 *                  number = country code + mobile, digits only (for wa.me).
 *                  display = how the number is shown to customers.
 *   paymentLine  — {number} and {name} are filled with the assigned contact.
 *   appsScriptUrl — Google Apps Script web app /exec URL (Sheets backend).
 *                  The Netlify function can override it with the
 *                  APPS_SCRIPT_URL environment variable.
 */
(function (root) {
  var SITE_CONFIG = {
    poster: {
      webp: 'poster.webp',
      jpg: 'poster.jpg',
      width: 1024,
      height: 1536
    },
    contacts: [
      { id: 'cyril', name: 'Cyril Martin', number: '917204017793', display: '+91 72040 17793' },
      { id: 'aashwin', name: 'Aashwin Alfy', number: '918050764341', display: '+91 80507 64341' }
    ],
    paymentLine: 'Pay at pickup, or UPI to {number} ({name})',
    appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyweMtzB7WrgSSzwBczduVaOAZ5dfYHLXBlJoUCU5bj7cU08IzLRfv7r2UpbJsAQyGs/exec',
    orderApiPath: '/api/order',
    stockApiPath: '/api/stock'
  };

  SITE_CONFIG.formatPaymentLine = function (contact) {
    var c = contact || SITE_CONFIG.contacts[0];
    return SITE_CONFIG.paymentLine
      .replace('{number}', c.display || ('+' + c.number))
      .replace('{name}', c.name);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SITE_CONFIG;
  } else {
    root.SITE_CONFIG = SITE_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
