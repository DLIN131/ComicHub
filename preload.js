// 頁面不能直接碰網路 session 和視窗，透過這裡呼叫主程序
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
  supported: () => ipcRenderer.invoke('update:supported'),
  download: (url, onProgress) => {
    const listener = (_e, p) => onProgress(p)
    ipcRenderer.on('update:progress', listener)
    return ipcRenderer.invoke('update:download', url).finally(() => ipcRenderer.removeListener('update:progress', listener))
  },
  install: () => ipcRenderer.invoke('update:install'),
})

contextBridge.exposeInMainWorld('hub', {
  get: (site, url, opts) => ipcRenderer.invoke('net:get', site, url, opts),
  config: () => ipcRenderer.invoke('site:config'),
  setBase: (site, base) => ipcRenderer.invoke('site:setBase', site, base),
  jmReader: (id) => ipcRenderer.invoke('jm:reader', id),
  authStatus: (site) => ipcRenderer.invoke('auth:status', site),
  login: (site) => ipcRenderer.invoke('auth:login', site),
  logout: (site) => ipcRenderer.invoke('auth:logout', site),
  openSite: (site, url) => ipcRenderer.invoke('site:open', site, url),
  external: (url) => ipcRenderer.invoke('shell:external', url),
  dl: {
    dir: () => ipcRenderer.invoke('dl:dir'),
    chooseDir: () => ipcRenderer.invoke('dl:chooseDir'),
    openDir: () => ipcRenderer.invoke('dl:openDir'),
    show: (file) => ipcRenderer.invoke('dl:show', file),
    exists: (name) => ipcRenderer.invoke('dl:exists', name),
    fetch: (site, url) => ipcRenderer.invoke('dl:fetch', site, url),
    open: (name) => ipcRenderer.invoke('dl:open', name),
    add: (id, name, data) => ipcRenderer.invoke('dl:add', id, name, data),
    finish: (id) => ipcRenderer.invoke('dl:finish', id),
    abort: (id) => ipcRenderer.invoke('dl:abort', id),
  },
  lib: {
    list: () => ipcRenderer.invoke('lib:list'),
    open: (file) => ipcRenderer.invoke('lib:open', file),
    pick: () => ipcRenderer.invoke('lib:pick'),
    trash: (file) => ipcRenderer.invoke('lib:trash', file),
    forget: (file) => ipcRenderer.invoke('lib:forget', file),
    external: (file) => ipcRenderer.invoke('lib:external', file),
  },
})
