const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node gltf-dump.js [--dir <directory>]');
  console.log('Default: FACEFIX_DIR or ./facefix.');
  process.exit(0);
}
const i = args.indexOf('--dir');
const dir = i >= 0 && args[i + 1] ? args[i + 1] : (process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'));
for (const f of ['g_donor.gltf', 'g_base.gltf']) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('==', f);
  console.log(' meshes:', (g.meshes || []).map(m => m.name + ':' + m.primitives.length).join(' | '));
  (g.meshes || []).forEach((m, mi) => m.primitives.forEach((p, pi) => {
    const ai = p.attributes.POSITION;
    const acc = g.accessors[ai];
    console.log(`   mesh${mi}.prim${pi} posAcc=${ai} type=${acc.type} count=${acc.count} min=${JSON.stringify(acc.min)} max=${JSON.stringify(acc.max)}`);
  }));
}
