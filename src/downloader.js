// 下載佇列：一次下載一本，每本同時抓 4 張圖，邊抓邊交給主程序寫進 .cbz
import { SITES, getConfig } from './sites.js'
import { store } from './store.js'

const CONCURRENCY = 4
const listeners = new Set()
const jobs = loadDone()
let running = false

// 完成和失敗的都留著（失敗的才查得到原因）；下載中的關程式就沒了，不留
const KEEP = ['done', 'error']

function loadDone() {
  return (store.get('downloads', []) || []).filter((j) => KEEP.includes(j.status))
}

function persist() {
  const done = jobs.filter((j) => KEEP.includes(j.status)).slice(0, 300)
  store.set(
    'downloads',
    done.map(({ d, ...rest }) => rest),
  )
}

function emit() {
  for (const fn of listeners) fn(jobs)
}

export const onChange = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const allJobs = () => jobs
export const activeCount = () => jobs.filter((j) => j.status === 'queued' || j.status === 'running').length

/** 檔名：[來源] 標題（多話的加上 - 話數） */
/** 作品（或單話）的編號標記，例如 JM123、#456；放進檔名讓不同作品的檔案絕不會撞名互蓋 */
function idTag(d, chapter) {
  const id = String(chapter?.id || d.id)
  if (d.site === 'eh') return `EH${id.split('_')[0]}`
  return `${getConfig().sites[d.site]?.prefix || ''}${id}`
}

/**
 * 檔名：[來源] 標題 - 話數 (編號)
 * 標題太長只截標題，話數和編號一定留著（以前整串截斷，長標題的各話會變成同一個檔名互相覆蓋）
 */
export function fileName(d, chapter) {
  const multi = chapter && d.chapters.length > 1
  const head = `[${SITES[d.site].label}] `
  const tail = `${multi && chapter.title ? ` - ${chapter.title.slice(0, 40)}` : ''} (${idTag(d, chapter)})`
  const room = Math.max(20, 150 - head.length - tail.length)
  const title = d.title.length > room ? d.title.slice(0, room).trim() + '…' : d.title
  return head + title + tail
}

export const isQueued = (d, chapterId) =>
  jobs.some((j) => j.site === d.site && j.id === d.id && j.chapterId === (chapterId || null) && (j.status === 'queued' || j.status === 'running'))

export function enqueue(d, chapter) {
  if (isQueued(d, chapter?.id)) return false
  // 重新下載同一本時，舊的那筆紀錄拿掉
  const name = fileName(d, chapter)
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].name === name) jobs.splice(i, 1)
  jobs.unshift({
    key: `${d.site}_${d.id}_${chapter?.id || ''}_${Date.now()}`,
    site: d.site,
    id: d.id,
    chapterId: chapter?.id || null,
    title: d.title,
    chapterTitle: chapter && d.chapters.length > 1 ? chapter.title : '',
    cover: d.cover,
    name,
    status: 'queued',
    done: 0,
    total: 0,
    d,
  })
  emit()
  pump()
  return true
}

export function cancel(key) {
  const j = jobs.find((x) => x.key === key)
  if (!j) return
  if (j.status === 'queued') j.status = 'canceled'
  else if (j.status === 'running') j.cancel = true
  emit()
}

export function retry(key) {
  const j = jobs.find((x) => x.key === key)
  if (!j || !j.d) return
  Object.assign(j, { status: 'queued', done: 0, total: 0, error: '', cancel: false })
  emit()
  pump()
}

export function clearFinished() {
  for (let i = jobs.length - 1; i >= 0; i--) if (!['queued', 'running'].includes(jobs[i].status)) jobs.splice(i, 1)
  persist()
  emit()
}

async function pump() {
  if (running) return
  running = true
  for (;;) {
    const j = [...jobs].reverse().find((x) => x.status === 'queued')
    if (!j) break
    j.status = 'running'
    emit()
    try {
      j.file = await run(j)
      j.status = 'done'
      j.finishedAt = Date.now()
    } catch (e) {
      j.status = j.cancel ? 'canceled' : 'error'
      j.error = e.message
    }
    persist()
    emit()
  }
  running = false
}

