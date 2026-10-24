// 啟動自我檢查：主畫面一直沒載好（黑畫面）時自己想辦法，不要讓使用者卡在一片黑。
//   1. 畫面程序當掉、載入失敗、或 20 秒內沒回報「載好了」→ 重新載入一次
//   2. 還是不行 → 改用「不用顯示卡加速」重開（顯示卡驅動造成的黑畫面很常見）
//   3. 還是不行 → 把 ComicHub 自己的資料（state.json 和下載資料夾的備份）改名放旁邊（不刪），用空白資料重開
//      （有使用者把 AppData 全刪才好，代表可能是資料裡某個值讓畫面起不來）
//   4. 連這樣都不行 → 顯示說明頁，教使用者重新下載安裝
// 每一步都寫進 userData/startup.log，使用者回報問題時可以看。
const { app, ipcMain } = require('electron')
const fs = require('original-fs')
const path = require('path')

const READY_TIMEOUT = 20000
const file = (n) => path.join(app.getPath('userData'), n)

/** 記錄用本地時間（以前用 UTC，台灣看起來差 8 小時） */
function localTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const tz = `UTC${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${off % 60 ? ':' + p(Math.abs(off) % 60) : ''}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${tz})`
}

function log(msg) {
  try {
    const line = `${localTime()} v${app.getVersion()} ${msg}\n`
    const f = file('startup.log')
    let old = ''
    try {
      old = fs.readFileSync(f, 'utf8')
    } catch {}
    // 只留最後 200 行
    const lines = (old + line).split('\n').filter(Boolean).slice(-200)
    fs.writeFileSync(f, lines.join('\n') + '\n')
  } catch {}
}

// ---------- 資料暫放一邊 ----------

