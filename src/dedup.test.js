// Тесты workshopBuildSig на РЕАЛЬНОМ коде из src/main.js (блок вырезается по маркерам).
// Запуск: npm test   (или: node src/dedup.test.js)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('// ── DEDUP-BLOCK-START ──');
const end = src.indexOf('// ── DEDUP-BLOCK-END ──');
if (start < 0 || end < 0 || end < start) throw new Error('блок дедупа не найден в main.js');
eval('(function(){' + src.slice(start, end) + ';globalThis.__dedup = { workshopBuildSig };})()');
const { workshopBuildSig } = globalThis.__dedup;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const P = ['particles/a.vpcf_c', 'particles/b.vpcf_c'];
// 1. одинаковый вход — одинаковая сигнатура
ok('stable', workshopBuildSig(P, 0.5) === workshopBuildSig(P, 0.5));
// 2. порядок файлов не важен
ok('order-insensitive', workshopBuildSig(P, 0.5) === workshopBuildSig([...P].reverse(), 0.5));
// 3. регистр путей и слеши не важны
ok('path-norm', workshopBuildSig(P, 0.5) === workshopBuildSig(['PARTICLES\\A.vpcf_c', 'particles/b.vpcf_c'], 0.5));
// 4. другой оттенок — другая сигнатура
ok('hue-matters', workshopBuildSig(P, 0.5) !== workshopBuildSig(P, 0.6));
// 5. другой набор — другая сигнатура
ok('paths-matter', workshopBuildSig(P, 0.5) !== workshopBuildSig(['particles/a.vpcf_c'], 0.5));
// 6. пустой вход не падает
ok('empty', typeof workshopBuildSig([], 0) === 'string' && workshopBuildSig([], 0).startsWith('0:'));
// 7. hue из degrees-дробей стабилен (0.5*360=180)
ok('hue-deg', workshopBuildSig(P, 0.5).split(':')[1] === '180');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
