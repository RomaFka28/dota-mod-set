// Регрессия на «ReferenceError: pakVpk is not defined»:
// buildWorkshopModInner должна получать параметрами всё своё окружение
// (ошибка появилась при разделении build на внешнюю/внутреннюю функцию).
// Статический тест по исходнику: без запуска Electron.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// Тело Inner: от объявления до конца функции (следующий '\n}\n' на нулевом уровне)
const sig = 'async function buildWorkshopModInner(';
const s0 = src.indexOf(sig);
ok('inner-exists', s0 >= 0);
const paramM = src.slice(s0, s0 + 400).match(/buildWorkshopModInner\(\{([^}]*)\}/);
ok('inner-sig', Boolean(paramM));
const params = new Set((paramM?.[1] || '').split(',').map(s => s.trim().split('=')[0].trim()).filter(Boolean));
let depth = 0, bodyEnd = -1, i = src.indexOf('{', s0);
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
}
ok('inner-body-found', bodyEnd > s0);
const body = src.slice(s0, bodyEnd);

// Имена, которые Inner обязана получать снаружи (пути/контекст сборки)
for (const name of ['pakVpk', 'resolvedGame', 'modName', 'particlePaths', 'targetHue']) {
  const used = new RegExp(`[^\\w$.]${name}[^\\w$:]`).test(body);
  ok(`inner-uses-${name}`, used);
  ok(`inner-receives-${name}`, params.has(name), `params: ${[...params].join(',')}`);
}
// Вызов из внешней функции передаёт их же
const callM = src.match(/buildWorkshopModInner\(\{([^}]*)\}/);
ok('call-exists', Boolean(callM));
for (const name of ['pakVpk', 'resolvedGame'])
  ok(`call-passes-${name}`, callM && new RegExp(`\\b${name}\\b`).test(callM[1]), callM?.[1]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
