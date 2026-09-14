const assert = require('node:assert/strict');
const path = require('node:path');
const { platformRoots, steamLibraryPaths, dotaPathFromLibrary } = require('./platform-paths');

const mac = platformRoots('darwin', '/Users/tester');
assert.equal(mac.steamRoots[0], path.posix.join('/Users/tester', 'Library', 'Application Support', 'Steam'));
assert.equal(mac.defaultGamePath, path.posix.join(mac.steamRoots[0], 'steamapps', 'common', 'dota 2 beta'));
assert.deepEqual(steamLibraryPaths(mac.steamRoots[0], 'darwin'), [path.posix.join(mac.steamRoots[0], 'steamapps')]);

const win = platformRoots('win32', 'C:\\Users\\tester');
assert.equal(win.defaultGamePath, 'D:\\SteamLibrary\\steamapps\\common\\dota 2 beta');
assert.deepEqual(steamLibraryPaths('C:\\Steam', 'win32'), ['C:\\Steam\\steamapps']);
assert.equal(dotaPathFromLibrary('C:\\Steam\\steamapps', 'win32'), path.win32.join('C:\\Steam\\steamapps', 'common', 'dota 2 beta'));
console.log('platform-paths: ok');
