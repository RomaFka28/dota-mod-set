const fs = require('node:fs');
const t = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/facefix/ig', 'utf8');
const i = t.indexOf('"12762"');
console.log(t.slice(i, i + 3000));
