const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node verify-merge.js [--input <ModelDoc text file>]');
  console.log('Default: FACEFIX_DIR or ./facefix/verify.');
  process.exit(0);
}
const i = args.indexOf('--input');
const input = i >= 0 && args[i + 1] ? args[i + 1] : path.join(process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'), 'verify');
const t = fs.readFileSync(input, 'utf8');
const names = new Set();
for (const m of t.matchAll(/name = "([A-Za-z0-9_]+)"/g)) {
  const v = m[1];
  if (/invoker_head|frostivus|shoulderPad|belt5|clavicle|pigtail|Head_/.test(v)) names.add(v);
}
console.log('meshes/bones:', [...names].join(' | '));
console.log('renderMeshFiles:', (t.match(/RenderMeshFile/g) || []).length);
console.log('materials:', [...new Set([...t.matchAll(/materials\/[\w/]+\.vmat/g)].map(m => m[0]))].join(' | '));
