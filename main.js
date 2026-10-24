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
    // jm 站一進來就跳整頁廣告公告，蓋住登入表單，直接藏起來
    if (site === 'jm') {
      win.webContents.on('dom-ready', () => {
        win.webContents
          .insertCSS(
            '#outsidenoticeModal,#shunt-modal,#billboard-modal,#bouns-popup,#guide-modal,#headelikes_modal,.modal-backdrop{display:none!important}' +
              'body.modal-open{overflow:auto!important;padding-right:0!important}',
          )
          .catch(() => {})
      })
    }
    // jm 站登入後的頁面讀不太到帳號名稱（收藏網址要用），所以記下使用者在登入表單打的帳號（只讀帳號欄，不碰密碼）
    let typed = ''
    let timer = null
    if (login && site === 'jm') {
      // 沒勾「記住我」的話，網站那邊的登入一陣子沒動就會失效（重開程式後收藏又變空的），所以預設幫忙勾起來
      win.webContents.on('did-finish-load', () => {
        win.webContents
          .executeJavaScript(`document.querySelectorAll('input[name="id_remember"], input[name="login_remember"]').forEach((c) => { c.checked = true }); 0`)
          .catch(() => {})
      })
      timer = setInterval(() => {
        if (win.isDestroyed()) return
        win.webContents
          .executeJavaScript(`(document.querySelector('input[name="username"]') || {}).value || ''`)
          .then((v) => {
            if (v && v.trim()) typed = v.trim()
          })
          .catch(() => {})
      }, 1000)
    }
    // 登入成功（網站跳離登入頁）就自動關窗，使用者才知道成功了
    if (login) {
      let checking = false
      win.webContents.on('did-navigate', async (_e, u) => {
        if (checking || /login/i.test(u)) return
        checking = true
        const s = await fetcher.authStatus(site).catch(() => ({ loggedIn: false }))
        checking = false
        if (s.loggedIn && !win.isDestroyed()) win.close()
      })
    }
    win.loadURL(url)
    win.on('closed', () => {
      clearInterval(timer)
      resolve(typed)
    })
  })
}

function setupIpc() {
  ipcMain.handle('net:get', (_e, site, url, opts) => fetcher.get(site, url, opts))
  ipcMain.handle('site:config', () => fetcher.config())
  ipcMain.handle('site:setBase', (_e, site, base) => fetcher.setBase(site, base))
  ipcMain.handle('jm:reader', (_e, id) => fetcher.jmReader(id))
  ipcMain.handle('auth:status', (_e, site) => fetcher.authStatus(site))
  ipcMain.handle('auth:login', async (_e, site) => {
    const typed = await openSiteWindow(site, fetcher.loginUrl(site), { login: true })
    const s = await fetcher.authStatus(site)
    if (s.loggedIn && !s.name && typed) {
      fetcher.setAccountName(site, typed)
      s.name = typed
    }
    return s
  })
  ipcMain.handle('auth:setName', (_e, site, name) => fetcher.setAccountName(site, name))
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
