// Local stand-in for the Apps Script /exec endpoint (for `netlify dev` testing).
// Usage: node scripts/mock-apps-script.mjs 8787   then run netlify dev with
// APPS_SCRIPT_URL=http://localhost:8787/exec
import http from 'http';
const port = Number(process.argv[2] || 8787);
const rows = new Map();
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') return res.end(JSON.stringify({ ok: true, version: 'mock', rows: [...rows.values()] }));
    let data = {};
    try { data = JSON.parse(body); } catch (e) {}
    const dup = rows.has(data.orderId);
    if (!dup) rows.set(data.orderId, { orderId: data.orderId, name: data.name, assignedTo: data.assignedTo, source: data.source || 'browser' });
    console.log('[mock sheet]', dup ? 'duplicate' : 'saved', data.orderId, '→', data.assignedTo);
    res.end(JSON.stringify({ ok: true, status: dup ? 'duplicate' : 'saved', orderId: data.orderId }));
  });
}).listen(port, () => console.log('mock Apps Script on http://localhost:' + port + '/exec'));
