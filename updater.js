// 桌面版程式內更新：下載新版 zip → 解壓到暫存資料夾 → 關閉程式後由批次檔覆蓋安裝資料夾 → 重新啟動
const { app, ipcMain, net } = require('electron')
const { spawn, execFile } = require('child_process')
// 一定要用 original-fs：Electron 的 fs 會把解壓出來的 app.asar 當成資料夾，
// 刪不掉（ENOTEMPTY）還會一直開著它（之後 EBUSY），結果第二次以後的更新全部失敗
const fs = require('original-fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'ComicHub-update')
const installDir = path.dirname(process.execPath)
let work = null
let extracted = null

/** 清掉以前的更新暫存；刪不掉的（例如被鎖住）就留著，下次再清，不影響這次更新 */
function cleanOld() {
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  for (const n of names) {
    try {
      fs.rmSync(path.join(root, n), { recursive: true, force: true })
    } catch {}
  }
}

/** 安裝資料夾能不能寫入（放在 Program Files 之類的地方就不行） */
function canWrite() {
  try {
    const probe = path.join(installDir, '.update-probe')
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

async function download(url, onProgress) {
  cleanOld()
  // 每次更新用新的資料夾，舊的殘留就算刪不掉也擋不到
  work = path.join(root, String(Date.now()))
  fs.mkdirSync(work, { recursive: true })
  const zip = path.join(work, 'update.zip')
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const out = fs.createWriteStream(zip)
  const reader = res.body.getReader()
  let got = 0
  let last = -1
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    if (!out.write(value)) await new Promise((r) => out.once('drain', r))
    const p = total ? Math.floor((got * 100) / total) : -1
    if (p !== last) { last = p; onProgress(p) }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  return zip
}

function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()))
  })
}

function setup() {
  // 上次更新留下的下載檔和解壓縮檔（約 200 MB）。程式能啟動就代表更新已經裝完，直接清掉
  setTimeout(cleanOld, 3000)

  ipcMain.handle('update:supported', () => app.isPackaged && process.platform === 'win32')

  ipcMain.handle('update:download', async (e, url) => {
    if (!app.isPackaged) throw new Error('開發模式不能更新')
    if (!canWrite()) throw new Error('程式所在的資料夾沒有寫入權限，請把 ComicHub 資料夾移到桌面或文件夾後再更新')
    const zip = await download(url, (p) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', p) })
    const dest = path.join(work, 'files')
    await unzip(zip, dest)
    if (!fs.existsSync(path.join(dest, path.basename(process.execPath)))) throw new Error('更新檔內容不正確')
    extracted = dest
    return true
  })

  ipcMain.handle('update:install', () => {
    if (!extracted) throw new Error('還沒下載更新')
    // 等目前的程式完全結束再覆蓋檔案（執行中的 exe 和 app.asar 會被鎖住），覆蓋完重新開啟
    const exe = path.join(installDir, path.basename(process.execPath))
    // 用 PowerShell 等程式結束（批次檔在沒有主控台時 tasklist | find 會卡住），
    // 腳本只放英數字，路徑全部用環境變數（Unicode）傳進去，資料夾名稱有中文也不會變亂碼
    const script = path.join(work, 'update.ps1')
    fs.writeFileSync(script, [
      '$log = $env:AP_LOG',
      '"start $(Get-Date -Format o)" | Set-Content -LiteralPath $log',
      'Wait-Process -Id ([int]$env:AP_PID) -ErrorAction SilentlyContinue',
      'Start-Sleep -Milliseconds 500',
      '"app exited $(Get-Date -Format o)" | Add-Content -LiteralPath $log',
      '& robocopy.exe $env:AP_SRC $env:AP_DST /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
      '"robocopy $LASTEXITCODE $(Get-Date -Format o)" | Add-Content -LiteralPath $log',
      'Start-Process -FilePath $env:AP_EXE -WorkingDirectory $env:AP_DST',
      '',
    ].join('\r\n'), 'ascii')
    // 非 detached 的子程序會被放進「父程序結束就一起關掉」的 job，所以一定要 detached；
    // 但 detached 的程序沒有主控台，PowerShell 會直接結束。
    // 解法：detached 的 cmd 再用 start 開 PowerShell，讓它有自己的（最小化、隱藏的）主控台
    spawn('cmd.exe', ['/d', '/c', `start "" /min powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`], {
      detached: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        AP_PID: String(process.pid),
        AP_SRC: extracted,
        AP_DST: installDir,
        AP_EXE: exe,
        AP_LOG: path.join(work, 'update.log'),
      },
    }).unref()
    setTimeout(() => app.quit(), 300)
    return true
  })
}

module.exports = { setup }
