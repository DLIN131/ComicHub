// 書櫃備份 / 還原：把紀錄、閱讀進度、合集、分組、設定、書櫃記得的資料夾匯出成一個 JSON 檔，
// 電腦重灌或換電腦後用「從備份檔還原」讀回來。漫畫檔本身（CBZ）不在備份檔裡，要另外複製下載資料夾。
// 合集、分組、閱讀進度都是用檔名對應，所以漫畫換了資料夾也對得起來。
const { app, dialog, ipcMain } = require('electron')
const fs = require('original-fs')
const os = require('os')
const path = require('path')
const paths = require('./paths')
const state = require('./state')
const library = require('./library')
const downloads = require('./downloads')

const KIND = 'comichub-backup'
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function build() {
  const { _restoredFrom, ...st } = state.snapshot()
  return { app: 'ComicHub', kind: KIND, format: 1, exportedAt: new Date().toISOString(), host: os.hostname(), state: st, library: library.indexSnapshot(), downloadDir: downloads.dir() }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 1))
  fs.renameSync(file + '.tmp', file)
}

/** 匯出備份檔或程式自動備份（ComicHub 紀錄備份.json）都讀得懂 */
function parse(text) {
  let obj
  try {
    obj = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch {
    throw new Error('檔案不是有效的 JSON')
  }
  if (obj?.kind === KIND && obj.state && typeof obj.state === 'object') return obj
  const known = ['history', 'progress', 'collections', 'libGroups', 'libGroupList', '_migrated']
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && known.some((k) => k in obj)) {
    const { _backupAt, _host, ...st } = obj
    return { kind: KIND, state: st, library: null, downloadDir: '' }
  }
  throw new Error('這不是 ComicHub 的備份檔')
}

const count = (st) => ({
  history: (st.history || []).length,
  progress: Object.keys(st.progress || {}).length,
  collections: (st.collections || []).length,
  grouped: Object.keys(st.libGroups || {}).length,
})

/** 還原：先把目前的資料另存一份（還原錯了可以再還原回來），再整份換掉 */
function restore(file) {
  const b = parse(fs.readFileSync(file, 'utf8'))
  const safety = path.join(paths.backupDir(), `ComicHub 還原前的資料 ${stamp()}.json`)
  writeJson(safety, build())
  state.replaceAll({ ...b.state, _migrated: true })

  const found = []
  const missing = []
  for (const kind of ['dirs', 'files']) {
    for (const p of b.library?.[kind] || []) {
      if (fs.existsSync(p)) {
        library.remember(kind, p)
        if (kind === 'dirs') found.push(p)
      } else if (kind === 'dirs') missing.push(p)
    }
  }
  // 備份裡的下載資料夾在這台電腦也有（例如外接硬碟）就沿用；沒有就用現在的設定
  let downloadDir = downloads.dir()
  if (b.downloadDir && fs.existsSync(b.downloadDir) && path.resolve(b.downloadDir) !== path.resolve(paths.defaultDownloadDir())) {
    downloads.setDir(b.downloadDir)
    downloadDir = b.downloadDir
  }
  require('./watchdog').log(`backup restored from ${file}`)
  return { ok: true, counts: count(b.state), exportedAt: b.exportedAt || b.state._backupAt || '', host: b.host || '', found, missing, downloadDir, safety }
}

function setup(getWin) {
  ipcMain.handle('backup:export', async () => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: '匯出書櫃備份',
      defaultPath: path.join(paths.backupDir(), `ComicHub 書櫃備份 ${stamp()}.json`),
      filters: [{ name: 'ComicHub 備份', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      const b = build()
      writeJson(r.filePath, b)
      return { ok: true, file: r.filePath, counts: count(b.state) }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('backup:import', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '選擇 ComicHub 備份檔',
      defaultPath: paths.backupDir(),
      filters: [{ name: 'ComicHub 備份', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    try {
      return restore(r.filePaths[0])
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  // 重灌後漫畫複製到別的地方：把那個資料夾加進書櫃
  ipcMain.handle('backup:addDir', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: '選擇放漫畫的資料夾', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    library.remember('dirs', r.filePaths[0])
    return { ok: true, dir: r.filePaths[0] }
  })
}

module.exports = { setup, parse, restore, build }
