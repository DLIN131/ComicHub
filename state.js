// 程式自己的資料（閱讀進度、紀錄、分組、設定、下載紀錄）存在 userData/state.json，由主程序寫檔。
// 以前放在 Chromium 的 localStorage：關掉馬上重開時，舊程序的儲存服務還沒完全結束、資料庫被鎖住，
// 新程序就開一個新的，上一次寫的進度整個不見。自己寫檔就不受這個影響。
//
// 另外在下載資料夾放一份備份：有使用者為了修黑畫面把 AppData 整個刪掉，觀看紀錄就沒了；
// 下載資料夾放的是使用者的漫畫，不會跟著刪，下次開程式就從那裡還原。
const { app, ipcMain } = require('electron')
const fs = require('original-fs')
const os = require('os')
const path = require('path')

const file = () => path.join(app.getPath('userData'), 'state.json')
const BACKUP_NAME = 'ComicHub 紀錄備份.json'
let data = null
let timer = null
let backupTimer = null
let lastBackup = 0

/** 備份放在下載資料夾：目前設定的那個 + 預設的那個（AppData 刪掉後設定也沒了，只找得到預設的） */
function backupFiles() {
  const dirs = new Set([path.join(app.getPath('downloads'), 'ComicHub')])
  try {
    dirs.add(require('./downloads').dir())
  } catch {}
  return [...dirs].map((d) => path.join(d, BACKUP_NAME))
}

function readJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

function load() {
  if (data) return data
  for (const f of [file(), file() + '.bak']) {
    try {
      data = readJson(f)
      return data
    } catch {}
  }
  // userData 裡完全沒有（被刪掉了）→ 從下載資料夾的備份還原
  for (const f of backupFiles()) {
    try {
      data = readJson(f)
      data._restoredFrom = f
      require('./watchdog').log(`state restored from backup ${f}`)
      flush()
      return data
    } catch {}
  }
  data = {}
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
  scheduleBackup()
}

/** 備份不用每翻一頁就寫，最多一分鐘寫一次；關程式時一定寫 */
function scheduleBackup(now = false) {
  if (now || Date.now() - lastBackup > 60000) return writeBackup()
  if (!backupTimer) backupTimer = setTimeout(writeBackup, 60000 - (Date.now() - lastBackup))
}

function writeBackup() {
  clearTimeout(backupTimer)
  backupTimer = null
  lastBackup = Date.now()
  if (!data) return
  const { _restoredFrom, ...rest } = data
  const text = JSON.stringify({ ...rest, _backupAt: new Date().toISOString(), _host: os.hostname() })
  for (const f of backupFiles()) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f + '.tmp', text)
      fs.renameSync(f + '.tmp', f)
    } catch {}
  }
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
  const finalFlush = () => {
    flush()
    scheduleBackup(true)
  }
  app.on('before-quit', finalFlush)
  app.on('will-quit', finalFlush)
}

module.exports = { setup, flush, backupFiles }
