// Слияние двух ModelDoc (.vmdl-текстов от VRF):
//   donor = frostivus2018 head (корона+косы, БЕЗ лица)
//   base  = invoker_head (лицо+лысина)
// Результат: donor-скелет + graft костей base + оба RenderMeshFile + оба LOD + Attachment/Hitbox из base.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node merge-model.js [--face <working dir>] [--game <Dota game dir>]');
  console.log('Defaults: FACEFIX_DIR or ./facefix; DOTA_GAME_PATH or ./dota 2 beta.');
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const FACE = option('--face', process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'));
const GAME = option('--game', process.env.DOTA_GAME_PATH || path.join(__dirname, 'dota 2 beta'));
const MERGE = path.join(GAME, 'content', 'dota_addons', 'dota_mod_set_ws', 'models', 'merge');

const donor = fs.readFileSync(path.join(FACE, 'donor'), 'utf8').split('\n');
const base = fs.readFileSync(path.join(FACE, 'base'), 'utf8').split('\n');

// Безопасность хирургии: фигурных скобок внутри строк быть не должно
for (const [nm, arr] of [['donor', donor], ['base', base]]) {
  const stripped = arr.join('\n').replace(/"[^"\n]*"/g, '""');
  const open = (stripped.match(/{/g) || []).length, close = (stripped.match(/}/g) || []).length;
  if (open !== close) throw new Error(`${nm}: дисбаланс скобок вне строк`);
}

const indentOf = line => (line.match(/^\s*/) || [''])[0];
function findLine(arr, substr, from = 0) {
  for (let i = from; i < arr.length; i++) if (arr[i].includes(substr)) return i;
  throw new Error('якорь не найден: ' + substr);
}
// Извлечь блок { ... }, начинающийся nearest-{ выше строки с якорем
function extractBlock(arr, anchorSubstr) {
  const ai = findLine(arr, anchorSubstr);
  let bi = ai;
  while (arr[bi].trim() !== '{') { bi--; if (bi < 0) throw new Error('нет открывающей {: ' + anchorSubstr); }
  let depth = 0;
  for (let i = bi; i < arr.length; i++) {
    for (const ch of arr[i]) { if (ch === '{') depth++; if (ch === '}') depth--; }
    if (depth === 0) return { lines: arr.slice(bi, i + 1), indent: indentOf(arr[bi]), end: i };
  }
  throw new Error('блок не закрыт: ' + anchorSubstr);
}
function reindent(blockLines, targetIndent) {
  const baseIndent = indentOf(blockLines[0]);
  return blockLines.map(l => (l.trim() === '' ? l : targetIndent + l.slice(baseIndent.length)));
}

const out = [...donor];

// 0. Donor-меши тоже берём из content (pak-путей в исходниках нет)
{
  const d0 = findLine(out, 'frostivus2018_invoker_keeper_of_magic_head_frostivus2018_invoker_keeper_of_magic_head.dmx');
  out[d0] = out[d0].replace(/filename = ".*"/, 'filename = "models/merge/donor.dmx"');
  const d1 = findLine(out, 'frostivus2018_invoker_keeper_of_magic_head_frostivus2018_invoker_keeper_of_magic_head_lod11.dmx');
  out[d1] = out[d1].replace(/filename = ".*"/, 'filename = "models/merge/donor_lod1.dmx"');
}

// 1. RenderMeshFile base-мешей после donor-lod1 записи
{
  const fnLine = findLine(out, 'filename = "models/merge/donor_lod1.dmx"');
  let ci = fnLine;
  while (out[ci].trim() !== '},') ci++;
  const ind = indentOf(out[ci - 1]);
  const I = indentOf(out[ci]);
  out.splice(ci + 1, 0,
    `${I}{`,
    `${ind}_class = "RenderMeshFile"`,
    `${ind}name = "invoker_head"`,
    `${ind}filename = "models/merge/base.dmx"`,
    `${I}},`,
    `${I}{`,
    `${ind}_class = "RenderMeshFile"`,
    `${ind}name = "invoker_head_lod1"`,
    `${ind}filename = "models/merge/base_lod1.dmx"`,
    `${I}},`);
}
// 2. LOD-группы: добавить base-меши
for (const [meshAnchor, addName] of [
  ['mesh_name = "frostivus2018_invoker_keeper_of_magic_head"', 'invoker_head'],
  ['mesh_name = "frostivus2018_invoker_keeper_of_magic_head_lod1"', 'invoker_head_lod1'],
]) {
  const li = findLine(out, meshAnchor);
  let ci = li;
  while (out[ci].trim() !== '},') ci++;
  const I = indentOf(out[ci]);
  const F = indentOf(out[li]);
  out.splice(ci + 1, 0, `${I}{`, `${F}mesh_name = "${addName}"`, `${I}},`);
}
// 3. Graft костей base (shoulderPad_L/R, clavicle_R) в конец children Spine_1 донора
{
  const sib = extractBlock(out, 'name = "frostivus2018_invoker_pigtail_l_0"');
  for (const bone of ['name = "shoulderPad_L"', 'name = "shoulderPad_R"', 'name = "clavicle_R"']) {
    const b = extractBlock(base, bone);
    out.splice(sib.end + 1, 0, ...reindent(b.lines, sib.indent));
    sib.end += b.lines.length;
  }
}
// 4. belt5_1 как sibling Spine_1 (после закрытия Spine_1)
{
  const spine = extractBlock(out, 'name = "Spine_1"');
  const b = extractBlock(base, 'name = "belt5_1"');
  out.splice(spine.end + 1, 0, ...reindent(b.lines, spine.indent));
}
// 5. AttachmentList + HitboxSetList из base после закрытия Skeleton донора
{
  const skel = extractBlock(out, '_class = "Skeleton"');
  for (const cls of ['_class = "AttachmentList"', '_class = "HitboxSetList"']) {
    const b = extractBlock(base, cls);
    out.splice(skel.end + 1, 0, ...reindent(b.lines, skel.indent));
    skel.end += b.lines.length;
  }
}

// 6. Раскладка content-исходников
fs.mkdirSync(MERGE, { recursive: true });
const cp = (src, dst) => fs.copyFileSync(path.join(FACE, src), path.join(MERGE, dst));
cp('frostivus2018_invoker_keeper_of_magic_head_frostivus2018_invoker_keeper_of_magic_head.dmx', 'donor.dmx');
cp('frostivus2018_invoker_keeper_of_magic_head_frostivus2018_invoker_keeper_of_magic_head_lod11.dmx', 'donor_lod1.dmx');
cp('invoker_head_invoker_head.dmx', 'base.dmx');
cp('invoker_head_invoker_head_lod11.dmx', 'base_lod1.dmx');
fs.writeFileSync(path.join(MERGE, 'invoker_head.vmdl'), out.join('\n'), 'utf8');

// Проверки результата
const text = out.join('\n');
const checks = [
  ['donor-mesh', text.includes('filename = "models/merge/donor.dmx"')],
  ['base-mesh', text.includes('filename = "models/merge/base.dmx"')],
  ['lod0-both', text.includes('mesh_name = "invoker_head"')],
  ['lod1-both', text.includes('mesh_name = "invoker_head_lod1"')],
  ['shoulderPad_L', text.includes('name = "shoulderPad_L"')],
  ['clavicle_R', text.includes('name = "clavicle_R"')],
  ['belt5_1', text.includes('name = "belt5_1"')],
  ['attachments', text.includes('_class = "AttachmentList"')],
  ['hitboxes', text.includes('_class = "HitboxSetList"')],
  ['no-donor-abs-path', !text.includes('models/items/invoker/frostivus2018_invoker_keeper_of_magic_head/frostivus2018_invoker_keeper_of_magic_head_frostivus2018')],
];
let fail = 0;
for (const [n, c] of checks) { console.log(c ? 'ok  ' : 'FAIL', n); if (!c) fail++; }
process.exit(fail ? 1 : 0);
