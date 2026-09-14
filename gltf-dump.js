const fs = require('node:fs');
for (const f of ['g_donor.gltf', 'g_base.gltf']) {
  const g = JSON.parse(fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/facefix/' + f, 'utf8'));
  console.log('==', f);
  console.log(' meshes:', (g.meshes || []).map(m => m.name + ':' + m.primitives.length).join(' | '));
  (g.meshes || []).forEach((m, mi) => m.primitives.forEach((p, pi) => {
    const ai = p.attributes.POSITION;
    const acc = g.accessors[ai];
    console.log(`   mesh${mi}.prim${pi} posAcc=${ai} type=${acc.type} count=${acc.count} min=${JSON.stringify(acc.min)} max=${JSON.stringify(acc.max)}`);
  }));
}
