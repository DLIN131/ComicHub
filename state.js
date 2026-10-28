// 程式自己的資料（閱讀進度、紀錄、分組、設定、下載紀錄）存在 userData/state.json，由主程序寫檔。
// 以前放在 Chromium 的 localStorage：關掉馬上重開時，舊程序的儲存服務還沒完全結束、資料庫被鎖住，
// 新程序就開一個新的，上一次寫的進度整個不見。自己寫檔就不受這個影響。
//
// 另外在程式資料夾（ComicHub.exe 旁邊的 backup，見 paths.js）放一份備份：有使用者為了修黑畫面把 AppData 整個刪掉，
// 觀看紀錄就沒了；程式資料夾不會跟著刪，下次開程式就從那裡還原。
// （v1.0.23～1.0.26 的備份放在 Windows 的「下載」資料夾，使用者不希望放那裡：只拿來還原，寫好新備份後刪掉）
const { app, ipcMain } = require('electron')
const fs = require('original-fs')
const os = require('os')
const path = require('path')
const paths = require('./paths')

const file = () => path.join(app.getPath('userData'), 'state.json')
const BACKUP_NAME = 'ComicHub 紀錄備份.json'
let data = null
let timer = null
let backupTimer = null
let lastBackup = 0

/** 現在的備份位置（程式資料夾 / backup） */
function backupFiles() {
  return [path.join(paths.backupDir(), BACKUP_NAME)]
}

/** 舊版放在下載資料夾的備份：Windows「下載\ComicHub」和目前設定的下載資料夾 */
function legacyBackupFiles() {
  const dirs = new Set([paths.legacyDownloadDir()])
  try {
    dirs.add(require('./downloads').dir())
  } catch {}
  return [...dirs].map((d) => path.join(d, BACKUP_NAME)).filter((f) => !backupFiles().includes(f))
}

/** 所有可能的備份（還原、或黑畫面時要放一旁的都看這個） */
const allBackupFiles = () => [...backupFiles(), ...legacyBackupFiles()]

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
  // userData 裡完全沒有（被刪掉了）→ 從備份還原（先找程式資料夾的，再找舊版放在下載資料夾的）
  for (const f of allBackupFiles()) {
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
  let written = false
  for (const f of backupFiles()) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f + '.tmp', text)
      fs.renameSync(f + '.tmp', f)
      written = true
    } catch {}
  }
  // 新備份寫好了，舊版放在下載資料夾的那份就刪掉（使用者不希望放那裡）
  if (written) {
    for (const f of legacyBackupFiles()) {
      try {
        if (fs.existsSync(f)) {
          fs.rmSync(f, { force: true })
          require('./watchdog').log(`moved backup out of download folder: ${f}`)
        }
      } catch {}
    }
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

/** 匯出用：目前全部資料（複本） */
const snapshot = () => JSON.parse(JSON.stringify(load()))

/** 從備份檔還原：整份換掉，馬上寫檔和備份 */
function replaceAll(next) {
  data = { ...next }
  delete data._restoredFrom
  flush()
  scheduleBackup(true)
}

module.exports = { setup, flush, backupFiles, allBackupFiles, snapshot, replaceAll }
