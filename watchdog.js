// 啟動自我檢查：主畫面一直沒載好（黑畫面）時自己想辦法，不要讓使用者卡在一片黑。
//   1. 畫面程序當掉、載入失敗、或 20 秒內沒回報「載好了」→ 重新載入一次
//   2. 還是不行 → 下次改用「不用顯示卡加速」重開（顯示卡驅動造成的黑畫面很常見）
//   3. 連這樣都不行 → 顯示說明頁，教使用者重新下載安裝
// 每一步都寫進 userData/startup.log，使用者回報問題時可以看。
const { app, ipcMain } = require('electron')
const fs = require('original-fs')
const path = require('path')

const READY_TIMEOUT = 20000
const file = (n) => path.join(app.getPath('userData'), n)

function log(msg) {
  try {
    const line = `${new Date().toISOString()} v${app.getVersion()} ${msg}\n`
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
    log(`${why} in safe mode → show help page`)
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
    if (reloads) log('ready after reload')
    // 頁面說載好了，但顯示卡出問題時畫面還是可能一片黑：3 秒後擷取畫面看看有沒有任何亮的東西（標題列的字一定是亮的）
    setTimeout(() => checkPainted(win), 3000)
  })
  ipcMain.on('app:error', (_e, msg) => log(`renderer error: ${String(msg).slice(0, 500)}`))
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

module.exports = { beforeReady, watch, log }
