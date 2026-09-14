const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node gltf-front.js [--dir <directory>]');
  console.log('Default: FACEFIX_DIR or ./facefix.');
  process.exit(0);
}
const i = args.indexOf('--dir');
const dir = i >= 0 && args[i + 1] ? args[i + 1] : (process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'));
for (const f of ['g_donor.gltf', 'g_base.gltf']) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const acc = g.accessors[g.meshes[0].primitives[0].attributes.POSITION];
  const bv = g.bufferViews[acc.bufferView];
  const buf = fs.readFileSync(path.join(dir, g.buffers[bv.buffer].uri));
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 12;
  const pts = [];
  for (let i = 0; i < acc.count; i++)
    pts.push([buf.readFloatLE(base + i * stride), buf.readFloatLE(base + i * stride + 4), buf.readFloatLE(base + i * stride + 8)]);
  console.log('==', f, 'verts:', acc.count);
  for (const ax of [0, 1, 2]) {
    const vs = pts.map(p => p[ax]).sort((a, b) => a - b);
    // гистограмма 10 корзин
    const lo = vs[0], hi = vs[vs.length - 1];
    const bins = new Array(10).fill(0);
    for (const v of vs) bins[Math.min(9, Math.floor((v - lo) / (hi - lo + 1e-9) * 10))]++;
    console.log(`  ax${ax} [${lo.toFixed(2)}..${hi.toFixed(2)}]:`, bins.join(' '));
  }
}
