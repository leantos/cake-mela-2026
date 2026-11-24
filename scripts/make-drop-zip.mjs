// Optional: build a Netlify Drop zip of public/ (no functions — the page
// detects /api/order is missing and falls back to posting straight to the
// Sheet with a randomly chosen contact). Output: drop-zip/poppins-bakers-site.zip
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'drop-zip');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'poppins-bakers-site.zip');
fs.rmSync(out, { force: true });
const files = fs.readdirSync(path.join(root, 'public')).filter((f) => !f.startsWith('.'));
execFileSync('python3', ['-m', 'zipfile', '-c', out, ...files], { cwd: path.join(root, 'public'), stdio: 'inherit' });
console.log('wrote', out, files.join(', '));
