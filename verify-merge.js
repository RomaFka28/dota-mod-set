const fs = require('node:fs');
const t = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/facefix/verify', 'utf8');
const names = new Set();
for (const m of t.matchAll(/name = "([A-Za-z0-9_]+)"/g)) {
  const v = m[1];
  if (/invoker_head|frostivus|shoulderPad|belt5|clavicle|pigtail|Head_/.test(v)) names.add(v);
}
console.log('meshes/bones:', [...names].join(' | '));
console.log('renderMeshFiles:', (t.match(/RenderMeshFile/g) || []).length);
console.log('materials:', [...new Set([...t.matchAll(/materials\/[\w/]+\.vmat/g)].map(m => m[0]))].join(' | '));
