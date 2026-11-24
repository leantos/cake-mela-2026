import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => /^test.*\.mjs$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length;
  if (fail || r.status !== 0) {
    failed++;
    console.log(out.split('\n').filter((l) => /FAIL|Error/.test(l)).join('\n'));
  }
  console.log(`${f}: ${pass} passed, ${fail} failed${r.status ? ' (exit ' + r.status + ')' : ''}`);
}
process.exit(failed ? 1 : 0);
