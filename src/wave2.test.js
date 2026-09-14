// Тесты волны 2 на РЕАЛЬНОМ коде из src/main.js.
// WAVE2-блок — по маркерам; createMutex/hashStream/writeJson — вырезанием
// функции со счётчиком скобок (как в build.test.js).
// Запуск: npm test   (или: node src/wave2.test.js)
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const src = fss.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function extractFn(source, name) {
  let s0 = source.indexOf('function ' + name);
  if (s0 < 0) throw new Error('не найдена ' + name);
  if (source.slice(s0 - 6, s0) === 'async ') s0 -= 6; // не срезать async у async-функций
  let depth = 0, i = source.indexOf('{', s0);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (!depth) break; }
  }
  return source.slice(s0, i + 1);
}

const wStart = src.indexOf('// ── WAVE2-BLOCK-START ──');
const wEnd = src.indexOf('// ── WAVE2-BLOCK-END ──');
if (wStart < 0 || wEnd < 0 || wEnd < wStart) throw new Error('WAVE2-блок не найден в main.js');
eval('(function(){' + src.slice(wStart, wEnd)
  + ';' + extractFn(src, 'createMutex')
  + ';' + extractFn(src, 'hashStream')
  + ';' + extractFn(src, 'writeJson')
  + ';globalThis.__w2 = { scoreParticleList, completeFamilies, pakSigOf, splitScope, createMutex, hashStream, writeJson };})()');
const { scoreParticleList, completeFamilies, pakSigOf, splitScope, createMutex, hashStream, writeJson } = globalThis.__w2;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
// ── scoreParticleList ──
{
  const all = ['particles/x/burn_thing.vpcf_c', 'particles/burn.vpcf_c', 'particles/other.vpcf_c'];
  const r = scoreParticleList(all, 'burn');
  ok('score-order', r.length === 2 && r[0].p === 'particles/burn.vpcf_c', JSON.stringify(r.map(x => x.p)));
  ok('score-desc', r[0].s >= r[1].s);
}
ok('score-empty', eq(scoreParticleList(['a.vpcf_c'], 'zzz'), []));
{
  const r = scoreParticleList(['particles/BURN.vpcf_c'], 'burn');
  ok('score-case', r.length === 1);
}
// ── completeFamilies ──
{
  const keyFn = p => (p.startsWith('a_') ? 'K_A' : 'K_B');
  const all = ['a_bloom.vpcf_c', 'a_ember.vpcf_c', 'b_other.vpcf_c'];
  const out = completeFamilies(['K_A'], all, keyFn);
  ok('complete-pulls-layers', out.length === 1 && out[0].files.length === 2, JSON.stringify(out));
}
{
  const keyFn = p => p[0];
  const out = completeFamilies(['z', 'a'], ['a1.vpcf_c', 'a2.vpcf_c'], keyFn);
  ok('complete-drops-unknown-keeps-order', out.length === 1 && out[0].key === 'a' && out[0].files.length === 2);
}
// ── pakSigOf ──
ok('sig-format', pakSigOf({ size: 123, mtimeMs: 456.789 }) === '123:456');
// ── createMutex: порядок и живучесть ──
{
  const m = createMutex();
  const order = [];
  const t = ms => new Promise(r => setTimeout(r, ms));
  await Promise.all([
    m.run(async () => { await t(30); order.push(1); }),
    m.run(async () => { order.push(2); }),
    m.run(async () => { await t(10); order.push(3); }),
  ]);
  ok('mutex-order', eq(order, [1, 2, 3]), JSON.stringify(order));
}
{
  const m = createMutex();
  let ran = false;
  await m.run(async () => { throw new Error('boom'); }).catch(() => {});
  await m.run(async () => { ran = true; });
  ok('mutex-survives-reject', ran);
}
// ── hashStream = прямой sha256 ──
{
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'w2-'));
  const f = path.join(dir, 'bin.dat');
  const data = crypto.randomBytes(100000);
  fss.writeFileSync(f, data);
  const want = crypto.createHash('sha256').update(data).digest('hex');
  ok('hashstream', (await hashStream(f)) === want);
  fss.rmSync(dir, { recursive: true, force: true });
}
// ── writeJson атомарна и не оставляет tmp ──
{
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'w2-'));
  const f = path.join(dir, 'm.json');
  await writeJson(f, { a: [1, 2] });
  ok('writejson-roundtrip', eq(JSON.parse(fss.readFileSync(f, 'utf8')), { a: [1, 2] }));
  ok('writejson-no-tmp', fss.readdirSync(dir).filter(x => x.includes('.tmp-')).length === 0, fss.readdirSync(dir).join(','));
  fss.rmSync(dir, { recursive: true, force: true });
}

// ── splitScope: скоп in:.../not:... отделяется от слов поиска ──
{
  ok('scope-basic', eq(splitScope('ambient in:econ/items'), { scope: ['econ/items'], not: [], terms: 'ambient' }));
  ok('scope-multi', eq(splitScope('aura in:econ in:items'), { scope: ['econ', 'items'], not: [], terms: 'aura' }));
  ok('scope-none', eq(splitScope('burning chaos'), { scope: [], not: [], terms: 'burning chaos' }));
  ok('scope-empty-in', eq(splitScope('in: ambient'), { scope: [], not: [], terms: 'in: ambient' }));
  ok('scope-case', eq(splitScope('AMBIENT IN:Econ'), { scope: ['econ'], not: [], terms: 'ambient' }));
  ok('scope-empty', eq(splitScope(''), { scope: [], not: [], terms: '' }));
  ok('scope-not', eq(splitScope('ambient not:econ not:ui'), { scope: [], not: ['econ', 'ui'], terms: 'ambient' }));
  ok('scope-mixed', eq(splitScope('unusual in:econ not:ui'), { scope: ['econ'], not: ['ui'], terms: 'unusual' }));
  ok('scope-empty-not', eq(splitScope('not: aura'), { scope: [], not: [], terms: 'not: aura' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL harness ' + (e && e.message)); process.exit(1); });
