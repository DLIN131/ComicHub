// 程式自己的資料要放哪：以 ComicHub 程式所在的資料夾為主（和 ComicHub.exe 放一起），
// 不要散到「下載」這種跟程式無關的地方。
//   打包版：ComicHub.exe 所在的資料夾
//   開發時：專案資料夾（D:\code\another\ComicHub）
// 程式資料夾不能寫（例如裝在 Program Files）時，退回 userData（%APPDATA%\ComicHub）。
const { app } = require('electron')
const fs = require('original-fs')
const path = require('path')

let cachedRoot = null

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 程式資料夾（可寫才用），否則 userData */
function root() {
  if (cachedRoot) return cachedRoot
  const appDir = app.isPackaged ? path.dirname(process.execPath) : __dirname
  cachedRoot = canWrite(appDir) ? appDir : app.getPath('userData')
  return cachedRoot
}

/** 下載的漫畫預設放這裡 */
const defaultDownloadDir = () => path.join(root(), 'downloads')

/** 觀看紀錄的備份放這裡（userData 被整個刪掉時拿來還原） */
const backupDir = () => path.join(root(), 'backup')

/** 舊版的預設位置（Windows 的「下載」資料夾），只拿來相容：找舊漫畫、還原 / 清掉舊備份 */
const legacyDownloadDir = () => path.join(app.getPath('downloads'), 'ComicHub')

module.exports = { root, defaultDownloadDir, backupDir, legacyDownloadDir }