const extOf = (type, url) => {
  const t = (type || '').toLowerCase()
  if (t.includes('webp')) return 'webp'
  if (t.includes('png')) return 'png'
  if (t.includes('gif')) return 'gif'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  const m = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

/** jm 站切條打亂的圖：解碼 → 拼回 → 重新存成 JPEG */
async function descramble(data, num) {
  const bmp = await createImageBitmap(new Blob([data]))
  const w = bmp.width
  const hgt = bmp.height
  const c = new OffscreenCanvas(w, hgt)
  const ctx = c.getContext('2d')
  const over = hgt % num
  const base = Math.floor(hgt / num)
  for (let i = 0; i < num; i++) {
    let move = base
    const ySrc = hgt - base * (i + 1) - over
    let yDst = base * i
    if (i === 0) move += over
    else yDst += over
    ctx.drawImage(bmp, 0, ySrc, w, move, 0, yDst, w, move)
  }
  bmp.close()
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return new Uint8Array(await blob.arrayBuffer())
}

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

/** 漫畫閱讀器（Komga、Kavita、CDisplayEx…）認得的 metadata */
function comicInfo(j, pageCount) {
  const d = j.d
  const author = d.tags.filter((t) => t.label === '作者').map((t) => t.name)
  const tags = d.tags.filter((t) => t.label !== '作者').map((t) => t.name)
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${xml(j.chapterTitle || d.title)}</Title>`,
    j.chapterTitle ? `  <Series>${xml(d.title)}</Series>` : '',
    j.chapterTitle ? `  <Number>${d.chapters.findIndex((c) => c.id === j.chapterId) + 1}</Number>` : '',
    author.length ? `  <Writer>${xml(author.join(', '))}</Writer>` : '',
    tags.length ? `  <Tags>${xml(tags.join(', '))}</Tags>` : '',
    `  <Web>${xml(d.url)}</Web>`,
    `  <PageCount>${pageCount}</PageCount>`,
    `  <Notes>${xml(`${SITES[d.site].label} ${d.id}`)}</Notes>`,
    '</ComicInfo>',
  ]
  return lines.filter(Boolean).join('\n')
}

async function run(j) {
  const pages = await SITES[j.site].read(j.d, j.chapterId)
  if (!pages.length) throw new Error('沒有圖片')
  j.total = pages.length
  emit()
  const z = await window.hub.dl.open(j.name)
  if (!z.ok) throw new Error(z.error)
  const width = Math.max(3, String(pages.length).length)
  let next = 0
  let failed = null
  // 同時抓好幾張，但寫進 zip 一律照頁碼順序（有些閱讀器照 zip 內順序翻頁）
  const ready = new Map()
  let written = 0
  let flushing = Promise.resolve()
  const flush = () =>
    (flushing = flushing.then(async () => {
      while (ready.has(written) && !failed) {
        const { name, data } = ready.get(written)
        ready.delete(written)
        const w = await window.hub.dl.add(z.id, name, data)
        if (!w.ok) failed = w.error
        written++
      }
    }))
  const worker = async () => {
    while (next < pages.length && !failed && !j.cancel) {
      const i = next++
      const p = pages[i]
      let r
      try {
        if (p.resolve && !p.url) p.url = await p.resolve(false)
        r = await window.hub.dl.fetch(j.site, p.url)
        // 圖片伺服器掛掉時換一台再試
        if (!r.ok && p.resolve) r = await window.hub.dl.fetch(j.site, (p.url = await p.resolve(true)))
      } catch (e) {
        r = { ok: false, error: e.message }
      }
      if (!r.ok) {
        failed = `第 ${i + 1} 頁：${r.error}`
        break
      }
      let data = r.data
      let ext = extOf(r.type, p.url)
      if (p.segs > 0) {
        data = await descramble(data, p.segs)
        ext = 'jpg'
      }
      ready.set(i, { name: `${String(i + 1).padStart(width, '0')}.${ext}`, data })
      j.done++
      emit()
      await flush()
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await flush()
  if (failed || j.cancel) {
    await window.hub.dl.abort(z.id)
    throw new Error(j.cancel ? '已取消' : failed)
  }
  await window.hub.dl.add(z.id, 'ComicInfo.xml', comicInfo(j, pages.length))
  const f = await window.hub.dl.finish(z.id)
  if (!f.ok) throw new Error(f.error)
  return f.file
}
