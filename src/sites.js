// 三個站的資料轉接層：都轉成同一種格式，畫面那邊不用管是哪個站
//   列表項目 { site, id, title, cover, sub, pages }
//   詳情     { site, id, title, subtitle, cover, tags:[{label,name,query}], info:[[k,v]], chapters:[{id,title}], pages, url }
//   閱讀     [{ url, segs }]（segs > 0 代表 jm 站切條打亂的圖，要重組）

const parser = new DOMParser()
const html = (s) => parser.parseFromString(s, 'text/html')
const abs = (u, base) => {
  if (!u) return ''
  if (u.startsWith('//')) return 'https:' + u
  if (u.startsWith('/')) return base + u
  return u
}
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')

async function call(site, url, opts) {
  const r = await window.hub.get(site, url, opts)
  if (!r.ok) throw new Error(r.error || '載入失敗')
  return r.data
}

let CONFIG = { sites: {} }
const baseOf = (site) => CONFIG.sites[site]?.base || ''

// ============ 語言 ============

export const LANGS = { zh: '中文', en: 'English', ja: '日本語' }

/** 目前的語言篩選（'' = 全部）；nh 站可以直接請伺服器篩，另外兩站在畫面端篩 */
let langFilter = ''
export const setLangFilter = (l) => (langFilter = l || '')

const LANG_RULES = [
  ['zh', /chinese|中文|漢化|汉化|中国翻訳|中國翻譯|中国翻译|中譯|中译|个人翻译|個人翻譯|翻譯|翻译/i],
  ['en', /english|英文|英訳|英語|英语/i],
  ['ja', /japanese|日文|日語|日语|日本語/i],
]

/** 從分類、標籤、標題猜語言；越前面的線索越可信 */
function detectLang(...hints) {
  for (const h of hints) {
    if (!h) continue
    for (const [lang, re] of LANG_RULES) if (re.test(h)) return lang
  }
  return ''
}

/** 標題裡 [Chinese]、[英訳] 這類方括號標記 */
const bracketTags = (title) => (String(title || '').match(/[[【(（][^\]】)）]{1,30}[\]】)）]/g) || []).join(' ')

const NH_LANG_IDS = { 29963: 'zh', 12227: 'en', 6346: 'ja' }
const NH_LANG_NAMES = { zh: 'chinese', en: 'english', ja: 'japanese' }

// ============ nh 站（官方 v2 API） ============

const nh = {
  key: 'nh',
  color: '#ed2553',
  short: 'NH',
  sorts: [
    ['date', '最新'],
    ['popular-today', '今日熱門'],
    ['popular-week', '本週熱門'],
    ['popular', '歷來熱門'],
  ],
  host() {
    return new URL(baseOf('nh')).hostname
  },
  img(prefix, p) {
    if (!p) return ''
    if (/^https?:/.test(p)) return p
    let h = 0
    for (const c of p) h = (h * 31 + c.charCodeAt(0)) | 0
    return `https://${prefix}${(Math.abs(h) % 4) + 1}.${this.host()}/${p.replace(/^\//, '')}`
  },
  item(o) {
    const title = o.english_title || o.japanese_title || o.title?.english || `#${o.id}`
    const ids = o.tag_ids || []
    // 翻譯本同時有 japanese 以外的語言標籤，先看中英
    const lang = ['zh', 'en', 'ja'].find((l) => ids.some((id) => NH_LANG_IDS[id] === l)) || detectLang(bracketTags(title))
    return {
      site: 'nh',
      id: String(o.id),
      title,
      cover: this.img('t', o.thumbnail?.path || o.thumbnail),
      sub: `${o.num_pages || '?'} 頁`,
      pages: o.num_pages,
      lang,
    }
  },
  /** 有語言篩選時把 language:xxx 加進查詢，伺服器就只回那個語言 */
  withLang(q) {
    const l = NH_LANG_NAMES[langFilter]
    return [q.trim(), l ? `language:${l}` : ''].filter(Boolean).join(' ')
  },
  page(o, page) {
    const items = (o.result || []).map((x) => this.item(x))
    return { items, hasMore: page < (o.num_pages || 1), total: o.total }
  },
  async latest(page, sort = 'date') {
    if (sort === 'date' && !langFilter) return this.page(await call('nh', `/api/v2/galleries?page=${page}&per_page=25`, { json: true }), page)
    return this.search('', page, sort)
  },
  async search(q, page, sort = 'date') {
    const query = encodeURIComponent(this.withLang(q) || 'pages:>0')
    return this.page(await call('nh', `/api/v2/search?query=${query}&sort=${sort}&page=${page}`, { json: true }), page)
  },
  async detail(id) {
    const o = await call('nh', `/api/v2/galleries/${id}?include=related`, { json: true })
    const typeName = { artist: '作者', group: '社團', parody: '原作', character: '角色', tag: '標籤', language: '語言', category: '分類' }
    const tags = (o.tags || [])
      .sort((a, b) => Object.keys(typeName).indexOf(a.type) - Object.keys(typeName).indexOf(b.type))
      .map((t) => ({ label: typeName[t.type] || t.type, name: t.name, query: `${t.type}:"${t.name}"` }))
    return {
      site: 'nh',
      id: String(o.id),
      title: o.title?.english || o.title?.pretty || `#${o.id}`,
      subtitle: o.title?.japanese || '',
      cover: this.img('t', o.cover?.path || o.thumbnail?.path),
      tags,
      lang: detectLang((o.tags || []).filter((t) => t.type === 'language' && t.name !== 'translated').map((t) => t.name).join(' ')),
      info: [
        ['編號', `#${o.id}`],
        ['頁數', `${o.num_pages}`],
        ['收藏數', `${o.num_favorites ?? '-'}`],
        ['上傳', o.upload_date ? new Date(o.upload_date * 1000).toLocaleDateString() : '-'],
      ],
      chapters: [],
      pages: o.num_pages,
      reader: (o.pages || []).map((p) => ({ url: this.img('i', p.path), segs: 0 })),
      related: (o.related || []).map((x) => this.item(x)),
      url: `${baseOf('nh')}/g/${o.id}/`,
    }
  },
  async read(d) {
    return d.reader
  },
  async favorites(page) {
    return this.page(await call('nh', `/api/v2/favorites?page=${page}`, { json: true }), page)
  },
  async isFavorite(id) {
    const o = await call('nh', `/api/v2/galleries/${id}/favorite`, { json: true })
    return !!(o.favorited ?? o.is_favorite ?? o.favorite)
  },
  async setFavorite(id, on) {
    await call('nh', `/api/v2/galleries/${id}/favorite`, { json: true, method: on ? 'POST' : 'DELETE' })
  },
}

