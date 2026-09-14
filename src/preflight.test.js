// Тесты префлайта процессов на РЕАЛЬНОМ коде из src/main.js (блок вырезается по маркерам).
// Запуск: npm test   (или: node src/preflight.test.js)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('// ── PREFLIGHT-BLOCK-START ──');
const end = src.indexOf('// ── PREFLIGHT-BLOCK-END ──');
if (start < 0 || end < 0 || end < start) throw new Error('блок префлайта не найден в main.js');
// execFileAsync в тестах не вызываем (только parseTasklistCsv), поэтому заглушка
const execFileAsync = async () => { throw new Error('не должно вызываться в тестах'); };
eval('(function(){' + src.slice(start, end) + ';globalThis.__preflight = { parseTasklistCsv, PREFLIGHT_PROCS };})()');
const { parseTasklistCsv, PREFLIGHT_PROCS } = globalThis.__preflight;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// 1. классический CSV tasklist: обе строки находятся
{
  const out = '"dota2.exe","1234","Console","1","1 024 K"\r\n"steam.exe","5678","Console","1","2 048 K"\r\n';
  const f = parseTasklistCsv(out);
  ok('both-found', f.has('dota2.exe') && f.has('steam.exe'));
}
// 2. регистр не важен (DOTA2.EXE)
{
  const f = parseTasklistCsv('"DOTA2.EXE","1","Console","1","1 K"\n');
  ok('case-insensitive', f.has('dota2.exe'));
}
// 3. пустой вывод / мусор — пустой Set, не падаем
{
  ok('empty', parseTasklistCsv('').size === 0);
  ok('garbage', parseTasklistCsv('INFO: No tasks\n').size === 0);
  ok('null', parseTasklistCsv(null).size === 0);
}
// 4. похожие имена не дают ложных срабатываний (точное совпадение)
{
  const f = parseTasklistCsv('"dota2.exe.bak","1","Console","1","1 K"\n"mysteam.exe","2","Console","1","1 K"\n');
  ok('no-false-positive', !f.has('dota2.exe') && !f.has('steam.exe'));
}
// 5. LF без CR тоже парсится
{
  const f = parseTasklistCsv('"steam.exe","9","Console","1","1 K"\n');
  ok('lf-only', f.has('steam.exe'));
}
// 6. таблица PREFLIGHT_PROCS согласована с проверками (id/label/image)
{
  const ids = PREFLIGHT_PROCS.map(p => p.id).sort().join(',');
  ok('proc-table', ids === 'dota,steam' && PREFLIGHT_PROCS.every(p => p.image && p.label), JSON.stringify(PREFLIGHT_PROCS));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
