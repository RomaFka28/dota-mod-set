// Тесты подслотов конфликтов на РЕАЛЬНОМ коде из src/main.js (блок вырезается по маркерам).
// Запуск: npm test   (или: node src/subslot.test.js)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('// ── SUBSLOT-BLOCK-START ──');
const end = src.indexOf('// ── SUBSLOT-BLOCK-END ──');
if (start < 0 || end < 0 || end < start) throw new Error('блок подслотов не найден в main.js');
eval('(function(){' + src.slice(start, end) + ';globalThis.__subslot = { conflictSubSlot };})()');
const { conflictSubSlot } = globalThis.__subslot;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// Фоны: три разных слота
ok('bg-loading', conflictSubSlot('backgrounds', 'Anime Loading Screen') === ':loading');
ok('bg-versus', conflictSubSlot('backgrounds', 'Epic Versus Screen') === ':versus');
ok('bg-vs-short', conflictSubSlot('backgrounds', 'TI VS Screen Pack') === ':versus');
ok('bg-pedestal', conflictSubSlot('backgrounds', 'Fountain Pedestal') === ':pedestal');
ok('bg-default-loading', conflictSubSlot('backgrounds', 'Some Random Name') === ':loading');
// Мелочи: пины/ранги/дай-пять не конфликтуют между собой
ok('ui-pings', conflictSubSlot('ui', 'Fun Pings Pack') === ':pings');
ok('ui-ranks', conflictSubSlot('ui', 'Normis Rank Icons') === ':ranks');
ok('ui-highfive', conflictSubSlot('ui', 'High Five Taunt') === ':highfive');
ok('ui-misc', conflictSubSlot('ui', 'Weird HUD Thing') === ':misc');
// Одиночные разделы подслотов не получают
for (const cat of ['emblems', 'couriers', 'music', 'fonts', 'huds', 'wards', 'sounds', 'items'])
  ok(`single-${cat}`, conflictSubSlot(cat, 'Anything At All') === '');
ok('null-name', conflictSubSlot('backgrounds', null) === ':loading');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