// ============ jm 站（網頁） ============

const JM_LANG_TAG = { zh: '中文', en: '英文', ja: '日文' }

const jm = {
  key: 'jm',
  color: '#ff8a00',
  short: 'JM',
  sorts: [
    ['mr', '最新'],
    ['mv', '最多觀看'],
    ['tf', '最多喜歡'],
    ['mp', '最多圖片'],
  ],
  list(doc, page) {
    const base = baseOf('jm')
    const seen = new Set()
    const items = []
    for (const a of doc.querySelectorAll('a[href*="/album/"]')) {
      const m = a.getAttribute('href').match(/\/album\/(\d+)/)
      const img = a.querySelector('img')
      const src = (img && [img.getAttribute('data-original'), img.getAttribute('data-src'), img.getAttribute('src')].find((u) => u && !u.includes('blank.'))) || ''
      // 選單、廣告裡也有連到作品的圖示，只收封面在 /media/albums/ 的
      if (!m || !src.includes('/media/albums/') || seen.has(m[1])) continue
      seen.add(m[1])
      const box = a.closest('.list-col, .well, .p-b-15') || a.parentElement.parentElement
      const cat = [text(box?.querySelector('.label-category')), text(box?.querySelector('.label-sub'))].filter(Boolean).join('・')
      const title = text(box?.querySelector('.video-title')) || img.getAttribute('title') || img.getAttribute('alt') || `JM${m[1]}`
      const tagText = [...(box?.querySelectorAll('a.tag') || [])].map(text).join(' ')
      items.push({
        site: 'jm',
        id: m[1],
        title,
        cover: abs(src, base),
        sub: cat,
        lang: detectLang(tagText, cat, bracketTags(title)),
      })
    }
    const hasMore = !!doc.querySelector(`.pagination a[href*="page=${page + 1}"]`)
    return { items, hasMore }
  },
  async latest(page, sort = 'mr') {
    // 有語言篩選時改搜該語言標籤（中文／英文／日文），不然英日文的本子很少出現在最新列表
    if (langFilter) return this.search('', page, sort)
    return this.list(html(await call('jm', `/albums?o=${sort}&page=${page}`)), page)
  },
  async search(q, page, sort = 'mr') {
    let query = q.trim()
    const tag = JM_LANG_TAG[langFilter]
    // 站內語法「+A +B」= 兩個都要有；使用者自己有用語法的就不動
    if (tag) query = !query ? tag : /[\s+-]/.test(query) ? query : `+${query} +${tag}`
    return this.list(html(await call('jm', `/search/photos?search_query=${encodeURIComponent(query)}&o=${sort}&page=${page}`)), page)
  },
  async detail(id) {
    const base = baseOf('jm')
    const doc = html(await call('jm', `/album/${id}/`))
    const typeName = { works: '作品', actor: '角色', tags: '標籤', author: '作者' }
    const tags = []
    for (const span of doc.querySelectorAll('span[data-type]')) {
      const type = span.getAttribute('data-type')
      for (const a of span.querySelectorAll('a[class*="web-"]')) {
        const name = text(a)
        if (name && !tags.some((t) => t.name === name && t.type === type)) tags.push({ type, label: typeName[type] || type, name, query: name })
      }
    }
    const order = Object.keys(typeName)
    tags.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    const chapters = []
    for (const a of doc.querySelectorAll('.episode a[href*="/photo/"]')) {
      const m = a.getAttribute('href').match(/\/photo\/(\d+)/)
      if (m && !chapters.some((c) => c.id === m[1])) {
        // 標題常是「第1話 書名 第1話」，把尾巴重複的話數拿掉
        const t = (text(a.querySelector('h3, li')) || text(a)).replace(/^(第\s*\d+\s*話)\s+(.*?)\s*\1$/, '$1 $2')
        chapters.push({ id: m[1], title: t })
      }
    }
    const pageCount = (text(doc.querySelector('.pagecount')).match(/\d+/) || [])[0]
    const date = doc.querySelector('[itemprop="datePublished"]')?.getAttribute('content') || ''
    const cover = doc.querySelector(`img[src*="/media/albums/${id}"]`)?.getAttribute('src')
    const title = text(doc.querySelector('#book-name, h1')) || `JM${id}`
    return {
      site: 'jm',
      id: String(id),
      title,
      subtitle: '',
      cover: abs(cover, base),
      tags,
      lang: detectLang(tags.filter((t) => t.type === 'tags').map((t) => t.name).join(' '), bracketTags(title)),
      info: [
        ['編號', `JM${id}`],
        ['頁數', pageCount || '-'],
        ['上架', date || '-'],
        ['章節', chapters.length ? `${chapters.length} 話` : '單本'],
      ],
      chapters,
      pages: pageCount ? Number(pageCount) : null,
      related: this.list(doc, 1).items.filter((x) => x.id !== String(id)).slice(0, 18),
      url: `${base}/album/${id}/`,
    }
  },
  async read(d, chapterId) {
    const r = await window.hub.jmReader(chapterId || d.id)
    if (!r.ok) throw new Error(r.error || '載入失敗')
    return r.data.pages
  },
  username: '',
  async favorites(page) {
    if (!this.username) {
      const s = await window.hub.authStatus('jm')
      if (!s.loggedIn) throw new Error('尚未登入')
      this.username = s.name
    }
    return this.list(html(await call('jm', `/user/${encodeURIComponent(this.username)}/favorite/albums?page=${page}`)), page)
  },
}

