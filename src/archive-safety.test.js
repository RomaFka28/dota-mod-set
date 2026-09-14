const { validateArchiveEntries } = require('./archive-safety');

const cases = [
  ['valid', () => validateArchiveEntries([{ name: 'assets/custom/font.ttf', size: 12 }])],
  ['traversal', () => validateArchiveEntries([{ name: '../escape.vpk', size: 1 }])],
  ['absolute', () => validateArchiveEntries([{ name: 'C:/escape.vpk', size: 1 }])],
  ['too-many', () => validateArchiveEntries(Array.from({ length: 2001 }, (_, i) => ({ name: `${i}.vpk`, size: 0 })))]
];
let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    if (name !== 'valid') { console.error(`FAIL ${name}`); failed++; }
    else console.log(`ok   ${name}`);
  } catch (error) {
    if (name === 'valid') { console.error(`FAIL ${name}: ${error.message}`); failed++; }
    else console.log(`ok   ${name}`);
  }
}
process.exit(failed ? 1 : 0);
