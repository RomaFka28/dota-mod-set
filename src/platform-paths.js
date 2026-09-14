const path = require('node:path');

function pathApi(platform) { return platform === 'win32' ? path.win32 : path.posix; }

function platformRoots(platform = process.platform, homeDir = process.env.HOME || '') {
  const api = pathApi(platform);
  if (platform === 'darwin') {
    const steam = api.join(homeDir, 'Library', 'Application Support', 'Steam');
    return { steamRoots: [steam], defaultGamePath: api.join(steam, 'steamapps', 'common', 'dota 2 beta') };
  }
  return {
    steamRoots: ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'],
    defaultGamePath: 'D:\\SteamLibrary\\steamapps\\common\\dota 2 beta'
  };
}

function steamLibraryPaths(steamRoot, platform = process.platform) {
  const separator = platform === 'win32' ? '\\' : '/';
  const normalized = String(steamRoot || '').replace(/[\\/]+$/, '');
  return [`${normalized}${separator}steamapps`];
}

function dotaPathFromLibrary(libraryPath, platform = process.platform) {
  return pathApi(platform).join(libraryPath, 'common', 'dota 2 beta');
}

module.exports = { platformRoots, steamLibraryPaths, dotaPathFromLibrary };
