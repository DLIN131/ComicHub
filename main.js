const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const path = require('path')
const fetcher = require('./fetcher')
const downloads = require('./downloads')
const updater = require('./updater')
const library = require('./library')

// 各站共用一般 Chrome 的 UA，Cloudflare 對 Electron 字樣的 UA 比較容易擋
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
app.userAgentFallback = UA

let mainWin = null

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#111116',
    title: 'ComicHub',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWin.removeMenu()
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'))
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      mainWin.setFullScreen(!mainWin.isFullScreen())
      e.preventDefault()
    } else if (input.key === 'F12') {
      mainWin.webContents.toggleDevTools()
      e.preventDefault()
    }
  })
}

/** 各站的圖片 CDN 有的要 Referer，統一在主視窗補上 */
function setupImageHeaders() {
  const ses = session.defaultSession
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, cb) => {
    const site = fetcher.siteForUrl(details.url)
    if (site) details.requestHeaders.Referer = fetcher.base(site) + '/'
    cb({ requestHeaders: details.requestHeaders })
  })
}

/** 登入視窗：直接開該站的登入頁，帳密由使用者自己在網站上輸入，cookie 存在該站專屬的 partition */
function openSiteWindow(site, url, { login = false } = {}) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      parent: mainWin,
      title: login ? `登入 ${fetcher.label(site)}` : fetcher.label(site),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: fetcher.partition(site), contextIsolation: true },
    })
    win.removeMenu()
    // 網站彈出的新視窗（廣告）一律擋掉，站內連結在同一個視窗開
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (fetcher.siteForUrl(u) === site) win.loadURL(u)
      return { action: 'deny' }
    })
    win.loadURL(url)
    win.on('closed', () => resolve())
  })
}

function setupIpc() {
  ipcMain.handle('net:get', (_e, site, url, opts) => fetcher.get(site, url, opts))
  ipcMain.handle('site:config', () => fetcher.config())
  ipcMain.handle('site:setBase', (_e, site, base) => fetcher.setBase(site, base))
  ipcMain.handle('jm:reader', (_e, id) => fetcher.jmReader(id))
  ipcMain.handle('auth:status', (_e, site) => fetcher.authStatus(site))
  ipcMain.handle('auth:login', async (_e, site) => {
    await openSiteWindow(site, fetcher.loginUrl(site), { login: true })
    return fetcher.authStatus(site)
  })
  ipcMain.handle('auth:logout', (_e, site) => fetcher.logout(site))
  ipcMain.handle('site:open', (_e, site, url) => openSiteWindow(site, url))
  ipcMain.handle('shell:external', (_e, url) => shell.openExternal(url))
}

// 同時只開一份：再開一次就把原本的視窗叫到前面（兩份同時跑會互相清掉對方的更新暫存、下載狀態也會打架）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
  })
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return
  fetcher.init(UA)
  setupImageHeaders()
  setupIpc()
  downloads.setup()
  updater.setup()
  library.setup(downloads.dir)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