function readRecovery() {
  try {
    return JSON.parse(fs.readFileSync(file('recovery.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** 把 state.json（含 .bak）和下載資料夾裡的備份改名放旁邊，下次用空白資料開；原檔都留著 */
function setDataAside() {
  const stamp = localTime().slice(0, 19).replace(/[: ]/g, '-')
  const moved = []
  const mv = (from) => {
    if (!fs.existsSync(from)) return
    const to = from.replace(/\.json(\.bak)?$/, `.停用-${stamp}.json$1`)
    try {
      fs.renameSync(from, to)
      moved.push(to)
    } catch {}
  }
  mv(file('state.json'))
  mv(file('state.json.bak'))
  try {
    for (const f of require('./state').backupFiles()) mv(f)
  } catch {}
  try {
    fs.writeFileSync(file('recovery.json'), JSON.stringify({ dataSetAside: new Date().toISOString(), files: moved, notified: false }, null, 2))
  } catch {}
  log(`set data aside: ${moved.join(' | ') || '(nothing to move)'}`)
}

function readSafe() {
  try {
    return JSON.parse(fs.readFileSync(file('safe-mode.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** 要在 app ready 之前呼叫：之前黑畫面過就關掉顯示卡加速 */
function beforeReady() {
  if (readSafe().noGpu) {
    app.disableHardwareAcceleration()
    log('safe mode: hardware acceleration off')
  }
}

// ---------- 自動修復 ----------
// 使用者回報：開起來黑畫面，把 AppData 裡的資料夾整個刪掉才好（但觀看紀錄也跟著沒了）。
// 代表是 Chromium 自己存在 userData 的東西壞了（顯示卡 / 著色器快取最常見）。
// 做法：每次啟動先放一個「啟動中」記號，畫面真的載好才拿掉；
// 下次啟動還看到記號 = 上次沒成功開起來 → 把 Chromium 的東西清掉，只留 ComicHub 自己的資料和登入。

/** ComicHub 自己的檔案，修復時一定保留 */
const KEEP_FILES = new Set([
  'state.json',
  'state.json.bak',
  'accounts.json',
  'library.json',
  'sites.json',
  'downloads.json',
  'safe-mode.json',
  'startup.log',
  'update.log',
  'starting.flag',
  'repair.flag',
  'recovery.json',
  // Cookie 的加密金鑰在這裡，刪了各站登入就讀不出來
  'Local State',
])

/** 把 userData 裡 Chromium 的資料清掉（保留 ComicHub 的資料、各站登入 cookie、還沒搬家的舊版 localStorage） */
function deepClean(why) {
  const ud = app.getPath('userData')
  const removed = []
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      removed.push(path.relative(ud, p))
    } catch {}
  }
  let migrated = false
  try {
    migrated = !!JSON.parse(fs.readFileSync(path.join(ud, 'state.json'), 'utf8'))._migrated
  } catch {}
  let names = []
  try {
    names = fs.readdirSync(ud)
  } catch {}
  for (const n of names) {
    // 「停用-」開頭的是自動放在一旁的舊資料，要留給使用者 / 回報用
    if (KEEP_FILES.has(n) || n.includes('.停用-')) continue
    // 各站的登入在 Partitions\<站>\Network（Cookies），其他都可以清
    if (n === 'Partitions') {
      let parts = []
      try {
        parts = fs.readdirSync(path.join(ud, n))
      } catch {}
      for (const p of parts) {
        let inner = []
        try {
          inner = fs.readdirSync(path.join(ud, n, p))
        } catch {}
        for (const i of inner) if (i !== 'Network') rm(path.join(ud, n, p, i))
      }
      continue
    }
    // 舊版的觀看紀錄還在 localStorage、還沒搬到 state.json 的話先別刪
    if (n === 'Local Storage' && !migrated) continue
    rm(path.join(ud, n))
  }
  log(`repair (${why}): removed ${removed.length} items: ${removed.slice(0, 30).join(', ')}`)
}

/**
 * 拿到單一執行鎖之後、app ready 之前呼叫（不能在第二份程式裡做，會清到正在跑的那份）。
 * 上次沒成功開起來、或使用者按了「修復程式」，就清一次。
 */
function repairIfNeeded() {
  if (fs.existsSync(file('repair.flag'))) {
    deepClean('requested by user')
    fs.rmSync(file('repair.flag'), { force: true })
  } else if (fs.existsSync(file('starting.flag'))) {
    deepClean('previous start never finished')
  }
  try {
    fs.writeFileSync(file('starting.flag'), new Date().toISOString())
  } catch {}
}

/** 畫面載好了：拿掉「啟動中」記號 */
function startedOk() {
  try {
    fs.rmSync(file('starting.flag'), { force: true })
  } catch {}
}

/** 「修復程式」按鈕：下次啟動時清一次 */
function requestRepair() {
  try {
    fs.writeFileSync(file('repair.flag'), new Date().toISOString())
  } catch {}
}

function errorPage() {
  const html = `<!doctype html><meta charset="utf-8"><body style="background:#111116;color:#e8e8ee;font:15px 'Microsoft JhengHei UI',sans-serif;padding:40px;line-height:1.8">
<h2>ComicHub 無法正常開啟</h2>
<p>可能是更新時有檔案沒有換好。請到下面的網址下載最新版，解壓縮後覆蓋原本的 ComicHub 資料夾（你的閱讀紀錄、書櫃、登入都不會不見）：</p>
<p style="user-select:text">https://github.com/DLIN131/ComicHub/releases/latest/download/ComicHub-Windows.zip</p>
<p style="color:#9a9aab">問題紀錄在：${file('startup.log').replace(/\\/g, '\\\\')}</p></body>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** 擷取視窗畫面，整張都是暗的（最亮的點都很暗）就當成黑畫面 */
async function checkPainted(win) {
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return
  try {
    const img = await win.capturePage()
    const { width, height } = img.getSize()
    if (!width || !height) return
    const bmp = img.toBitmap() // BGRA
    let max = 0
    // 抽樣就好，不用每個點都看
    for (let i = 0; i < bmp.length; i += 4 * 97) {
      const v = Math.max(bmp[i], bmp[i + 1], bmp[i + 2])
      if (v > max) max = v
      if (max > 120) return // 有亮的東西 = 有畫出來
    }
    log(`window looks black after ready (max brightness ${max})`)
    if (!readSafe().noGpu) {
      log('→ restart without hardware acceleration')
      try {
        fs.writeFileSync(file('safe-mode.json'), JSON.stringify({ noGpu: true, since: new Date().toISOString(), reason: 'black capture' }))
      } catch {}
      app.relaunch()
      app.exit(0)
    }
  } catch (e) {
    log(`capture failed: ${e.message}`)
  }
}

/** 盯著主視窗；renderer 載好會送 app:ready */
function watch(win) {
  let ready = false
  let reloads = 0
  let timer = null

  const giveUp = (why) => {
    if (ready || win.isDestroyed()) return
    clearTimeout(timer)
    if (reloads < 1) {
      reloads++
      log(`${why} → reload`)
      win.webContents.reload()
      arm()
      return
    }
    if (!readSafe().noGpu) {
      log(`${why} again → restart without hardware acceleration`)
      try {
        fs.writeFileSync(file('safe-mode.json'), JSON.stringify({ noGpu: true, since: new Date().toISOString() }))
      } catch {}
      app.relaunch()
      app.exit(0)
      return
    }
    if (!readRecovery().dataSetAside) {
      log(`${why} in safe mode → set ComicHub data aside and restart`)
      setDataAside()
      app.relaunch()
      app.exit(0)
      return
    }
    log(`${why} in safe mode with data set aside → show help page`)
    ready = true
    win.loadURL(errorPage())
  }
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => giveUp('not ready after 20s'), READY_TIMEOUT)
  }

  ipcMain.on('app:ready', (e) => {
    if (e.sender !== win.webContents || ready) return
    ready = true
    clearTimeout(timer)
    startedOk()
    if (reloads) log('ready after reload')
    const rec = readRecovery()
    if (rec.dataSetAside && !rec.notified) {
      log('ready after data was set aside')
      rec.notified = true
      try {
        fs.writeFileSync(file('recovery.json'), JSON.stringify(rec, null, 2))
      } catch {}
      const msg = '上次程式開不起來，已把觀看紀錄檔暫時改名放在一旁（沒有刪除），先用空白紀錄開啟。請把 startup.log 和改名的檔案回報給開發者：' + rec.files.join('、')
      win.webContents.executeJavaScript(`window.__app && window.__app.notice(${JSON.stringify(msg)})`).catch(() => {})
    }
    // 頁面說載好了，但顯示卡出問題時畫面還是可能一片黑：3 秒後擷取畫面看看有沒有任何亮的東西（標題列的字一定是亮的）
    setTimeout(() => checkPainted(win), 3000)
  })
  ipcMain.on('app:error', (_e, msg) => log(`renderer error: ${String(msg).slice(0, 500)}`))
  // 頁面上沒接住的錯誤會印在 console（例如 Uncaught TypeError），全部記下來，回報時才知道是哪一行
  // （preload 在隔離環境裡，收不到頁面本身的錯誤，所以改從這裡收）
  let errCount = 0
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 3 || errCount > 30) return
    errCount++
    log(`page error: ${String(message).slice(0, 400)} @ ${String(source).split('/').pop()}:${line}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain) giveUp(`load failed ${code} ${desc}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    ready = false
    giveUp(`renderer gone (${d.reason})`)
  })
  win.on('unresponsive', () => log('window unresponsive'))
  arm()
}

module.exports = { beforeReady, repairIfNeeded, requestRepair, watch, log, readRecovery }
