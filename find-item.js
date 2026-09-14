const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node find-item.js [--input <catalog file>] [--id <item id>]');
  console.log('Defaults: FACEFIX_DIR or ./facefix/ig; item id 12762.');
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const input = option('--input', path.join(process.env.FACEFIX_DIR || path.join(__dirname, 'facefix'), 'ig'));
const t = fs.readFileSync(input, 'utf8');
const i = t.indexOf(`"${option('--id', '12762')}"`);
console.log(t.slice(i, i + 3000));
