// Пилот v2: merged invoker_head.vmdl_c → pak02_dir.vpk (перезапись пилота v1)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8');
const start = src.indexOf('// ── CRC-32');
const end = src.indexOf('// ── VPK V1 builder (pure Node.js, без внешних утилит) ──────────────');
const end2 = src.indexOf('return Buffer.concat([hdr, tree, data]);');
if (start < 0 || end2 < 0) throw new Error('маркеры VPK-билдера не найдены');
eval('(function(){' + src.slice(start, end2 + 'return Buffer.concat([hdr, tree, data]);}'.length) + '} ;globalThis.__vpk = buildVpkV1;})()');
const buildVpkV1 = globalThis.__vpk;

const compiled = fs.readFileSync('D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota_addons/dota_mod_set_ws/models/merge/invoker_head.vmdl_c');
const vpk = buildVpkV1([{ fullPath: 'models/heroes/invoker/invoker_head.vmdl_c', data: compiled }]);
const dest = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota_russian/pak02_dir.vpk';
fs.copyFileSync(dest, dest + '.v1bak');
fs.writeFileSync(dest, vpk);
console.log('VPK:', vpk.length, 'Б, записан в', dest, '(v1 сохранён как .v1bak)');
