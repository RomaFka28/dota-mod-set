const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mods', {
  catalog: () => ipcRenderer.invoke('catalog:get'), settings: () => ipcRenderer.invoke('settings:get'), saveSettings: value => ipcRenderer.invoke('settings:save', value), addCatalogSource: url => ipcRenderer.invoke('catalog:add-source', url), removeCatalogSource: url => ipcRenderer.invoke('catalog:remove-source', url),
  download: mod => ipcRenderer.invoke('mod:download', mod), cached: id => ipcRenderer.invoke('mod:cached', id), apply: payload => ipcRenderer.invoke('set:apply', payload), extend: payload => ipcRenderer.invoke('set:extend', payload),
  installed: () => ipcRenderer.invoke('sets:list'), activeSetId: () => ipcRenderer.invoke('set:active-id'), rollback: id => ipcRenderer.invoke('set:rollback', id), purgeHistory: () => ipcRenderer.invoke('sets:purge'), chooseGameFolder: () => ipcRenderer.invoke('dialog:game-folder'), openFolder: folder => ipcRenderer.invoke('set:open-folder', folder), openSource: () => ipcRenderer.invoke('source:open'), openAppRepository: () => ipcRenderer.invoke('app-repository:open'),
  installGame: setId => ipcRenderer.invoke('set:install-game', setId), clearGame: () => ipcRenderer.invoke('set:clear-game'),
  deleteWorkshop: modId => ipcRenderer.invoke('workshop:delete-mod', modId),
  deleteCached: modId => ipcRenderer.invoke('mod:delete-cached', modId), cachedIds: ids => ipcRenderer.invoke('mods:cached-ids', ids), installedIds: () => ipcRenderer.invoke('mods:installed-ids')
});
contextBridge.exposeInMainWorld('workshop', {
  toolStatus:      gamePath => ipcRenderer.invoke('workshop:tool-status', gamePath),
  downloadTool:    ()       => ipcRenderer.invoke('workshop:download-tool'),
  listParticles:   (gamePath, query) => ipcRenderer.invoke('workshop:list-particles', { gamePath, query }),
  build:           params   => ipcRenderer.invoke('workshop:build', params),
  preflight:       ()       => ipcRenderer.invoke('workshop:preflight'),
  findDuplicate:   (paths, hue) => ipcRenderer.invoke('workshop:find-duplicate', { paths, hue }),
  closeApp:        id       => ipcRenderer.invoke('workshop:close-app', id),
  vrfHelp:         ()       => ipcRenderer.invoke('workshop:vrf-help'),
  openUrl:         url      => ipcRenderer.invoke('workshop:open-url', url),
  onProgress:      cb       => ipcRenderer.on('workshop:progress', (_, msg) => cb(msg)),
  offProgress:     ()       => ipcRenderer.removeAllListeners('workshop:progress'),
});