// ============ wn 站（網頁） ============

/** 分類編號 → 語言（同人誌／單行本／雜誌／韓漫 各自分漢化、日語、English） */
const WN_CATE_LANG = { 1: 'zh', 9: 'zh', 10: 'zh', 20: 'zh', 12: 'ja', 13: 'ja', 14: 'ja', 16: 'en', 17: 'en', 18: 'en' }

const wn = {
  key: 'wn',
  color: '#3d8bfd',
  short: 'WN',
  sorts: [['create_time_DESC', '最新']],
  list(doc, page) {
    const base = baseOf('wn')
    const seen = new Set()
    const items = []
    for (const a of doc.querySelectorAll('a[href*="photos-index-aid-"]')) {
      const m = a.getAttribute('href').match(/aid-(\d+)/)
      const img = a.querySelector('img')
      if (!m || !img || seen.has(m[1])) continue
      seen.add(m[1])
      const box = a.closest('li') || a.parentElement.parentElement
      const info = text(box?.querySelector('.info_col'))
      const pages = (info.match(/(\d+)\s*張/) || [])[1]
      const title = a.getAttribute('title') || img.getAttribute('alt') || text(box?.querySelector('.title')) || `#${m[1]}`
      const cate = Number(((box?.querySelector('[class*="cate-"]')?.className || '').match(/cate-(\d+)/) || [])[1])
      items.push({
        site: 'wn',
        id: m[1],
        title,
        cover: abs(img.getAttribute('data-original') || img.getAttribute('src'), base),
        sub: pages ? `${pages} 頁` : '',
        pages: pages ? Number(pages) : null,
        lang: WN_CATE_LANG[cate] || detectLang(bracketTags(title)),
      })
    }
    const pager = doc.querySelector('.paginator, .f_left.paginator')
    const hasMore = !!pager && [...pager.querySelectorAll('a')].some((a) => /後頁|下一頁|>/.test(text(a)) || new RegExp(`(page-|p=)${page + 1}\\b`).test(a.getAttribute('href') || ''))
    return { items, hasMore }
  },
  async latest(page) {
    if (!langFilter) return this.list(html(await call('wn', `/albums-index-page-${page}.html`)), page)
    // 有語言篩選時，把該語言的幾個分類各抓一頁合起來，依編號（新到舊）排
    const cates = Object.keys(WN_CATE_LANG).filter((c) => WN_CATE_LANG[c] === langFilter)
    const pages = await Promise.all(cates.map((c) => call('wn', `/albums-index-page-${page}-cate-${c}.html`).then((s) => this.list(html(s), page))))
    const items = pages.flatMap((p) => p.items).sort((a, b) => Number(b.id) - Number(a.id))
    return { items, hasMore: pages.some((p) => p.hasMore) }
  },
  async search(q, page) {
    const url = `/search/index.php?q=${encodeURIComponent(q)}&m=&syn=yes&f=_all&s=create_time_DESC&p=${page}`
    return this.list(html(await call('wn', url)), page)
  },
  async detail(id) {
    const base = baseOf('wn')
    const doc = html(await call('wn', `/photos-index-aid-${id}.html`))
    // 不存在的編號網站一樣回 200，只是沒有封面和標題
    if (!doc.querySelector('.uwthumb img')) throw new Error('找不到（可能已被刪除）')
    const labels = [...doc.querySelectorAll('.uwconn label')].map(text).filter(Boolean)
    const info = [['編號', `${CONFIG.sites.wn.prefix}${id}`]]
    let pages = null
    for (const l of labels) {
      const [k, ...v] = l.split(/[：:]/)
      if (!v.length) continue
      const val = v.join(':').trim()
      if (k.includes('頁數')) pages = Number((val.match(/\d+/) || [])[0]) || null
      if (!k.includes('編號')) info.push([k.trim(), val])
    }
    const tags = [...doc.querySelectorAll('a.tagshow')].map((a) => ({ label: '標籤', name: text(a), query: text(a) }))
    const category = (info.find(([k]) => k.includes('分類')) || [])[1] || ''
    const intro = text(doc.querySelector('.uwconn p'))
    const introText = intro.replace(/^簡介[：:]\s*/, '')
    if (introText) info.push(['簡介', introText])
    const title = text(doc.querySelector('#bodywrap h2, h2')) || `#${id}`
    return {
      site: 'wn',
      id: String(id),
      title,
      subtitle: '',
      cover: abs(doc.querySelector('.uwthumb img')?.getAttribute('src'), base),
      tags,
      lang: detectLang(category, bracketTags(title)),
      info,
      chapters: [],
      pages,
      related: this.list(doc, 1).items.filter((x) => x.id !== String(id)).slice(0, 18),
      url: `${base}/photos-index-aid-${id}.html`,
    }
  },
  async read(d) {
    const js = await call('wn', `/photos-gallery-aid-${d.id}.html`)
    const re = /url:\s*fast_img_host\+\\?"([^"\\]+)\\?",\s*caption:\s*\\?"([^"\\]*)/g
    const list = []
    let m
    while ((m = re.exec(js))) {
      // 最後一張是站方的「加入收藏」宣傳圖
      if (/\/(themes|static)\//.test(m[1]) || /收藏/.test(m[2])) continue
      list.push({ url: abs(m[1], baseOf('wn')), caption: m[2], segs: 0 })
    }
    const num = (c) => Number((c.match(/\d+/) || [])[0])
    if (list.every((x) => !isNaN(num(x.caption)))) list.sort((a, b) => num(a.caption) - num(b.caption))
    if (!list.length) throw new Error('找不到圖片')
    return list
  },
  async favorites(page) {
    return this.list(html(await call('wn', `/users-users_fav-page-${page}.html`)), page)
  },
}

export const SITES = { nh, jm, wn }
export const SITE_KEYS = ['nh', 'jm', 'wn']

export async function loadConfig() {
  CONFIG = await window.hub.config()
  for (const k of SITE_KEYS) SITES[k].label = CONFIG.sites[k].label
  return CONFIG
}
export const getConfig = () => CONFIG
