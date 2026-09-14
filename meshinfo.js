const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node meshinfo.js [--dir <directory>]');
  console.log('Default: FACEFIX_DIR or ./facefix.');
  process.exit(0);
}
const i = args.indexOf('--dir');
const dir = i >= 0 && args[i + 1] ? args[i + 1] : (process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'));
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.dmx'))) {
  const t = fs.readFileSync(path.join(dir, f), 'latin1');
  console.log('==', f);
  const faces = [...t.matchAll(/faceSets(.{0,60}?)/g)].slice(0, 3);
  for (const m of faces) console.log('  faceset:', JSON.stringify(m[1].replace(/[^\x20-\x7e]/g, '?')));
  const mats = new Set([...t.matchAll(/([\w/]+\.vmat)/g)].map(m => m[1]));
  console.log('  materials:', [...mats].join(' | '));
  const tris = [...t.matchAll(/DmeFaceSet(.?.?.?)/g)].length;
  console.log('  faceset-nodes:', tris);
}
