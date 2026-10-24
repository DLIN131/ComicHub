// 程式自己的資料（閱讀進度、紀錄、分組、設定、下載紀錄）存在 userData/state.json，由主程序寫檔。
// 以前放在 Chromium 的 localStorage：關掉馬上重開時，舊程序的儲存服務還沒完全結束、資料庫被鎖住，
// 新程序就開一個新的，上一次寫的進度整個不見。自己寫檔就不受這個影響。
const { app, ipcMain } = require('electron')
const fs = require('original-fs')
const path = require('path')

const file = () => path.join(app.getPath('userData'), 'state.json')
let data = null
let timer = null

function load() {
  if (data) return data
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    // 主檔壞掉就試備份
    try {
      data = JSON.parse(fs.readFileSync(file() + '.bak', 'utf8'))
    } catch {
      data = {}
    }
  }
  return data
}

/** 先寫暫存檔再改名，寫到一半當機也不會把舊資料弄壞；舊的那份留成 .bak */
function flush() {
  clearTimeout(timer)
  timer = null
  if (!data) return
  const f = file()
  const tmp = f + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(data))
    try {
      fs.copyFileSync(f, f + '.bak')
    } catch {}
    fs.renameSync(tmp, f)
  } catch {}
}

function setup() {
  ipcMain.on('state:all', (e) => {
    e.returnValue = load()
  })
  ipcMain.on('state:set', (_e, key, value) => {
    const d = load()
    if (value === undefined || value === null) delete d[key]
    else d[key] = value
    // 很快就寫（翻頁時每頁都會記一次，所以稍微合併一下）
    if (!timer) timer = setTimeout(flush, 300)
  })
  app.on('before-quit', flush)
  app.on('will-quit', flush)
}

module.exports = { setup, flush }
