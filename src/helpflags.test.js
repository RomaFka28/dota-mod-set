// Тесты parseHelpFlags на РЕАЛЬНОМ коде из src/main.js (блок вырезается по маркерам).
// Запуск: npm test   (или: node src/helpflags.test.js)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('// ── HELPFLAGS-BLOCK-START ──');
const end = src.indexOf('// ── HELPFLAGS-BLOCK-END ──');
if (start < 0 || end < 0 || end < start) throw new Error('блок helpflags не найден в main.js');
eval('(function(){' + src.slice(start, end) + ';globalThis.__helpflags = parseHelpFlags;})()');
const parseHelpFlags = globalThis.__helpflags;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// 1. живой формат VRF: все 4 флага + алиас
{
  const help = [
    '  --vpk_list              List archive contents.',
    '  --vpk_extensions <ext>  Filter by extension.',
    '  --vpk_filepath <path>   File to extract.',
    '  --vpk_decompile         Decompile resources.',
    '  --decompile             Alias for --vpk_decompile.',
  ].join('\n');
  const f = parseHelpFlags(help);
  ok('live-format', f.listFlag === '--vpk_list' && f.extFlag === '--vpk_extensions' &&
    f.pathFlag === '--vpk_filepath' && f.decompileFlag === '--vpk_decompile', JSON.stringify(f));
}
// 2. --list-foo НЕ считается за --list
{
  const f = parseHelpFlags('  --list-files   Something else.\n  -f <path>  File.');
  ok('no-substring-list', f.listFlag === null && f.pathFlag === '-f', JSON.stringify(f));
}
// 3. короткие флаги только отдельными токенами (проза «use -e flag» не в счёт? в счёт, но это ок:
//    упоминание в help обычно означает существование; главное — -ef не даёт -e и -f)
{
  const f = parseHelpFlags('  -ef   Combined.');
  ok('no-combined-shorts', f.extFlag === null && f.pathFlag === null, JSON.stringify(f));
}
// 4. пустой вывод — всё null, не падаем
{
  const f = parseHelpFlags('');
  ok('empty', f.listFlag === null && f.pathFlag === null && f.decompileFlag === null);
  ok('null-input', parseHelpFlags(null).listFlag === null);
}
// 5. алиас --decompile подхватывается при отсутствии --vpk_decompile
{
  const f = parseHelpFlags('  --decompile   Decompile.\n  --vpk_filepath <p>  Path.');
  ok('decompile-alias', f.decompileFlag === '--decompile', JSON.stringify(f));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
