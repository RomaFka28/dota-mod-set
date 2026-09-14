const fs = require('node:fs');
const dir = 'C:/Users/Administrator/AppData/Local/Temp/opencode/facefix';
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.dmx'))) {
  const t = fs.readFileSync(dir + '/' + f, 'latin1');
  console.log('==', f);
  const faces = [...t.matchAll(/faceSets(.{0,60}?)/g)].slice(0, 3);
  for (const m of faces) console.log('  faceset:', JSON.stringify(m[1].replace(/[^\x20-\x7e]/g, '?')));
  const mats = new Set([...t.matchAll(/([\w/]+\.vmat)/g)].map(m => m[1]));
  console.log('  materials:', [...mats].join(' | '));
  const tris = [...t.matchAll(/DmeFaceSet(.?.?.?)/g)].length;
  console.log('  faceset-nodes:', tris);
}
