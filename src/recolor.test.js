// Тесты recolorVpcf на РЕАЛЬНОМ коде из src/main.js (блок вырезается по маркерам).
// Запуск: npm test   (или: node src/recolor.test.js)
// Семантика сверена с h6rd/VPCF-Editor src/color_parser.py.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('function rgb2hsv');
const end = src.indexOf('// ── Проверка .NET');
if (start < 0 || end < 0 || end < start) throw new Error('блок recolor не найден в main.js');
eval('(function(){' + src.slice(start, end) + ';globalThis.__recolor = recolorVpcf;})()');
const recolorVpcf = globalThis.__recolor;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const BLUE = 2 / 3;
const rc = (s, hue = BLUE) => recolorVpcf(s, hue);

// 1. инлайн красный -> синий, альфа цела, одна строка
{
  const t = 'm_ConstantColor = [ 1.000000, 0.000000, 0.000000, 1.000000 ]';
  const r = rc(t);
  ok('inline-red-recolored', r.text !== t, r.text);
  ok('inline-alpha-kept', /1\.000000\s*\]$/.test(r.text), r.text);
  ok('inline-single-line', !r.text.includes('\n'));
  ok('inline-blue-ish', /0\.000000,\s*0\.000000,\s*1\.000000/.test(r.text), r.text);
  ok('inline-stats', r.replaced === 1 && r.total === 1, JSON.stringify({ replaced: r.replaced, total: r.total }));
}
// 2. многострочный
{
  const t = 'm_ConstantColor =\n[\n    1.000000,\n    0.000000,\n    0.000000,\n    1.000000,\n]';
  const r = rc(t);
  ok('multiline-recolored', r.text !== t, r.text);
  ok('multiline-format-kept', r.text.includes('\n') && r.text.trimEnd().endsWith(']'));
}
// 3. белый не трогаем (sat < 0.08), но блок распознан
{
  const t = 'm_ConstantColor = [ 1.000000, 1.000000, 1.000000, 1.000000 ]';
  const r = rc(t);
  ok('white-skipped', r.text === t && r.replaced === 0 && r.total === 1, JSON.stringify(r));
}
// 4. имя поля с цифрой не портится
{
  const r = rc('m_Color1 = [ 1.000000, 0.000000, 0.000000, 1.000000 ]');
  ok('field-name-intact', r.text.startsWith('m_Color1 = ['), r.text);
}
// 5. float3 без альфы
{
  const r = rc('m_vecColor = [ 1.000000, 0.000000, 0.000000 ]');
  ok('float3-recolored', r.text !== undefined && r.replaced === 1 && r.text.endsWith(']'), r.text);
}
// 6. прозрачный пропускаем
{
  const t = 'm_Color = [ 1.000000, 0.000000, 0.000000, 0.000000 ]';
  const r = rc(t);
  ok('transparent-skipped', r.text === t && r.replaced === 0);
}
// 7. чужие поля не трогаем
{
  const t = 'm_vPosition = [ 1.000000, 2.000000, 3.000000 ]';
  const r = rc(t);
  ok('foreign-field-intact', r.text === t && r.total === 0);
}
// 8. повторяющиеся значения
{
  const r = rc('m_ColorFade = [ 0.500000, 0.000000, 0.000000, 1.000000 ]');
  ok('dup-values-ok', (r.text.match(/0\.500000/g) || []).length <= 1, r.text);
}
// 9. экспоненциальная запись парсится
{
  const r = rc('m_ColorMax = [ 1.000000e+00, 0.000000e+00, 0.000000e+00, 1.000000e+00 ]');
  ok('exponent-ok', r.replaced === 1, r.text);
}
// 10. полный KV3-документ: правим только цвета
{
  const doc = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb732b7b0} -->\n{\n    m_ConstantColor = [ 1.000000, 0.000000, 0.000000, 1.000000 ]\n    m_nParticleCount = 100\n}';
  const r = rc(doc);
  ok('doc-header-intact', r.text.startsWith('<!-- kv3'));
  ok('doc-count-intact', r.text.includes('m_nParticleCount = 100'), r.text);
}
// 11. байтовые int-цвета 0-255: выход тоже int
{
  const r = rc('m_Color = [ 255, 128, 0 ]');
  ok('byte-ints', r.replaced === 1 && /\[\s*0,\s*0,\s*255\s*\]/.test(r.text), r.text);
}
// 12. разрядность оригинала сохраняется
{
  const r = rc('m_ConstantColor = [ 1.00, 0.00, 0.00, 1.0 ]');
  ok('decimals-kept', /0\.00,\s*0\.00,\s*1\.00/.test(r.text), r.text);
}
// 13. //-комментарий внутри блока сохраняется, числа правятся
{
  const t = 'm_Color = [ 1.000000, // red\n 0.000000, 0.000000, 1.000000 ]';
  const r = rc(t);
  ok('comment-kept', r.replaced === 1 && r.text.includes('// red'), r.text);
}
// 14. nan-канал: блок распознан, но не тронут
{
  const t = 'm_Color = [ 1.000000, nan, 0.000000, 1.000000 ]';
  const r = rc(t);
  ok('nan-skipped', r.text === t && r.total === 1 && r.replaced === 0, JSON.stringify({ total: r.total, replaced: r.replaced }));
}
// 15. отрицательные значения: без падений, форма цела
{
  const t = 'm_Color = [ -0.500000, 0.200000, 0.300000, 1.000000 ]';
  let r;
  try { r = rc(t); } catch (e) { r = null; }
  ok('negative-no-crash', !!r && r.text.includes('m_Color = ['), r && r.text);
}
// 16. похожий ключ, но НЕ цвет (времена) — скип
{
  const t = 'm_ColorFadeTimes = [ 0.100000, 0.500000, 1.000000 ]';
  const r = rc(t);
  ok('time-key-skipped', r.text === t && r.total === 0, r.text);
}
// 17. британское написание colour
{
  const r = rc('m_Colour = [ 1.000000, 0.000000, 0.000000, 1.000000 ]');
  ok('colour-spelling', r.replaced === 1, r.text);
}
// 18. мусор внутри скобок — блок не трогаем (remainder-guard)
{
  const t = 'm_Color = [ 1.0, "somestring", 0.0, 1.0 ]';
  const r = rc(t);
  ok('garbage-skipped', r.text === t && r.total === 0, r.text);
}
// 19. перф: 200 блоков в большом документе
{
  const block = '    m_ColorFade = [ 1.000000, 0.200000, 0.100000, 1.000000 ]\n';
  const big = '<!-- kv3 -->\n{\n' + block.repeat(200) + '}';
  const t0 = Date.now();
  const r = rc(big);
  const dt = Date.now() - t0;
  ok('perf-200-blocks', r.replaced === 200 && dt < 2000, `replaced=${r.replaced} dt=${dt}ms`);
}

