// Local stand-in for the Apps Script /exec endpoint (for `netlify dev` testing).
// Usage: node scripts/mock-apps-script.mjs 8787   then run netlify dev with
// APPS_SCRIPT_URL=http://localhost:8787/exec
//
// GET ?action=stock serves the pickup dates with per-item `remaining`
// (null = unlimited, 0 = sold out). Seed limits with MOCK_STOCK, e.g.
//   MOCK_STOCK='{"2026-11-29":{"Rich Plum Cake (400g)":2}}' node scripts/mock-apps-script.mjs
// Saved orders use up the finite limits, like the real Stock tab.
import http from 'http';
const port = Number(process.argv[2] || 8787);
const rows = new Map();
const limits = JSON.parse(process.env.MOCK_STOCK || '{}');
const DATES = [
  { id: '2026-11-29', label: 'Sun, 29 Nov' },
  { id: '2026-12-06', label: 'Sun, 6 Dec' },
  { id: '2026-12-13', label: 'Sun, 13 Dec' },
  { id: '2026-12-20', label: 'Sun, 20 Dec' }
].map((d) => Object.assign(d, { closesAt: d.id + 'T08:30:00+05:30' }));

function stockPayload() {
  return {
    ok: true,
    version: 'mock',
    dates: DATES.map((d) => Object.assign({}, d, { remaining: Object.assign({}, limits[d.id] || {}) }))
  };
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('action') === 'stock') return res.end(JSON.stringify(stockPayload()));
      return res.end(JSON.stringify({ ok: true, version: 'mock', rows: [...rows.values()] }));
    }
    let data = {};
    try { data = JSON.parse(body); } catch (e) {}
    const dup = rows.has(data.orderId);
    if (!dup) {
      rows.set(data.orderId, { orderId: data.orderId, name: data.name, assignedTo: data.assignedTo, source: data.source || 'browser' });
      const lim = limits[data.pickupDate];
      if (lim) {
        (data.items || []).forEach((line) => {
          if (typeof lim[line.name] === 'number') lim[line.name] = Math.max(0, lim[line.name] - Number(line.qty || 0));
        });
      }
    }
    console.log('[mock sheet]', dup ? 'duplicate' : 'saved', data.orderId, '→', data.assignedTo);
    res.end(JSON.stringify({ ok: true, status: dup ? 'duplicate' : 'saved', orderId: data.orderId }));
  });
}).listen(port, () => console.log('mock Apps Script on http://localhost:' + port + '/exec'));
