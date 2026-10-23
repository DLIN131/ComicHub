// 下載成 CBZ：頁面逐張把圖片送過來，這裡邊收邊寫進 zip（圖片本身已壓縮，用 STORE 不再壓）
const { app, dialog, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const fetcher = require('./fetcher')

const settingsFile = () => path.join(app.getPath('userData'), 'downloads.json')
let settings = {}

function dir() {
  return settings.dir || path.join(app.getPath('downloads'), 'ComicHub')
}

// ---------- 極簡 zip 寫入器 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

class ZipWriter {
  constructor(file) {
    this.file = file
    this.tmp = file + '.part'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.fd = fs.openSync(this.tmp, 'w')
    this.offset = 0
    this.entries = []
    this.names = new Set()
  }

  write(buf) {
    fs.writeSync(this.fd, buf)
    this.offset += buf.length
  }

  add(name, data) {
    if (this.names.has(name)) return
    this.names.add(name)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const { time, date } = dosTime()
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4) // version needed
    h.writeUInt16LE(0x0800, 6) // 檔名是 UTF-8
    h.writeUInt16LE(0, 8) // STORE
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(data.length, 18)
    h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(nameBuf.length, 26)
    h.writeUInt16LE(0, 28)
    this.entries.push({ nameBuf, crc, size: data.length, offset: this.offset, time, date })
    this.write(h)
    this.write(nameBuf)
    this.write(data)
  }

  finish() {
    const start = this.offset
    for (const e of this.entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(0, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.size, 20)
      c.writeUInt32LE(e.size, 24)
      c.writeUInt16LE(e.nameBuf.length, 28)
      c.writeUInt32LE(e.offset, 42)
      this.write(c)
      this.write(e.nameBuf)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    this.write(end)
    fs.closeSync(this.fd)
    fs.rmSync(this.file, { force: true })
    fs.renameSync(this.tmp, this.file)
    return this.file
  }

  abort() {
    try {
      fs.closeSync(this.fd)
    } catch {}
    fs.rmSync(this.tmp, { force: true })
  }
}

// ---------- IPC ----------

const jobs = new Map()
let nextId = 1

/** Windows 檔名不能有的字元換掉，太長的截斷 */
function safeName(s) {
  const n = String(s)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return n.length > 150 ? n.slice(0, 150).trim() : n || 'untitled'
}

function setup() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    settings = {}
  }
  const save = () => fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))

  ipcMain.handle('dl:dir', () => dir())
  ipcMain.handle('dl:chooseDir', async (e) => {
    const r = await dialog.showOpenDialog({ title: '選擇下載資料夾', defaultPath: dir(), properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return dir()
    settings.dir = r.filePaths[0]
    save()
    return dir()
  })
  ipcMain.handle('dl:openDir', () => {
    fs.mkdirSync(dir(), { recursive: true })
    return shell.openPath(dir())
  })
  ipcMain.handle('dl:show', (_e, file) => shell.showItemInFolder(file))
  ipcMain.handle('dl:exists', (_e, name) => fs.existsSync(path.join(dir(), safeName(name) + '.cbz')))
  ipcMain.handle('dl:fetch', (_e, site, url) => fetcher.bytes(site, url))
  ipcMain.handle('dl:open', (_e, name) => {
    try {
      const id = nextId++
      jobs.set(id, new ZipWriter(path.join(dir(), safeName(name) + '.cbz')))
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('dl:add', (_e, id, name, data) => {
    const z = jobs.get(id)
    if (!z) return { ok: false, error: '下載工作不存在' }
    try {
      z.add(name, Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('dl:finish', (_e, id) => {
    const z = jobs.get(id)
    jobs.delete(id)
    if (!z) return { ok: false, error: '下載工作不存在' }
    try {
      return { ok: true, file: z.finish() }
    } catch (e) {
      z.abort()
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('dl:abort', (_e, id) => {
    jobs.get(id)?.abort()
    jobs.delete(id)
  })
  // 關程式時把沒下完的 .part 清掉
  app.on('will-quit', () => {
    for (const z of jobs.values()) z.abort()
  })
}

module.exports = { setup }
