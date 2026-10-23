// 本機書櫃：讀下載資料夾裡的 .cbz，透過 cbz:// 協定把圖片給頁面看（不需要網路）
const { app, dialog, ipcMain, protocol, shell } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const IMAGE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' }

// 要在 app ready 之前註冊，頁面才能把 cbz:// 當成一般圖片網址用
protocol.registerSchemesAsPrivileged([{ scheme: 'cbz', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// ---------- 讀 zip（支援 STORE 和 DEFLATE，其他軟體做的 cbz 也能開） ----------

async function readDirectory(file) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip / cbz 檔')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff) throw new Error('不支援超過 4 GB 的檔案')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const entries = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen)
      entries.push({
        name: nameBuf.toString('utf8'),
        method: cd.readUInt16LE(p + 10),
        compSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    await fh.close()
  }
}

async function readEntry(file, e) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const head = Buffer.alloc(30)
    await fh.read(head, 0, 30, e.offset)
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 內容損壞')
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
    const data = Buffer.alloc(e.compSize)
    await fh.read(data, 0, e.compSize, start)
    if (e.method === 0) return data
    if (e.method === 8) return zlib.inflateRawSync(data)
    throw new Error(`不支援的壓縮方式 ${e.method}`)
  } finally {
    await fh.close()
  }
}

// ---------- 書 ----------

/** id → { file, mtime, pages: [entry], info } */
const books = new Map()
const idOf = (file) => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 16)
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : ''
}

async function loadBook(file) {
  const id = idOf(file)
  const st = await fs.promises.stat(file)
  const cached = books.get(id)
  if (cached && cached.mtime === st.mtimeMs) return cached
  const entries = await readDirectory(file)
  const pages = entries.filter((e) => IMAGE.test(e.name) && !e.name.startsWith('__MACOSX/')).sort((a, b) => natural.compare(a.name, b.name))
  let info = {}
  const ci = entries.find((e) => e.name.toLowerCase() === 'comicinfo.xml')
  if (ci) {
    try {
      const xml = (await readEntry(file, ci)).toString('utf8')
      info = { title: tag(xml, 'Title'), series: tag(xml, 'Series'), web: tag(xml, 'Web'), notes: tag(xml, 'Notes'), tags: tag(xml, 'Tags') }
    } catch {}
  }
  const book = { id, file, mtime: st.mtimeMs, size: st.size, pages, info }
  books.set(id, book)
  return book
}

/** 給頁面的資料 */
function summary(b) {
  const name = path.basename(b.file).replace(/\.(cbz|zip)$/i, '')
  // 檔名是「[站名] 標題」或「[站名] 標題 - 第N話」
  const m = name.match(/^\[([^\]]+)\]\s*(.*)$/)
  return {
    id: b.id,
    file: b.file,
    name,
    source: m ? m[1] : '',
    title: b.info.series || (m ? m[2] : name),
    chapter: b.info.series ? b.info.title : '',
    notes: b.info.notes || '',
    web: b.info.web || '',
    pageCount: b.pages.length,
    size: b.size,
    mtime: b.mtime,
    cover: b.pages.length ? `cbz://book/${b.id}/0` : '',
    pages: b.pages.map((_, i) => `cbz://book/${b.id}/${i}`),
  }
}

async function listDir(dir) {
  let names = []
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!/\.(cbz|zip)$/i.test(n)) continue
    try {
      out.push(summary(await loadBook(path.join(dir, n))))
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function setup(getDir) {
  protocol.handle('cbz', async (req) => {
    try {
      const u = new URL(req.url)
      const [, id, index] = u.pathname.split('/')
      const b = books.get(id)
      const e = b && b.pages[Number(index)]
      if (!e) return new Response('not found', { status: 404 })
      const data = await readEntry(b.file, e)
      const ext = (e.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()
      return new Response(data, { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' } })
    } catch (err) {
      return new Response(String(err.message || err), { status: 500 })
    }
  })

  ipcMain.handle('lib:list', () => listDir(getDir()))
  ipcMain.handle('lib:open', async (_e, file) => {
    try {
      return { ok: true, book: summary(await loadBook(file)) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('lib:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: '開啟漫畫檔',
      defaultPath: getDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '漫畫壓縮檔', extensions: ['cbz', 'zip'] }],
    })
    if (r.canceled) return []
    const out = []
    for (const f of r.filePaths) {
      try {
        out.push(summary(await loadBook(f)))
      } catch (err) {
        out.push({ error: `${path.basename(f)}：${err.message}` })
      }
    }
    return out
  })
  // 刪除是移到資源回收筒，誤刪還救得回來
  ipcMain.handle('lib:trash', async (_e, file) => {
    try {
      await shell.trashItem(file)
      books.delete(idOf(file))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}

module.exports = { setup }
