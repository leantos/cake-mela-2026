import { readPage, CODE_GS, ROOT } from './helpers.mjs';
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(CODE_GS, 'utf8');
const start = src.indexOf('/* ---- date helpers (testable) ---- */');
const end = src.indexOf('/* ---- end date helpers ---- */');
if (start < 0 || end < 0) {
  console.error('date helper markers missing from Code.gs');
  process.exit(1);
}
const context = {};
vm.createContext(context);
vm.runInContext(src.slice(start, end + '/* ---- end date helpers ---- */'.length), context);

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : (detail ?? 'failed') });
  if (!cond) console.error('FAIL', name, detail ?? '');
  else console.log('PASS', name);
}

const parse = context.parseStockDateHeader_;

function check(name, raw, expected) {
  const got = parse(raw);
  if (!expected) {
    assert(name, got == null, JSON.stringify(got));
    return;
  }
  const ok = got && got.id === expected.id && got.label === expected.label && got.closesAt === expected.closesAt;
  assert(name, ok, JSON.stringify(got) + ' expected ' + JSON.stringify(expected));
}

check('text 27 Dec 2026', '27 Dec 2026', {
  id: '2026-12-27',
  label: 'Sun, 27 Dec',
  closesAt: '2026-12-27T08:30:00+05:30'
});
check('text with weekday Sun 29 Nov 2026', 'Sun 29 Nov 2026', {
  id: '2026-11-29',
  label: 'Sun, 29 Nov',
  closesAt: '2026-11-29T08:30:00+05:30'
});
check('ISO date', '2026-12-27', {
  id: '2026-12-27',
  label: 'Sun, 27 Dec',
  closesAt: '2026-12-27T08:30:00+05:30'
});
check('Friday 25 Dec 2026 uses actual weekday', '25 Dec 2026', {
  id: '2026-12-25',
  label: 'Fri, 25 Dec',
  closesAt: '2026-12-25T08:30:00+05:30'
});
check('Wednesday with weekday word', 'Wed 23 Dec 2026', {
  id: '2026-12-23',
  label: 'Wed, 23 Dec',
  closesAt: '2026-12-23T08:30:00+05:30'
});
check('header time 10:00 AM', '27 Dec 2026 10:00 AM', {
  id: '2026-12-27',
  label: 'Sun, 27 Dec',
  closesAt: '2026-12-27T10:00:00+05:30'
});
check('header time 10am', '25 Dec 2026 10am', {
  id: '2026-12-25',
  label: 'Fri, 25 Dec',
  closesAt: '2026-12-25T10:00:00+05:30'
});
check('comma form', 'Fri, 25 Dec 2026', {
  id: '2026-12-25',
  label: 'Fri, 25 Dec',
  closesAt: '2026-12-25T08:30:00+05:30'
});
check('D/M/Y', '27/12/2026', {
  id: '2026-12-27',
  label: 'Sun, 27 Dec',
  closesAt: '2026-12-27T08:30:00+05:30'
});
check('Item header skipped', 'Item', null);
check('Total header skipped', 'Total', null);
check('blank skipped', '', null);
check('garbage skipped', 'notes', null);

const asDate = new Date('2026-11-29T00:00:00+05:30'); // date-only midnight IST
const fromDate = parse(asDate);
assert('Sheets Date cell normalizes to ISO in IST',
  fromDate && fromDate.id === '2026-11-29' && fromDate.label === 'Sun, 29 Nov' &&
  fromDate.closesAt === '2026-11-29T08:30:00+05:30',
  JSON.stringify(fromDate));

const datedTime = new Date('2026-12-25T10:00:00+05:30');
const fromTimed = parse(datedTime);
assert('Date cell with time keeps cutoff',
  fromTimed && fromTimed.id === '2026-12-25' && fromTimed.closesAt === '2026-12-25T10:00:00+05:30',
  JSON.stringify(fromTimed));

const dates = [
  parse('29 Nov 2026'),
  parse('25 Dec 2026 10:00 AM')
];
const found = context.findStockDate_('Sun, 25 Dec', dates) || context.findStockDate_('2026-12-25', dates) ||
  context.findStockDate_('25 Dec 2026', dates);
assert('findStockDate_ matches parsed text to catalog id', found && found.id === '2026-12-25', JSON.stringify(found));
assert('findStockDate_ rejects unknown date', context.findStockDate_('2026-12-06', dates) == null);

const novDates = [parse('29 Nov 2026'), parse('25 Dec 2026 10:00 AM')];
const istMidnight29 = new Date('2026-11-28T18:30:00.000Z');
assert('findStockDate_ matches a Sheets Date at IST midnight to 29 Nov',
  context.findStockDate_(istMidnight29, novDates)?.id === '2026-11-29',
  JSON.stringify(context.findStockDate_(istMidnight29, novDates)));
assert('normalizePickupDateId_ of that Date is 2026-11-29',
  context.normalizePickupDateId_(istMidnight29) === '2026-11-29');
assert('findStockDate_ still matches the Sun, 29 Nov label',
  context.findStockDate_('Sun, 29 Nov', novDates)?.id === '2026-11-29');

const failed = results.filter((r) => !r.ok);
console.log('\n--- date helpers ' + (results.length - failed.length) + '/' + results.length + ' passed ---');
if (failed.length) {
  console.error(failed);
  process.exit(1);
}
