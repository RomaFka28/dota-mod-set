const fs = require('node:fs');
const path = require('node:path');
const dir = 'C:/Users/Administrator/AppData/Local/Temp/opencode/facefix';
// Зона лица из хитбокса Head_0 базовой модели (мировые координаты, грубо)
const FACE = { x0: 15, x1: 50, y0: -13, y1: 13, z0: 172, z1: 200 };
for (const f of ['g_donor.gltf', 'g_base.gltf']) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let total = 0, inFace = 0;
  const bbox = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
  const seen = new Set();
  for (const m of g.meshes || []) {
    for (const p of m.primitives || []) {
      const ai = p.attributes && p.attributes.POSITION;
      if (ai === undefined || seen.has(ai)) continue;
      seen.add(ai);
      const acc = g.accessors[ai];
      const bv = g.bufferViews[acc.bufferView];
      const buf = fs.readFileSync(path.join(dir, g.buffers[bv.buffer].uri));
      const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride = bv.byteStride || 12;
      for (let i = 0; i < acc.count; i++) {
        const x = buf.readFloatLE(base + i * stride);
        const y = buf.readFloatLE(base + i * stride + 4);
        const z = buf.readFloatLE(base + i * stride + 8);
        total++;
        for (let a = 0; a < 3; a++) {
          const v = [x, y, z][a];
          if (v < bbox[0][a]) bbox[0][a] = v;
          if (v > bbox[1][a]) bbox[1][a] = v;
        }
        if (x > FACE.x0 && x < FACE.x1 && y > FACE.y0 && y < FACE.y1 && z > FACE.z0 && z < FACE.z1) inFace++;
      }
    }
  }
  console.log('==', f, 'verts:', total, 'in-face-box:', inFace);
  console.log('   bbox min:', bbox[0].map(v => v.toFixed(1)).join(','), 'max:', bbox[1].map(v => v.toFixed(1)).join(','));
}