// ── Кейсы 2-го раунда: { }-скобки, суффиксы, комментарии, ловушки ──
// 20. фигурные скобки вместо квадратных
{
  const r = rc('m_Color = { 1.000000, 0.000000, 0.000000, 1.000000 }');
  ok('curly-red-recolored', r.replaced === 1 && /0\.000000,\s*0\.000000,\s*1\.000000/.test(r.text), r.text);
}
// 21. пробелы вокруг запятых + белый (скип, но распознан)
{
  const t = 'm_Color = { 1 , 1 , 1 }';
  const r = rc(t);
  ok('curly-spaces-white', r.text === t && r.total === 1 && r.replaced === 0, JSON.stringify(r));
}
// 22. многострочные {} + trailing comma
{
  const t = 'm_Color = {\n    1.0,\n    0.0,\n    0.0,\n}';
  const r = rc(t);
  ok('curly-multiline-trailing-comma', r.replaced === 1 && r.text.endsWith('}'), r.text);
}
// 23. экспонента + HDR-значение (идёт без byte-масштаба, конечные числа)
{
  const r = rc('m_Color = { 1e-5, 0.5, 1.0e+10 }');
  ok('exponent-hdr', r.replaced === 1 && r.text.includes('10000000000.0'), r.text);
}
// 24. равномерные отрицательные — скип
{
  const t = 'm_Color = { -1, -1, -1 }';
  const r = rc(t);
  ok('negative-uniform-skipped', r.text === t && r.replaced === 0);
}
// 25. RGBA в фигурных, альфа цела
{
  const r = rc('m_Color = { 1, 0, 0, 1 }');
  ok('curly-rgba', r.replaced === 1 && /\{\s*0,\s*0,\s*1,\s*1\s*\}/.test(r.text), r.text);
}
// 26. байтовые в фигурных — выход int
{
  const r = rc('m_Color = { 255, 128, 0 }');
  ok('curly-byte-ints', r.replaced === 1 && /\{\s*0,\s*0,\s*255\s*\}/.test(r.text), r.text);
}
// 27. nan в альфе: распознан, не тронут
{
  const t = 'm_ConstantColor = [ 1.000000, 0.000000, 0.000000, nan ]';
  const r = rc(t);
  ok('nan-alpha-skipped', r.text === t && r.total === 1 && r.replaced === 0);
}
// 28. нижний регистр ключа
{
  const r = rc('m_color = [ 1.0, 0.0, 0.0 ]');
  ok('lowercase-key', r.replaced === 1, r.text);
}
// 29. префиксы типа f/v
{
  ok('f-prefix', rc('m_fColor = [ 1.0, 0.0, 0.0 ]').replaced === 1);
  ok('v-prefix', rc('m_vColor = [ 1.0, 0.0, 0.0 ]').replaced === 1);
}
// 30. ловушки skip-листа: скаляры/bool/строки с "color" не трогаем
{
  const cases = [
    'm_flFadeColorTime = 2.5',
    'm_bColorOverride = true',
    'm_nColorMode = 3',
    'm_strColorName = "red"',
  ];
  for (const t of cases) {
    const r = rc(t);
    ok(`trap-scalar:${t.split(' ')[0]}`, r.text === t && r.total === 0, r.text);
  }
}
// 31. вложенный градиент — внутренние плоские тройки КРАСЯТСЯ
// (референс такое скипает, но стопы градиента — те же цвета эффекта)
{
  const t = 'm_ColorGradient = { {1,0,0}, {0,1,0} }';
  const r = rc(t);
  ok('nested-array-painted', r.replaced === 2 && r.total === 2, r.text);
  ok('nested-array-blue', r.text === 'm_ColorGradient = { {0,0,1}, {0,0,1} }', r.text);
}
// 32. веса, а не RGB — скип через skip-лист (в обеих скобках)
{
  for (const t of ['m_ColorWeights = { 1, 1, 1 }', 'm_ColorWeights = [ 1, 1, 1 ]']) {
    const r = rc(t);
    ok(`weights-skipped:${t.includes('{') ? '{}' : '[]'}`, r.text === t && r.total === 0, r.text);
  }
}
// 33. f-суффикс принимаем, на выходе plain float
{
  const r = rc('m_Color = { 1.0f, 0.0f, 0.0f }');
  ok('f-suffix', r.replaced === 1 && /\{\s*0\.0,\s*0\.0,\s*1\.0\s*\}/.test(r.text), r.text);
}
// 34. hex — скип, не портим
{
  const t = 'm_Color = { 0x1, 0x1, 0x1 }';
  const r = rc(t);
  ok('hex-skipped', r.text === t && r.total === 0, r.text);
}
// 35. комментарий ПОСЛЕ закрытия — цел, числа правятся
{
  const t = 'm_Color = [ 1.0, 0.0, 0.0 ] // trailing comment';
  const r = rc(t);
  ok('trailing-comment', r.replaced === 1 && r.text.endsWith('] // trailing comment'), r.text);
}
// 36. /* */ комментарий ПЕРЕД полем — цел
{
  const t = '/* multi-line */ m_Color = [ 1.0, 0.0, 0.0 ]';
  const r = rc(t);
  ok('comment-before-field', r.replaced === 1 && r.text.startsWith('/* multi-line */ m_Color = ['), r.text);
}
// 37. /* */ комментарий между ключом и = — красится, комментарий цел
{
  const t = 'm_Color /* inline */ = [ 1.000000, 0.000000, 0.000000, 1.000000 ]';
  const r = rc(t);
  ok('comment-before-eq', r.replaced === 1 && r.text.includes('/* inline */'), r.text);
}
// 38. /* */ комментарий внутри блока — цел, числа правятся
{
  const t = 'm_Color = [ 1.0, /* g */ 0.0, 0.0 ]';
  const r = rc(t);
  ok('comment-in-block', r.replaced === 1 && r.text.includes('/* g */'), r.text);
}
// 39. два одинаковых блока подряд — красятся оба
{
  const t = 'm_Color = [ 1.0, 0.0, 0.0 ]\nm_Color = [ 1.0, 0.0, 0.0 ]';
  const r = rc(t);
  ok('repeat-blocks', r.replaced === 2 && r.total === 2, r.text);
}
// 40. одинаковые значения, разные поля — красятся оба
{
  const r = rc('m_Color = [ 1.0, 0.0, 0.0 ]\nm_TintColor = [ 1.0, 0.0, 0.0 ]');
  ok('repeat-fields', r.replaced === 2, r.text);
}
// 41. непарные скобки [..} — скип
{
  const t = 'm_Color = [ 1.0, 0.0, 0.0 }';
  const r = rc(t);
  ok('mismatched-brackets', r.text === t && r.total === 0, r.text);
}
// 42. перф: 200 блоков с комментариями обоих видов
{
  const block = '    m_ColorFade = [ 1.000000, /* g */ 0.200000, // b\n 0.100000, 1.000000 ]\n';
  const big = '<!-- kv3 -->\n{\n' + block.repeat(200) + '}';
  const t0 = Date.now();
  const r = rc(big);
  const dt = Date.now() - t0;
  ok('perf-comments', r.replaced === 200 && dt < 3000, `replaced=${r.replaced} dt=${dt}ms`);
}

