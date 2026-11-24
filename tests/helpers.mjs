import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC = path.join(ROOT, 'public');
export const CODE_GS = path.join(ROOT, 'apps-script', 'Code.gs');

/** Read a page with site-config.js inlined (jsdom does not fetch it offline). */
export function readPage(name) {
  const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
  const cfg = fs.readFileSync(path.join(PUBLIC, 'site-config.js'), 'utf8');
  return html.replace('<script src="site-config.js"></script>', () => '<script>' + cfg + '</script>');
}