// 43. цифры внутри /* */ — не компоненты: блок красится, коммент цел
{
  const t = 'm_Color = [ 1.000000, 0.000000 /* , 0.5 */, 0.000000 ]';
  const r = rc(t);
  ok('comment-digits-kept', r.text.includes('/* , 0.5 */'), r.text);
  ok('comment-digits-recolored', r.replaced === 1 && r.total === 1, JSON.stringify({ replaced: r.replaced, total: r.total }));
  ok('comment-digits-blue', /\[\s*0\.000000,\s*0\.000000/.test(r.text) && /1\.000000\s*\]/.test(r.text), r.text);
}
// 44. цифры внутри // — не компоненты и не затираются
{
  const t = 'm_Color = [ 1.0, 0.0, 0.0 ] // v2 alpha 1';
  const r = rc(t);
  ok('line-comment-digits-kept', r.text.includes('// v2 alpha 1'), r.text);
  ok('line-comment-digits-recolored', r.replaced === 1, r.text);
}
// 45. смешанный [255, 0.5, 0.0] — байтовый масштаб, без почернения и мусора
{
  const t = 'm_Color = [ 255, 0.5, 0.0 ]';
  const r = rc(t);
  const nums = (r.text.match(/[+-]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
  ok('mixed-byte-recolored', r.replaced === 1, r.text);
  ok('mixed-byte-no-huge', nums.every(n => Math.abs(n) <= 255), r.text);
  ok('mixed-byte-not-black', /0,\s*0\.0,\s*255\.0\s*\]/.test(r.text), r.text);
}

// 46. числа без запятых (как принимает референс) — красятся
{
  const r = rc('m_Color = [ 1.0 0.0 0.0 ]');
  ok('ws-separated', r.replaced === 1 && /0\.0\s+0\.0\s+1\.0/.test(r.text), r.text);
}
// 47. ключ в кавычках — красится, кавычки целы
{
  const r = rc('"m_Color" = [ 1.0, 0.0, 0.0 ]');
  ok('quoted-key', r.replaced === 1 && r.text.startsWith('"m_Color" = ['), r.text);
}
// 48. ключ в кавычках, но веса — скип
{
  const t = '"m_ColorWeights" = [ 1, 1, 1 ]';
  const r = rc(t);
  ok('quoted-weights-skipped', r.text === t && r.total === 0, r.text);
}
// 49. четвёрки внутри градиента {t,r,g,b} — НЕ трогаем (первое число время)
{
  const t = 'm_ColorGradient = { {0, 1,0,0}, {1, 0,0,1} }';
  const r = rc(t);
  ok('gradient-quads-skipped', r.text === t && r.total === 0, r.text);
}
// 50. m_ColorScale / m_NormalColor — тинты, красятся (убраны из skip-листа)
{
  for (const t of ['m_ColorScale = [ 1.0, 0.0, 0.0 ]', 'm_NormalColor = [ 1.0, 0.0, 0.0 ]']) {
    const r = rc(t);
    ok(`scale-normal-painted:${t.split(' ')[0]}`, r.replaced === 1, r.text);
  }
}
// 51. времена/позиции/скорости — по-прежнему скип
{
  const cases = [
    'm_ColorLitTime = [ 1.0, 0.0, 0.0 ]',
    'm_ColorPosition = [ 1, 0, 0 ]',
    'm_ColorFlowRate = [ 1.0, 0.0, 0.0 ]',
  ];
  for (const t of cases) {
    const r = rc(t);
    ok(`trap-still-skipped:${t.split(' ')[0]}`, r.text === t && r.total === 0, r.text);
  }
}
// 52. скобка внутри комментария не ломает поиск конца градиента
{
  const t = 'm_ColorGradient = { /* } */ {1,0,0} }';
  const r = rc(t);
  ok('gradient-comment-brace', r.replaced === 1 && r.total === 1 && r.text.includes('/* } */'), r.text);
}
// 53. серая тройка внутри градиента — найдена, но не красится (sat-guard)
{
  const t = 'm_ColorGradient = { {0.5,0.5,0.5} }';
  const r = rc(t);
  ok('gradient-gray-untouched', r.text === t && r.total === 1 && r.replaced === 0, r.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
