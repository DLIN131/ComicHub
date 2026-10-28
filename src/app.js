import { SITES, SITE_KEYS, LANGS, setLangFilter, loadConfig, getConfig } from './sites.js'
import * as dl from './downloader.js'
import { store } from './store.js'

const $ = (s, el = document) => el.querySelector(s)
const view = $('#view')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid))
  return el
}


// ---------- 閱讀進度（看到哪一話、哪一頁） ----------

/** 進度的 key：網站作品用「站別_編號」，書櫃的檔案用檔名（換資料夾也對得上） */
const progressKey = (d) => d.pkey || `${d.site}_${d.id}`
const getProgress = (key) => store.get('progress', {})[key] || null
const progressText = (p) => (p ? `${p.chapterTitle ? `${p.chapterTitle} ` : ''}第 ${p.page + 1} / ${p.total} 頁` : '')

function saveProgress(key, data, histItem) {
  const all = store.get('progress', {})
  all[key] = { ...data, time: Date.now() }
  // 只留最近 1000 本，免得存檔越長越大
  const keys = Object.keys(all)
  if (keys.length > 1000) keys.sort((a, b) => all[a].time - all[b].time).slice(0, keys.length - 1000).forEach((k) => delete all[k])
  store.set('progress', all)
  // 「紀錄」頁的那本也一起更新看到哪
  if (histItem) {
    const list = store.get('history', [])
    const h0 = list.find((x) => x.site === histItem.site && x.id === histItem.id)
    if (h0) {
      h0.sub = `看到：${progressText(all[key])}`
      h0.time = Date.now()
      store.set('history', list)
    }
  }
}

function addHistory(item, chapter) {
  const list = store.get('history', []).filter((x) => !(x.site === item.site && x.id === item.id))
  list.unshift({ site: item.site, id: item.id, title: item.title, cover: item.cover, lang: item.lang || '', sub: chapter ? `看到：${chapter}` : item.sub || '', time: Date.now() })
  store.set('history', list.slice(0, 300))
}

let toastTimer
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600)
}

const badge = (site, inline) => h('span', { class: `badge ${site}${inline ? ' inline' : ''}` }, SITES[site].label)
const langBadge = (lang, inline) => (lang ? h('span', { class: `lang ${lang}${inline ? ' inline' : ''}` }, LANGS[lang]) : null)

// ---------- 語言篩選 ----------

let lang = store.get('lang', '')
setLangFilter(lang)
const passLang = (it) => !lang || it.lang === lang

/**
 * 依語言篩過的一頁。jm、wn 站只能在這邊篩，篩完可能一本都不剩，
 * 這時自動往後多翻幾頁，免得使用者看到空白頁。
 */
async function loadFiltered(loader, page, maxPages = 5) {
  const items = []
  let p = page
  let r
  for (let i = 0; i < maxPages; i++, p++) {
    r = await loader(p)
    items.push(...r.items.filter(passLang))
    if (items.length || !r.hasMore) break
  }
  return { items, hasMore: r.hasMore, last: Math.min(p, page + maxPages - 1) }
}

// ---------- 卡片與列表 ----------

function card(item) {
  return h(
    'div',
    { class: 'card', title: item.title, onclick: () => openDetail(item) },
    h('div', { class: 'thumb' }, h('img', { src: item.cover, loading: 'lazy', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }), badge(item.site), langBadge(item.lang)),
    h('div', { class: 'title' }, item.title),
    h('div', { class: 'sub' }, item.sub || ''),
  )
}

const status = (msg, error) => h('div', { class: `status${error ? ' error' : ''}` }, msg)
const loading = () => h('div', { class: 'status' }, h('span', { class: 'spinner' }), ' 載入中…')

/** 分頁網格：loader(page) 回傳 { items, hasMore } */
function pagedGrid(loader, { empty = '沒有結果' } = {}) {
  const wrap = h('div')
  const grid = h('div', { class: 'grid' })
  const foot = h('div')
  wrap.append(grid, foot)
  let page = 0
  let busy = false
  const seen = new Set()
  async function next() {
    if (busy) return
    busy = true
    foot.replaceChildren(loading())
    try {
      const r = await loadFiltered(loader, page + 1)
      page = r.last
      for (const it of r.items) {
        const key = it.site + it.id
        if (seen.has(key)) continue
        seen.add(key)
        grid.append(card(it))
      }
      foot.replaceChildren()
      if (!grid.children.length) foot.append(status(empty))
      else if (r.hasMore) foot.append(h('button', { class: 'load-more', onclick: next }, '載入更多'))
    } catch (e) {
      foot.replaceChildren(status(e.message, true), h('button', { class: 'load-more', onclick: next }, '重試'))
    }
    busy = false
  }
  next()
  return wrap
}

function subtabs(options, active, onPick) {
  const bar = h('div', { class: 'subtabs' })
  for (const [key, label] of options) {
    bar.append(
      h(
        'button',
        {
          class: key === active ? 'active' : '',
          onclick: () => {
            for (const b of bar.children) b.classList.remove('active')
            bar.querySelector(`[data-k="${key}"]`).classList.add('active')
            onPick(key)
          },
          'data-k': key,
        },
        label,
      ),
    )
  }
  return bar
}

// ---------- 頁面 ----------

let currentNav = 'home'
let lastSearch = null
function setNav(nav) {
  currentNav = nav
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.nav === nav)
}

const pages = {
  home(site = store.get('homeSite', 'all')) {
    setNav('home')
    store.set('homeSite', site)
    const body = h('div')
    const tabs = subtabs([['all', '全部'], ...SITE_KEYS.map((k) => [k, SITES[k].label])], site, (k) => pages.home(k))
    view.replaceChildren(tabs, body)
    if (site === 'all') {
      let failed = 0
      for (const k of SITE_KEYS) {
        const row = h('div', { class: 'row' }, loading())
        body.append(
          h(
            'div',
            { class: 'section' },
            h('div', { class: 'section-head' }, badge(k, true), h('h2', {}, '最新更新'), h('button', { class: 'more', onclick: () => pages.home(k) }, '看更多 →')),
            row,
          ),
        )
        loadFiltered((p) => SITES[k].latest(p), 1)
          .then((r) => row.replaceChildren(...(r.items.length ? r.items.slice(0, 24).map(card) : [status(`沒有${LANGS[lang]}的作品`)])))
          .catch((e) => {
            row.replaceChildren(status(`${e.message}`, true))
            if (++failed === SITE_KEYS.length && currentNav === 'home')
              body.prepend(h('div', { class: 'offline-hint' }, '目前連不上網站。已下載的漫畫可以在「書櫃」離線閱讀 ', h('button', { class: 'btn primary', onclick: () => pages.library() }, '前往書櫃')))
          })
      }
      return
    }
    const s = SITES[site]
    const grid = h('div')
    const sortKey = `sort_${site}`
    const show = (sort) => {
      store.set(sortKey, sort)
      grid.replaceChildren(pagedGrid((p) => s.latest(p, sort)))
    }
    const sort = store.get(sortKey, s.sorts[0][0])
    if (s.sorts.length > 1) body.append(subtabs(s.sorts, sort, show))
    body.append(grid)
    show(sort)
  },

  /** siteQuery：某些站改用別的搜尋字（例如點標籤時，原本的站用標籤語法，其他站用標籤名） */
  search(q, sites, { keyword = false, siteQuery = {} } = {}) {
    setNav('search')
    lastSearch = [q, sites, { keyword, siteQuery }]
    // 輸入編號（或作品網址）時直接開那一本，不做關鍵字搜尋
    const byId = keyword ? null : parseIdQuery(q)
    const useSites = byId ? (byId.sites.length === 1 ? byId.sites : byId.sites.filter((k) => sites.includes(k))) : sites
    const state = SITE_KEYS.filter((k) => useSites.includes(k)).map((k) => ({ site: k, items: [], page: 0, hasMore: true, error: '', busy: false }))
    let filter = 'all'
    const head = h(
      'div',
      { class: 'section-head' },
      h('h2', {}, byId ? `編號 ${byId.id} 的作品` : `「${q}」的搜尋結果`),
      byId && byId.plain ? h('button', { class: 'more', onclick: () => pages.search(q, sites, { keyword: true }) }, `改用關鍵字搜尋「${q}」`) : null,
    )
    const tabs = h('div', { class: 'subtabs' })
    const grid = h('div', { class: 'grid' })
    const foot = h('div')
    view.replaceChildren(head, tabs, grid, foot)

    const renderTabs = () => {
      const opts = [['all', '全部', state.reduce((n, s) => n + s.items.length, 0)], ...state.map((s) => [s.site, SITES[s.site].label, s.items.length])]
      tabs.replaceChildren(
        ...opts.map(([k, label, n]) => {
          const st = state.find((s) => s.site === k)
          const extra = st?.busy ? '…' : st?.error ? '!' : n
          return h(
            'button',
            {
              class: filter === k ? 'active' : '',
              onclick: () => {
                filter = k
                render()
              },
            },
            label,
            h('span', { class: 'count' }, String(extra)),
          )
        }),
      )
    }
    const render = () => {
      renderTabs()
      const shown = filter === 'all' ? state : state.filter((s) => s.site === filter)
      // 「全部」時把三站結果交錯排，才不會一站洗版
      const lists = shown.map((s) => s.items)
      const merged = []
      for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) merged.push(l[i])
      grid.replaceChildren(...merged.map(card))
      foot.replaceChildren()
      for (const s of shown) if (s.error) foot.append(status(`${SITES[s.site].label}：${s.error}`, true))
      if (shown.some((s) => s.busy)) foot.append(loading())
      else if (shown.some((s) => s.hasMore && !s.error)) foot.append(h('button', { class: 'load-more', onclick: () => more(shown) }, '載入更多'))
      else if (!merged.length) foot.append(status('沒有結果'))
    }
    const more = (list) => {
      for (const s of list) {
        if (s.busy || !s.hasMore) continue
        s.busy = true
        s.error = ''
        // 指定編號時不管語言篩選，一定顯示
        const job = byId
          ? SITES[s.site]
              .detail(byId.id)
              .then((d) => ({ items: [{ site: d.site, id: d.id, title: d.title, cover: d.cover, lang: d.lang, sub: d.pages ? `${d.pages} 頁` : '' }], hasMore: false, last: 1 }))
          : loadFiltered((p) => SITES[s.site].search(siteQuery[s.site] || q, p), s.page + 1)
        job
          .then((r) => {
            s.page = r.last
            const seen = new Set(s.items.map((x) => x.id))
            s.items.push(...r.items.filter((x) => !seen.has(x.id)))
            s.hasMore = r.hasMore
          })
          .catch((e) => {
            s.error = byId && /找不到|404/.test(e.message) ? '沒有這個編號' : e.message
            if (byId) s.hasMore = false
          })
          .finally(() => {
            s.busy = false
            if (currentNav === 'search') render()
          })
      }
      render()
    }
    more(state)
  },

  favorites(site = store.get('favSite', 'nh')) {
    setNav('favorites')
    store.set('favSite', site)
    const body = h('div', {}, loading())
    view.replaceChildren(
      subtabs(SITE_KEYS.map((k) => [k, SITES[k].label]), site, (k) => pages.favorites(k)),
      body,
    )
    window.hub.authStatus(site).then((st) => {
      if (currentNav !== 'favorites') return
      if (!st.loggedIn) {
        body.replaceChildren(
          status(st.error ? `無法確認登入狀態：${st.error}` : st.expired ? expiredText(site) : `還沒登入${SITES[site].label}，登入後就能看到網站上的收藏`),
          h('div', { style: 'text-align:center' }, h('button', { class: 'btn primary', onclick: () => doLogin(site).then(() => pages.favorites(site)) }, `登入 ${SITES[site].label}`)),
        )
        return
      }
      if (site === 'jm') SITES.jm.username = st.name
      body.replaceChildren(pagedGrid((p) => SITES[site].favorites(p), { empty: '收藏是空的' }))
    })
  },

  history() {
    setNav('history')
    const list = store.get('history', []).filter(passLang)
    const grid = h('div', { class: 'grid' }, ...list.map(card))
    view.replaceChildren(
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, '最近看過'),
        list.length
          ? h(
              'button',
              {
                class: 'more',
                onclick: () => {
                  if (confirm('清除全部紀錄？')) {
                    store.set('history', [])
                    pages.history()
                  }
                },
              },
              '清除紀錄',
            )
          : null,
      ),
      list.length ? grid : status('還沒有看過任何作品'),
    )
  },

  library() {
    setNav('library')
    const grid = h('div', { class: 'grid' })
    const tabs = h('div', { class: 'subtabs' })
    const body = h('div', {}, loading())
    const filterInput = h('input', { class: 'shelf-filter', type: 'search', placeholder: '在書櫃中找書名或作者…' })
    const selectBar = h('div', { class: 'select-bar hidden' })
    let books = []
    // 建立合集時的選取模式：依點的順序記下書名；pickTarget = 選完要加進哪個合集
    let selecting = null
    let pickTarget = ''
    startShelfPick = (targetId) => {
      selecting = []
      pickTarget = targetId || ''
      store.set('libGroup', 'all')
      render()
      selectBar.scrollIntoView({ block: 'nearest' })
    }
    // 只篩畫面，不重新讀資料夾
    const render = () => {
      if (currentNav !== 'library') return
      const groups = shelfGroups()
      let group = store.get('libGroup', 'all')
      if (group !== 'all' && group !== NO_GROUP && !groups.list.includes(group)) group = 'all'
      const kw = filterInput.value.trim().toLowerCase()
      // 合集排最前面；已經在合集裡的書不再單獨顯示
      const byName = new Map(books.map((b) => [b.name, b]))
      const cols = getCollections().map((c) => resolveCollection(c, byName))
      const inCol = new Set(getCollections().flatMap((c) => c.files))
      const items = [...cols, ...books.filter((b) => !inCol.has(b.name))]
      shelfItems = items
      shelfBooks = books
      const text = (b) => (b.isCol ? `${b.title} ${b.members.map((m) => m.title).join(' ')} ${b.authors.join(' ')}` : `${b.title} ${b.name} ${(b.authors || []).join(' ')}`)
      const langOk = (b) => (b.isCol ? !lang || b.members.some((m) => passLang(localLang(m))) : passLang(localLang(b)))
      // 搜尋時合集裡符合的書也單獨列出來（不然加進合集的書就找不到、點不到它自己的管理視窗）
      const pool = kw ? [...cols, ...books] : items
      const visible = pool.filter((b) => langOk(b) && (!kw || text(b).toLowerCase().includes(kw)))
      const inGroup = (b, g) => (g === 'all' ? true : g === NO_GROUP ? !groups.of[b.name] : groups.of[b.name] === g)
      const opts = [['all', '全部'], [NO_GROUP, '未分組'], ...groups.list.map((g) => [g, g])]
      tabs.replaceChildren(
        ...opts.map(([k, label]) =>
          h(
            'button',
            {
              class: k === group ? 'active' : '',
              onclick: () => {
                store.set('libGroup', k)
                render()
              },
            },
            label,
            h('span', { class: 'count' }, String(visible.filter((b) => inGroup(b, k)).length)),
          ),
        ),
      )
      const shown = visible.filter((b) => inGroup(b, group))
      if (!books.length) body.replaceChildren(status('下載資料夾裡還沒有漫畫。在作品頁按「下載 CBZ」，或用「開啟漫畫檔」讀其他 CBZ'))
      else if (!shown.length) body.replaceChildren(status(kw ? `找不到「${filterInput.value.trim()}」` : lang ? `這裡沒有${LANGS[lang]}的漫畫` : '這個分組還是空的。點書櫃裡的漫畫就能設定分組'))
      else {
        grid.replaceChildren(...shown.map((b) => (b.isCol ? collectionCard(b, load) : selecting ? pickCard(b) : localCard(b, load))))
        body.replaceChildren(grid)
      }
      renderSelectBar()
    }
    /** 選取模式的卡片：點一下選 / 取消，右上角顯示第幾個選的 */
    const pickCard = (b) => {
      const el = localCard(b, load)
      const idx = selecting.indexOf(b.name)
      el.classList.add('pickable')
      if (idx >= 0) {
        el.classList.add('picked')
        el.querySelector('.thumb').append(h('span', { class: 'pick-no' }, String(idx + 1)))
      }
      // 擋掉原本「開管理視窗」的點擊，改成選取
      el.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation()
          const i = selecting.indexOf(b.name)
          if (i >= 0) selecting.splice(i, 1)
          else selecting.push(b.name)
          render()
        },
        true,
      )
      return el
    }
    const renderSelectBar = () => {
      selectBar.classList.toggle('hidden', !selecting)
      if (!selecting) return
      selectBar.replaceChildren(
        h(
          'span',
          {},
          (pickTarget ? `加入「${getCollections().find((c) => c.id === pickTarget)?.name || ''}」：` : '') +
            (selecting.length ? `已選 ${selecting.length} 本（依點的順序排）` : '點漫畫選取要放進合集的書（依點的順序排）'),
        ),
        h(
          'button',
          {
            class: 'btn primary',
            disabled: selecting.length ? false : 'disabled',
            onclick: () => {
              const picked = selecting.map((n) => books.find((b) => b.name === n)).filter(Boolean)
              const target = pickTarget
              selecting = null
              pickTarget = ''
              render()
              collectionDialog(picked, books, load, target)
            },
          },
          '下一步：命名、選封面',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              selecting = null
              render()
            },
          },
          '取消',
        ),
      )
    }
    const load = async () => {
      const list = await window.hub.lib.list()
      if (currentNav !== 'library') return
      books = [...openedBooks.filter((b) => !list.some((x) => x.id === b.id)), ...list]
      render()
    }
    filterInput.oninput = render
    // 下載完成時自動重新整理，新下載的書馬上出現
    let doneCount = dl.allJobs().filter((j) => j.status === 'done').length
    const off = dl.onChange((jobs) => {
      if (currentNav !== 'library') return off()
      const n = jobs.filter((j) => j.status === 'done').length
      if (n !== doneCount) {
        doneCount = n
        load()
      }
    })
    view.replaceChildren(
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, '書櫃（離線閱讀）'),
        filterInput,
        h('div', { class: 'head-btns' },
        h(
          'button',
          {
            class: 'more',
            title: '把幾本下載的漫畫串成一本看',
            onclick: () => {
              if (selecting) {
                selecting = null
                render()
              } else startShelfPick('')
            },
          },
          '建立合集',
        ),
        h('button', { class: 'more', onclick: load }, '重新整理'),
        h(
          'button',
          {
            class: 'more',
            onclick: async () => {
              const picked = await window.hub.lib.pick()
              for (const b of picked) {
                if (b.error) toast(b.error)
                else if (!openedBooks.some((x) => x.id === b.id)) openedBooks.unshift(b)
              }
              const ok = picked.filter((b) => !b.error)
              if (ok.length === 1) openLocal(ok[0])
              load()
            },
          },
          '開啟漫畫檔…',
        ),
        h('button', { class: 'more', onclick: () => window.hub.dl.openDir() }, '開啟資料夾'),
        h('button', { class: 'more', title: '匯出成備份檔，電腦重灌後可以還原', onclick: () => backupPopup(load) }, '備份 / 還原'),
        ),
      ),
      tabs,
      selectBar,
      body,
    )
    load()
  },

  downloads() {
    setNav('downloads')
    const dirEl = h('span', { class: 'dl-dir' }, '')
    window.hub.dl.dir().then((p) => (dirEl.textContent = p))
    const list = h('div', { class: 'dl-list' })
    const statusText = (j) =>
      ({
        queued: '等待中',
        running: j.total ? `下載中 ${j.done} / ${j.total}` : '準備中…',
        done: '完成',
        error: `失敗：${j.error}`,
        canceled: '已取消',
      })[j.status]
    // 資料夾裡有、但沒有下載紀錄的漫畫（舊版下載的、自己放進來的）
    const folderBox = h('div')
    const renderFolder = async () => {
      const [dir, books] = await Promise.all([window.hub.dl.dir(), window.hub.lib.list()])
      if (currentNav !== 'downloads') return
      const norm = (p) => String(p || '').toLowerCase().replace(/\//g, '\\')
      const tracked = new Set(dl.allJobs().filter((j) => j.file).map((j) => norm(j.file)))
      const inDir = books.filter((b) => norm(b.file).startsWith(norm(dir) + '\\') && !tracked.has(norm(b.file)))
      if (!inDir.length) return folderBox.replaceChildren()
      folderBox.replaceChildren(
        h('h3', { class: 'dl-sub' }, `下載資料夾裡的漫畫（${inDir.length}）`),
        h(
          'div',
          { class: 'dl-list' },
          inDir.map((b) => {
            const site = siteOfLocal(b)
            return h(
              'div',
              { class: `dl-item ${b.error ? 'error' : 'done'}` },
              h('img', { src: b.cover || '', alt: '', onclick: () => !b.error && openLocal(b) }),
              h(
                'div',
                { class: 'dl-body' },
                h('div', { class: 'dl-title' }, site ? badge(site, true) : h('span', { class: 'badge local inline' }, b.source || '本機'), ' ', b.title, b.chapter ? h('span', { class: 'dl-ch' }, `　${b.chapter}`) : null),
                h('div', { class: 'dl-st' }, b.error ? `無法讀取：${b.error}` : `${b.pageCount} 頁`),
              ),
              h(
                'div',
                { class: 'dl-btns' },
                b.error ? null : h('button', { class: 'btn primary', onclick: () => openLocal(b) }, '閱讀'),
                h('button', { class: 'btn', onclick: () => window.hub.dl.show(b.file) }, '在資料夾顯示'),
              ),
            )
          }),
        ),
      )
    }
    const render = () => {
      if (currentNav !== 'downloads') return off()
      const jobs = dl.allJobs()
      if (!jobs.length) return list.replaceChildren(status('還沒有下載紀錄。在作品頁按「下載 CBZ」就會出現在這裡'))
      list.replaceChildren(
        ...jobs.map((j) => {
          const pct = j.status === 'done' ? 100 : j.total ? Math.round((j.done / j.total) * 100) : 0
          const btns = []
          if (j.status === 'queued' || j.status === 'running') btns.push(h('button', { class: 'btn', onclick: () => dl.cancel(j.key) }, '取消'))
          if ((j.status === 'error' || j.status === 'canceled') && j.d) btns.push(h('button', { class: 'btn', onclick: () => dl.retry(j.key) }, '重試'))
          // 重開程式後的失敗紀錄沒有作品資料，開作品頁重新下載
          else if (j.status === 'error') btns.push(h('button', { class: 'btn', onclick: () => openDetail({ site: j.site, id: j.id, title: j.title, cover: j.cover }) }, '開作品頁'))
          if (j.status === 'done' && j.file) {
            btns.push(h('button', { class: 'btn primary', onclick: () => openLocalFile(j.file) }, '閱讀'))
            btns.push(h('button', { class: 'btn', onclick: () => window.hub.dl.show(j.file) }, '在資料夾顯示'))
          }
          return h(
            'div',
            { class: `dl-item ${j.status}` },
            h('img', { src: j.cover || '', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden'), onclick: () => openDetail({ site: j.site, id: j.id, title: j.title, cover: j.cover }) }),
            h(
              'div',
              { class: 'dl-body' },
              h('div', { class: 'dl-title' }, badge(j.site, true), ' ', j.title, j.chapterTitle ? h('span', { class: 'dl-ch' }, `　${j.chapterTitle}`) : null),
              h('div', { class: 'dl-bar' }, h('div', { style: `width:${pct}%` })),
              h('div', { class: 'dl-st' }, statusText(j)),
            ),
            h('div', { class: 'dl-btns' }, btns),
          )
        }),
      )
    }
    // 有下載完成就順便重整「資料夾裡的漫畫」
    let doneCount = dl.allJobs().filter((j) => j.status === 'done').length
    const off = dl.onChange((jobs) => {
      render()
      const n = jobs.filter((j) => j.status === 'done').length
      if (n !== doneCount) {
        doneCount = n
        renderFolder()
      }
    })
    view.replaceChildren(
      h('div', { class: 'section-head' }, h('h2', {}, '下載'), h('button', { class: 'more', onclick: () => dl.clearFinished() }, '清除下載紀錄')),
      h(
        'div',
        { class: 'dl-head' },
        '儲存位置：',
        dirEl,
        h('button', { class: 'btn', onclick: () => window.hub.dl.openDir() }, '開啟資料夾'),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              dirEl.textContent = await window.hub.dl.chooseDir()
              renderFolder()
            },
          },
          '變更位置',
        ),
      ),
      list,
      folderBox,
    )
    render()
    renderFolder()
  },

  account() {
    setNav('account')
    const cfg = getConfig()
    const cards = SITE_KEYS.map((k) => {
      const st = h('div', { class: 'st' }, h('span', { class: 'spinner' }), ' 確認中…')
      const btns = h('div', { class: 'row2' })
      const extra = h('div')
      const input = h('input', { value: cfg.sites[k].base, spellcheck: 'false' })
      const refresh = async () => {
        st.className = 'st'
        st.replaceChildren(h('span', { class: 'spinner' }), ' 確認中…')
        btns.replaceChildren()
        extra.replaceChildren()
        const s = await window.hub.authStatus(k)
        if (s.remembered) {
          extra.append(
            h(
              'div',
              { class: 'remember-row' },
              '已記住密碼：登入失效時會自動重新登入',
              h(
                'button',
                {
                  class: 'link-btn',
                  onclick: async () => {
                    if (!confirm('忘記密碼？之後登入失效時要自己重新登入。')) return
                    await window.hub.rememberLogin(k, false)
                    toast('已刪除記住的密碼')
                    refresh()
                  },
                },
                '忘記密碼',
              ),
            ),
          )
        }
        if (s.loggedIn) {
          st.className = 'st ok'
          st.textContent = `已登入${s.name ? `：${s.name}` : ''}${s.autoLogin ? '（已自動重新登入）' : ''}`
          btns.append(
            h('button', { class: 'btn', onclick: () => pages.favorites(k) }, '看收藏'),
            h('button', { class: 'btn', onclick: () => window.hub.openSite(k, cfg.sites[k].base + '/') }, '開啟網站'),
            h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  if (!confirm(`登出 ${SITES[k].label}？`)) return
                  await window.hub.logout(k)
                  refresh()
                },
              },
              '登出',
            ),
          )
          // jm 站收藏網址要用帳號名稱；自動讀不到時可以自己填
          if (k === 'jm') {
            const nameInput = h('input', { value: s.name || '', placeholder: '你的帳號名稱', spellcheck: 'false' })
            const save = async () => {
              const v = nameInput.value.trim()
              await window.hub.setAccountName('jm', v)
              SITES.jm.username = v
              toast(v ? '已儲存帳號名稱' : '已清除帳號名稱')
              refresh()
            }
            nameInput.onkeydown = (e) => {
              if (e.key === 'Enter') save()
            }
            extra.append(
              h('label', {}, s.name ? '帳號名稱（讀取收藏用，不對可以改）' : '讀不到帳號名稱，請填你的帳號名稱才能讀取收藏'),
              h('div', { class: 'domain' }, nameInput, h('button', { class: 'btn', onclick: save }, '儲存')),
            )
          }
        } else {
          st.textContent = s.error ? `未登入（${s.error}）` : s.expired ? (k === 'jm' ? '登入已失效（可能在瀏覽器或手機登入過），請重新登入' : '登入已過期，請重新登入') : '未登入'
          if (s.expired) st.className = 'st warn'
          btns.append(
            h('button', { class: 'btn primary', onclick: () => doLogin(k).then(refresh) }, '登入'),
            h('button', { class: 'btn', onclick: () => window.hub.openSite(k, cfg.sites[k].base + '/') }, '開啟網站'),
          )
        }
      }
      refresh()
      return h(
        'div',
        { class: 'account', 'data-site': k },
        h('h3', {}, badge(k, true), SITES[k].label),
        st,
        btns,
        extra,
        h('label', {}, '網址（網站換網域時改這裡）'),
        h(
          'div',
          { class: 'domain' },
          input,
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                const r = await window.hub.setBase(k, input.value)
                if (!r.ok) return toast(r.error)
                await loadConfig()
                input.value = getConfig().sites[k].base
                toast('已儲存')
                refresh()
              },
            },
            '儲存',
          ),
        ),
      )
    })
    view.replaceChildren(
      h('div', { class: 'section-head' }, h('h2', {}, '帳號')),
      h('div', { class: 'accounts' }, ...cards),
      h(
        'div',
        { class: 'hint' },
        '按「登入」會開啟該網站自己的登入頁，帳號密碼直接在網站上輸入。',
        h('br'),
        '登入成功後關掉那個視窗即可，登入狀態會保存在本機，下次開程式不用重登。各站的登入互相獨立。',
        h('br'),
        `${SITES.jm.label} 的登入過一陣子沒用會在網站那邊失效（電腦重開機後常常要重登）：登入時可以選擇讓程式記住密碼（Windows 加密存在這台電腦），失效時自動重新登入。`,
      ),
      h(
        'div',
        { class: 'version-row' },
        '目前版本：',
        h('b', {}, versionText()),
        h(
          'button',
          {
            class: 'btn',
            onclick: async (e) => {
              const btn = e.currentTarget
              btn.disabled = true
              btn.textContent = '檢查中…'
              const r = await checkUpdate(true)
              btn.disabled = false
              btn.textContent = '檢查更新'
              toast({ dev: '開發版不檢查更新', latest: '已經是最新版', shown: '有新版本，請看右下角', error: '檢查更新失敗，請稍後再試' }[r])
            },
          },
          '檢查更新',
        ),
        h('button', { class: 'btn', onclick: () => showChangelog() }, '更新紀錄'),
        h(
          'button',
          {
            class: 'btn',
            title: '開起來黑畫面、畫面怪怪的時候用：重開並清掉暫存資料，觀看紀錄、書櫃、登入都會保留',
            onclick: () => {
              if (confirm('修復程式：會重新開啟 ComicHub，並清掉暫存資料。\n觀看紀錄、閱讀進度、書櫃、登入都會保留。要繼續嗎？')) window.hub.repair()
            },
          },
          '修復程式',
        ),
      ),
    )
  },
}

/**
 * 判斷搜尋字是不是編號：
 *   站別代號、站名、各站編號前綴＋編號（例如 JM123、#123）→ 只查那一站
 *   作品網址 → 依網址判斷是哪一站
 *   純數字 → 每個勾選的站都用這個編號查一次
 */
function parseIdQuery(q) {
  const s = q.trim()
  const t = s.replace(/\s+/g, '')
  const one = (site, id) => ({ sites: [site], id: String(Number(id)) })
  const cfg = getConfig().sites
  const hostName = (k) => new URL(cfg[k].base).hostname.split('.').slice(-2)[0]
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let m
  // eh 站作品要 gid + token，只能用網址查
  if ((m = s.match(/\/g\/(\d+)\/([0-9a-f]{10})/)) && s.includes(hostName('eh'))) return { sites: ['eh'], id: `${m[1]}_${m[2]}` }
  if ((m = s.match(/\/g\/(\d+)/)) && s.includes(hostName('nh'))) return one('nh', m[1])
  if ((m = s.match(/\/(?:album|photo)\/(\d+)/))) return one('jm', m[1])
  if ((m = s.match(/aid-(\d+)/))) return one('wn', m[1])
  const numbered = SITE_KEYS.filter((k) => k !== 'eh')
  for (const k of numbered) {
    const c = cfg[k]
    const names = [k, c.prefix, c.label, c.label.slice(0, 2), hostName(k)].filter(Boolean).map(reEsc)
    if ((m = t.match(new RegExp(`^(?:${names.join('|')})(\\d+)$`, 'i')))) return one(k, m[1])
  }
  if ((m = t.match(/^\d{1,8}$/))) return { sites: numbered, id: String(Number(m[0])), plain: true }
  return null
}

/** 登入失效的說明；jm 站同一個帳號只能在一個地方登入（實測：在瀏覽器登入後，這裡十幾秒內就被登出） */
function expiredText(site) {
  if (site === 'jm')
    return `${SITES[site].label} 的登入已失效。這個站同一個帳號只能在一個地方保持登入，在瀏覽器或手機登入過就會把這裡登出，請重新登入就能看到收藏。（想在程式裡上網站，可以用「帳號」頁的「開啟網站」，它跟這裡共用登入）`
  return `${SITES[site].label} 的登入已過期，請重新登入就能看到收藏`
}

async function doLogin(site) {
  toast(`在新視窗登入 ${SITES[site].label}，完成後關閉視窗`)
  const s = await window.hub.login(site)
  if (site === 'jm') SITES.jm.username = s.name || ''
  toast(s.loggedIn ? `${SITES[site].label} 已登入${s.name ? `：${s.name}` : ''}` : `${SITES[site].label} 尚未登入`)
  // jm 站的登入一陣子沒用就在網站那邊失效（電腦關機、重開機後一定要重登），記住密碼才能自動重新登入
  if (s.canRemember) {
    const yes = confirm(
      `要讓 ComicHub 記住 ${SITES[site].label} 的密碼嗎？\n\n` +
        '這個站的登入過一陣子沒用就會在網站那邊失效，電腦重開機後通常要重新登入。\n' +
        '記住密碼的話，登入失效時程式會自動幫你重新登入。\n\n' +
        '密碼會用 Windows 加密存在這台電腦，只有你的 Windows 帳號解得開；隨時可以在「帳號」頁按「忘記密碼」刪掉。',
    )
    const r = await window.hub.rememberLogin(site, yes)
    s.remembered = r.remembered
    if (yes) toast('已記住密碼，登入失效時會自動重新登入')
  }
  return s
}

// ---------- 詳情 ----------

const detailEl = $('#detail')
let detailToken = 0

async function openDetail(item) {
  const token = ++detailToken
  const box = h('div', { class: 'detail-box' })
  const close = h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×')
  box.append(
    close,
    h(
      'div',
      { class: 'detail-main' },
      h('div', { class: 'cover' }, h('img', { src: item.cover, alt: '' })),
      h('div', { class: 'meta' }, badge(item.site, true), h('h1', {}, item.title), loading()),
    ),
  )
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
  detailEl.scrollTop = 0
  let d
  try {
    d = await SITES[item.site].detail(item.id)
  } catch (e) {
    if (token !== detailToken) return
    box.querySelector('.meta').lastChild.replaceWith(
      status(e.message, true),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => openDetail(item) }, '重試')),
    )
    return
  }
  if (token !== detailToken) return
  if (!d.cover) d.cover = item.cover
  addHistory({ ...item, title: d.title, cover: d.cover, lang: d.lang })
  renderDetail(box, close, d)
}

/** 標籤拿到其他站搜尋用的字：去掉 EH 那種「f:」「m:」前綴 */
const tagWord = (t) => String(t.name || '').replace(/^[a-z]:/, '').trim()

function renderDetail(box, close, d) {
  const groups = {}
  for (const t of d.tags) (groups[t.label] ||= []).push(t)
  const tagEls = Object.entries(groups).map(([k, list]) =>
    h(
      'div',
      { class: 'tag-group' },
      h('span', { class: 'k' }, k),
      h(
        'div',
        { class: 'v' },
        list.map((t) =>
          h(
            'button',
            {
              class: 'tag',
              title: `在所有勾選的站搜尋「${tagWord(t)}」（${SITES[d.site].label} 用標籤精確搜尋）`,
              onclick: () => {
                closeDetail()
                const word = tagWord(t)
                $('#searchInput').value = word
                // 原本的站用它自己的標籤語法；其他站沒有同樣的標籤，用標籤名當關鍵字搜
                const sites = [...new Set([d.site, ...store.get('searchSites', SITE_KEYS)])]
                pages.search(word, sites, { keyword: true, siteQuery: { [d.site]: t.query } })
              },
            },
            t.name,
          ),
        ),
      ),
    ),
  )
  const readKey = `read_${d.site}_${d.id}`
  const readSet = new Set(store.get(readKey, []))
  const actions = h('div', { class: 'actions' })
  const startId = d.chapters.length ? d.chapters[0].id : null
  // 有上次的進度就先給「繼續閱讀」
  const prog = getProgress(progressKey(d))
  const progChapterOk = prog && (!prog.chapterId || d.chapters.some((c) => c.id === prog.chapterId))
  if (progChapterOk) {
    actions.append(
      h('button', { class: 'btn primary', onclick: () => openReader(d, prog.chapterId || startId, prog.page) }, `繼續閱讀（${progressText(prog)}）`),
      h('button', { class: 'btn', onclick: () => openReader(d, startId) }, d.chapters.length ? '從第一話開始' : '從頭開始'),
    )
  } else actions.append(h('button', { class: 'btn primary', onclick: () => openReader(d, startId) }, d.chapters.length ? '從第一話開始' : '開始閱讀'))
  if (d.site === 'nh') {
    const fav = h('button', { class: 'btn', disabled: true }, '收藏')
    actions.append(fav)
    SITES.nh
      .isFavorite(d.id)
      .then((on) => setFavBtn(fav, on, d.id))
      .catch(() => {
        fav.disabled = false
        fav.textContent = '收藏（需登入）'
        fav.onclick = () => doLogin('nh')
      })
  } else {
    actions.append(h('button', { class: 'btn', onclick: () => window.hub.openSite(d.site, d.url), title: '用已登入的網站視窗開啟，可在網站上收藏或留言' }, '到網站收藏 / 開啟'))
  }
  actions.append(h('button', { class: 'btn', onclick: () => window.hub.external(d.url) }, '用瀏覽器開啟'))
  if (d.chapters.length > 1) actions.append(h('button', { class: 'btn', onclick: () => download(d, d.chapters) }, `下載全部 ${d.chapters.length} 話 (CBZ)`))
  else actions.append(h('button', { class: 'btn', onclick: () => download(d, [d.chapters[0] || null]) }, '下載 CBZ'))

  // 用此漫畫搜尋：到所有站找同一本（其他語言版本、其他站的上傳）
  const authors = d.tags.filter((t) => t.label === '作者').map((t) => t.name)
  const panel = searchPanel([
    { label: '書名', q: cleanTitle(d.title) },
    d.subtitle ? { label: '原文書名', q: cleanTitle(d.subtitle) } : {},
    ...(authors.length ? authors : parseAuthors(d.title)).map((a) => ({ label: '作者', q: a })),
    { label: '完整書名', q: d.title },
  ])
  panel.classList.add('hidden')
  actions.append(
    h(
      'button',
      {
        class: 'btn',
        title: '用書名或作者到所有站搜尋',
        onclick: () => {
          panel.classList.toggle('hidden')
          if (!panel.classList.contains('hidden')) panel.querySelector('input').focus()
        },
      },
      '用此漫畫搜尋',
    ),
  )

  const meta = h(
    'div',
    { class: 'meta' },
    badge(d.site, true),
    h('h1', {}, d.title),
    d.subtitle ? h('div', { class: 'subtitle' }, d.subtitle) : null,
    h('div', { class: 'info' }, d.lang ? h('span', {}, '語言', h('b', {}, LANGS[d.lang])) : null, d.info.map(([k, v]) => h('span', {}, k, h('b', {}, v)))),
    tagEls,
    actions,
    panel,
  )
  const parts = [close, h('div', { class: 'detail-main' }, h('div', { class: 'cover' }, h('img', { src: d.cover, alt: '' })), meta)]
  if (d.chapters.length > 1) {
    parts.push(
      h('h3', {}, `章節（${d.chapters.length}）`),
      h(
        'div',
        { class: 'chapters' },
        d.chapters.map((c, i) =>
          h(
            'div',
            { class: 'chapter' },
            h('button', { class: readSet.has(c.id) ? 'read' : '', title: c.title, onclick: () => openReader(d, c.id) }, c.title || `第 ${i + 1} 話`),
            h('button', { class: 'dl', title: '下載這一話 (CBZ)', onclick: () => download(d, [c]) }, '⬇'),
          ),
        ),
      ),
    )
  }
  if (d.related?.length) parts.push(h('h3', {}, '相關作品'), h('div', { class: 'grid' }, d.related.map(card)))
  box.replaceChildren(...parts)
}

/** 加進下載佇列；已經下載過的先問要不要重抓 */
async function download(d, chapters) {
  const list = []
  for (const c of chapters) {
    if (dl.isQueued(d, c?.id)) continue
    if (await window.hub.dl.exists(dl.fileName(d, c))) {
      if (!confirm(`「${dl.fileName(d, c)}」已經下載過了，要重新下載嗎？`)) continue
    }
    list.push(c)
  }
  for (const c of list) dl.enqueue(d, c)
  if (list.length) toast(list.length > 1 ? `已加入下載：${list.length} 話` : '已加入下載')
  else if (chapters.every((c) => dl.isQueued(d, c?.id))) toast('已經在下載佇列裡了')
}

// ---------- 本機書櫃 ----------

/** 這次用「開啟漫畫檔」開過、但不在下載資料夾裡的檔案 */
const openedBooks = []

/** 檔名開頭的 [站名] 對回站別代號 */
const siteOfLocal = (b) => SITE_KEYS.find((k) => SITES[k].label === b.source) || ''

/** 本機檔的語言：書名裡的 [中国翻訳]、[English] 之類，或 ComicInfo 的標籤 */
function localLang(b) {
  const t = `${b.title} ${b.name}`
  if (/chinese|中文|漢化|汉化|中国翻訳|中國翻譯|翻譯|翻译/i.test(t)) return { lang: 'zh' }
  if (/english|英訳/i.test(t)) return { lang: 'en' }
  if (/japanese|日文|日語/i.test(t)) return { lang: 'ja' }
  return { lang: '' }
}

// ---------- 書櫃分組（以檔名記，換下載資料夾也不會亂掉） ----------

const NO_GROUP = '__none'
function shelfGroups() {
  const of = store.get('libGroups', {})
  const list = [...new Set([...store.get('libGroupList', []), ...Object.values(of)])].filter(Boolean)
  return { of, list }
}
function setShelfGroup(name, group) {
  const of = store.get('libGroups', {})
  if (group) of[name] = group
  else delete of[name]
  store.set('libGroups', of)
  if (group) store.set('libGroupList', [...new Set([...store.get('libGroupList', []), group])])
}
function deleteShelfGroup(group) {
  const of = store.get('libGroups', {})
  for (const k of Object.keys(of)) if (of[k] === group) delete of[k]
  store.set('libGroups', of)
  store.set('libGroupList', store.get('libGroupList', []).filter((g) => g !== group))
}

/** 書名開頭的 [社團 (作者)] 或 [作者]，拆出作者名（ComicInfo 沒寫作者時用） */
function parseAuthors(title) {
  const m = String(title || '').match(/^\s*(?:\([^)]*\)\s*)?\[([^\]]+)\]/)
  if (!m || /翻訳|翻譯|汉化|漢化|chinese|english|中文|DL版|digital/i.test(m[1])) return []
  const inner = m[1].match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  const names = inner ? [...inner[2].split(/[,、，]/), inner[1]] : m[1].split(/[,、，]/)
  return [...new Set(names.map((s) => s.trim()).filter((s) => s && s.length < 40))]
}

/** 拿掉 [社團]、(活動)、{漢化組}、【…】 這些標記，剩下書名本體，拿來到各站搜同一本 */
function cleanTitle(t) {
  const s = String(t || '')
    .split(/\s[|｜]\s/)[0]
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】|（[^）]*）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length >= 2 ? s : String(t || '').trim()
}

/** 「用此漫畫搜尋」面板：可改搜尋字，或點候選（書名、日文名、作者），一次搜所有勾選的站 */
function searchPanel(candidates, onGo) {
  const list = [...new Map(candidates.filter((c) => c.q).map((c) => [c.q, c])).values()]
  const input = h('input', { type: 'search', value: list[0]?.q || '', placeholder: '要搜尋的文字' })
  const go = (q) => {
    q = (q ?? input.value).trim()
    if (!q) return
    onGo?.()
    closeDetail()
    $('#searchInput').value = q
    pages.search(q, store.get('searchSites', SITE_KEYS), { keyword: true })
  }
  // 不能寫成 `(e) => e.key === 'Enter' && go()`：on 事件回傳 false 等於取消按鍵，其他字都打不進去
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go()
  }
  return h(
    'div',
    { class: 'search-panel' },
    h('div', { class: 'sp-row' }, input, h('button', { class: 'btn primary', onclick: () => go() }, '搜尋所有站')),
    h(
      'div',
      { class: 'sp-chips' },
      list.map((c) =>
        h(
          'button',
          {
            class: 'tag',
            title: `搜尋「${c.q}」`,
            onclick: () => {
              input.value = c.q
              go(c.q)
            },
          },
          h('span', { class: 'sp-k' }, c.label),
          c.q,
        ),
      ),
    ),
  )
}

function localCard(b, reload) {
  const site = siteOfLocal(b)
  const group = shelfGroups().of[b.name]
  const col = getCollections().find((c) => c.files.includes(b.name))
  return h(
    'div',
    { class: `card${b.error ? ' broken' : ''}`, title: b.name, onclick: () => bookPopup(b, reload) },
    h(
      'div',
      { class: 'thumb' },
      b.cover ? h('img', { src: b.cover, loading: 'lazy', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }) : h('div', { class: 'broken-icon' }, '!'),
      site ? badge(site) : h('span', { class: 'badge local' }, b.source || '本機'),
      langBadge(localLang(b).lang),
      col ? h('span', { class: 'group-tag' }, `合集：${col.name}`) : group ? h('span', { class: 'group-tag' }, group) : null,
    ),
    h('div', { class: 'title' }, b.title),
    h(
      'div',
      { class: 'sub' },
      b.error
        ? `無法讀取：${b.error}`
        : [b.chapter, getProgress(localKey(b))?.page > 0 ? `看到 ${getProgress(localKey(b)).page + 1} / ${b.pageCount} 頁` : `${b.pageCount} 頁`].filter(Boolean).join('・'),
    ),
  )
}

/** 書櫃的管理小視窗：閱讀、分組、作者相關作品、用書名搜尋、刪除 */
function bookPopup(b, reload) {
  const site = siteOfLocal(b)
  const authors = b.authors?.length ? b.authors : parseAuthors(b.name.replace(/^\[[^\]]+\]\s*/, ''))
  const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
  // Notes 是「站名 編號」，有的話可以回到網站上的作品頁
  const nm = String(b.notes || '').match(/^(.*)\s(\S+)$/)
  const srcSite = nm && SITE_KEYS.find((k) => SITES[k].label === nm[1])
  const close = h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×')

  const groups = shelfGroups()
  const cur = groups.of[b.name] || ''
  const sel = h(
    'select',
    {
      onchange: () => {
        setShelfGroup(b.name, sel.value)
        toast(sel.value ? `已移到「${sel.value}」` : '已移出分組')
        reload()
      },
    },
    h('option', { value: '' }, '未分組'),
    groups.list.map((g) => h('option', { value: g, selected: g === cur ? 'selected' : false }, g)),
  )
  const newName = h('input', { type: 'text', placeholder: '新分組名稱', maxlength: '30' })
  const addGroup = () => {
    const g = newName.value.trim()
    if (!g) return newName.focus()
    setShelfGroup(b.name, g)
    toast(`已移到「${g}」`)
    reload()
    bookPopup({ ...b }, reload)
  }
  newName.onkeydown = (e) => {
    if (e.key === 'Enter') addGroup()
  }

  const actions = h('div', { class: 'actions' })
  const lp = getProgress(localKey(b))
  if (!b.error && lp && lp.page > 0 && lp.page < b.pageCount) {
    actions.append(
      h('button', { class: 'btn primary', onclick: () => openLocal(b, lp.page) }, `繼續閱讀（第 ${lp.page + 1} / ${b.pageCount} 頁）`),
      h('button', { class: 'btn', onclick: () => openLocal(b) }, '從頭開始'),
    )
  } else if (!b.error) actions.append(h('button', { class: 'btn primary', onclick: () => openLocal(b) }, '開始閱讀'))
  if (srcSite) actions.append(h('button', { class: 'btn', onclick: () => openDetail({ site: srcSite, id: nm[2], title: b.title, cover: b.cover }) }, '網站作品頁'))
  if (!b.error) actions.append(h('button', { class: 'btn', title: '放進新的或現有的合集', onclick: () => collectionDialog([b], shelfBooks, reload) }, '加入合集'))
  actions.append(
    h('button', { class: 'btn', onclick: () => window.hub.dl.show(b.file) }, '在資料夾顯示'),
    h(
      'button',
      {
        class: 'btn danger',
        onclick: async () => {
          if (!confirm(`刪除「${b.name}」？檔案會移到資源回收筒。`)) return
          const r = await window.hub.lib.trash(b.file)
          if (!r.ok) return toast(r.error)
          const i = openedBooks.findIndex((x) => x.id === b.id)
          if (i >= 0) openedBooks.splice(i, 1)
          setShelfGroup(b.name, '')
          closeDetail()
          toast('已移到資源回收筒')
          reload()
        },
      },
      '刪除',
    ),
  )
  // 用「開啟漫畫檔」加進來、不在下載資料夾的檔案：可以只從書櫃拿掉，不刪檔
  window.hub.lib.external(b.file).then((ext) => {
    if (!ext) return
    actions.append(
      h(
        'button',
        {
          class: 'btn',
          title: '檔案留在原處，只是不再顯示在書櫃',
          onclick: async () => {
            await window.hub.lib.forget(b.file)
            const i = openedBooks.findIndex((x) => x.id === b.id)
            if (i >= 0) openedBooks.splice(i, 1)
            closeDetail()
            toast('已從書櫃移除（檔案沒有刪除）')
            reload()
          },
        },
        '從書櫃移除',
      ),
    )
  })

  const info = [
    b.pageCount ? ['頁數', `${b.pageCount}`] : null,
    b.size ? ['大小', fmtSize(b.size)] : null,
    b.mtime ? ['下載時間', new Date(b.mtime).toLocaleString()] : null,
  ].filter(Boolean)

  const box = h(
    'div',
    { class: 'detail-box book-pop' },
    close,
    h(
      'div',
      { class: 'detail-main' },
      h('div', { class: 'cover' }, b.cover ? h('img', { src: b.cover, alt: '' }) : h('div', { class: 'broken-icon' }, '!')),
      h(
        'div',
        { class: 'meta' },
        site ? badge(site, true) : h('span', { class: 'badge local inline' }, b.source || '本機'),
        h('h1', {}, b.title),
        b.chapter ? h('div', { class: 'subtitle' }, b.chapter) : null,
        b.error ? status(`無法讀取這個檔案：${b.error}`, true) : null,
        h('div', { class: 'info' }, info.map(([k, v]) => h('span', {}, k, h('b', {}, v)))),
        authors.length
          ? h(
              'div',
              { class: 'tag-group' },
              h('span', { class: 'k' }, '作者'),
              h(
                'div',
                { class: 'v' },
                authors.map((a) =>
                  h(
                    'button',
                    {
                      class: 'tag',
                      title: `在所有站搜尋「${a}」的作品`,
                      onclick: () => {
                        closeDetail()
                        $('#searchInput').value = a
                        pages.search(a, store.get('searchSites', SITE_KEYS), { keyword: true })
                      },
                    },
                    a,
                  ),
                ),
                h('span', { class: 'hint-inline' }, '點作者名搜尋相關作品'),
              ),
            )
          : null,
        h('div', { class: 'tag-group' }, h('span', { class: 'k' }, '分組'), h('div', { class: 'v group-row' }, sel, newName, h('button', { class: 'btn', onclick: addGroup }, '新增分組'))),
        actions,
      ),
    ),
    h('h3', {}, '用此漫畫搜尋'),
    searchPanel([
      { label: '書名', q: cleanTitle(b.title) },
      { label: '完整書名', q: b.title },
      ...authors.map((a) => ({ label: '作者', q: a })),
    ]),
  )
  if (cur) {
    box.append(
      h(
        'div',
        { class: 'pop-foot' },
        h(
          'button',
          {
            class: 'link-btn',
            onclick: () => {
              if (!confirm(`刪除分組「${cur}」？分組裡的漫畫不會被刪除，只會變成未分組。`)) return
              deleteShelfGroup(cur)
              closeDetail()
              reload()
            },
          },
          `刪除分組「${cur}」`,
        ),
      ),
    )
  }
  detailToken++
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
  detailEl.scrollTop = 0
}

const localKey = (b) => `local_${b.name}`

// ---------- 書櫃合集：把幾本下載的漫畫串成一本看，可以跳到每本的第一頁 ----------
// 存在 state 的 collections：[{ id, name, files: [書的檔名…], cover: 當封面那本的檔名 }]
// 不另外產生檔案，原本的 CBZ 都不動；解散合集書就回到書櫃

/** 書櫃目前畫面上的東西（合集 + 書），合集視窗更新後拿來重畫 */
let shelfItems = []
/** 書櫃裡所有的書（含已在合集裡的） */
let shelfBooks = []
/** 書櫃頁提供的：進入選書模式，選完加進指定合集（targetId 空 = 新合集） */
let startShelfPick = null

const getCollections = () => store.get('collections', [])
const saveCollections = (list) => store.set('collections', list)
const colKey = (c) => `col_${c.id}`

/** 合集 + 它的書（依合集裡的順序；檔案不見的會略過） */
function resolveCollection(c, byName) {
  const members = c.files.map((f) => byName.get(f)).filter((b) => b && !b.error && b.pageCount)
  const coverBook = byName.get(c.cover) || members[0]
  return {
    isCol: true,
    col: c,
    id: c.id,
    name: `col:${c.id}`, // 分組用
    title: c.name,
    members,
    missing: c.files.length - members.length,
    cover: coverBook?.cover || '',
    pageCount: members.reduce((n, b) => n + b.pageCount, 0),
    authors: [...new Set(members.flatMap((b) => b.authors || []))],
  }
}

function openCollection(item, startPage = 0) {
  if (!item.members.length) return toast('這個合集裡沒有可以看的漫畫')
  closeDetail()
  const localPages = []
  const toc = []
  for (const b of item.members) {
    toc.push({ title: b.chapter ? `${b.title} ${b.chapter}` : b.title, start: localPages.length, count: b.pageCount })
    for (const url of b.pages) localPages.push({ url, segs: 0 })
  }
  openReader({ site: 'local', id: item.id, pkey: colKey(item.col), title: item.title, subtitle: '', chapters: [], local: true, localPages, toc }, null, startPage)
}

function collectionCard(item, reload) {
  const p = getProgress(colKey(item.col))
  const group = shelfGroups().of[item.name]
  return h(
    'div',
    { class: 'card collection', title: item.title, onclick: () => collectionPopup(item, reload) },
    h(
      'div',
      { class: 'thumb' },
      item.cover ? h('img', { src: item.cover, loading: 'lazy', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }) : null,
      h('span', { class: 'badge col' }, `合集・${item.members.length} 本`),
      group ? h('span', { class: 'group-tag' }, group) : null,
    ),
    h('div', { class: 'title' }, item.title),
    h('div', { class: 'sub' }, [p?.page > 0 ? `看到 ${p.page + 1} / ${item.pageCount} 頁` : `共 ${item.pageCount} 頁`, item.missing ? `${item.missing} 本檔案不見了` : ''].filter(Boolean).join('・')),
  )
}

/**
 * 建立合集 / 加進現有合集的小視窗。
 * picked：依點選順序的書；封面可以從這些書（加入現有合集時也包含原本的書）裡選。
 */
function collectionDialog(picked, allBooks, reload, targetId = '') {
  const cols = getCollections()
  const byName = new Map(allBooks.map((b) => [b.name, b]))
  const target = h('select', {}, h('option', { value: '' }, '新的合集'), cols.map((c) => h('option', { value: c.id }, `加到「${c.name}」`)))
  const nameInput = h('input', { type: 'text', value: cleanTitle(picked[0].title).slice(0, 60), maxlength: '80' })
  const nameRow = h('div', { class: 'tag-group' }, h('span', { class: 'k' }, '名稱'), h('div', { class: 'v' }, nameInput))
  const coverBox = h('div', { class: 'cover-pick' })
  let cover = picked[0].name
  const renderCovers = () => {
    const col = cols.find((c) => c.id === target.value)
    const books = [...(col ? col.files.map((f) => byName.get(f)).filter(Boolean) : []), ...picked.filter((b) => !col?.files.includes(b.name))]
    if (col && !books.some((b) => b.name === cover)) cover = col.cover
    coverBox.replaceChildren(
      ...books.map((b) =>
        h(
          'button',
          {
            class: `cover-opt${b.name === cover ? ' on' : ''}`,
            title: b.title,
            onclick: () => {
              cover = b.name
              renderCovers()
            },
          },
          h('img', { src: b.cover || '', alt: '' }),
        ),
      ),
    )
    nameRow.classList.toggle('hidden', !!col)
  }
  target.onchange = () => {
    const col = cols.find((c) => c.id === target.value)
    if (col) cover = col.cover
    renderCovers()
  }
  const save = () => {
    const list = getCollections()
    const col = list.find((c) => c.id === target.value)
    if (col) {
      for (const b of picked) if (!col.files.includes(b.name)) col.files.push(b.name)
      col.cover = cover
      toast(`已加到「${col.name}」`)
    } else {
      const name = nameInput.value.trim() || cleanTitle(picked[0].title)
      list.unshift({ id: Date.now().toString(36), name, files: picked.map((b) => b.name), cover, created: Date.now() })
      toast(`已建立合集「${name}」`)
    }
    // 一本書只放在一個合集裡：從其他合集拿掉
    const ids = new Set(picked.map((b) => b.name))
    const keepId = col?.id || list[0].id
    for (const c of list) if (c.id !== keepId) c.files = c.files.filter((f) => !ids.has(f))
    saveCollections(list.filter((c) => c.files.length))
    closeDetail()
    reload()
  }
  const box = h(
    'div',
    { class: 'detail-box col-dialog' },
    h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×'),
    h('h2', {}, `把 ${picked.length} 本做成合集`),
    h('div', { class: 'tag-group' }, h('span', { class: 'k' }, '放到'), h('div', { class: 'v' }, target)),
    nameRow,
    h('div', { class: 'hint-inline' }, '順序就是你點選的順序，之後可以在合集裡調整。選一本當封面：'),
    coverBox,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, '確定'), h('button', { class: 'btn', onclick: closeDetail }, '取消')),
  )
  if (targetId && cols.some((c) => c.id === targetId)) {
    target.value = targetId
    cover = cols.find((c) => c.id === targetId).cover
  }
  renderCovers()
  detailToken++
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
  if (!targetId) {
    nameInput.focus()
    nameInput.select()
  }
}

/** 合集的管理視窗：閱讀、跳到某一本、調整順序、換封面、改名、分組、解散 */
function collectionPopup(item, reload) {
  const update = async (fn) => {
    const list = getCollections()
    const c = list.find((x) => x.id === item.id)
    if (!c) return
    fn(c)
    saveCollections(list.filter((x) => x.files.length))
    await reload()
    // 用更新後的內容重畫這個視窗（合集被移空就關掉）
    const fresh = shelfItems.find((x) => x.isCol && x.id === item.id)
    if (fresh) collectionPopup(fresh, reload)
    else closeDetail()
  }
  const p = getProgress(colKey(item.col))
  const actions = h('div', { class: 'actions' })
  if (p && p.page > 0 && p.page < item.pageCount) {
    const cur = item.members.findIndex((_, i) => item.members.slice(0, i + 1).reduce((n, b) => n + b.pageCount, 0) > p.page)
    actions.append(
      h('button', { class: 'btn primary', onclick: () => openCollection(item, p.page) }, `繼續閱讀（第 ${cur + 1} 本，總第 ${p.page + 1} / ${item.pageCount} 頁）`),
      h('button', { class: 'btn', onclick: () => openCollection(item, 0) }, '從頭開始'),
    )
  } else actions.append(h('button', { class: 'btn primary', onclick: () => openCollection(item, 0) }, '開始閱讀'))
  actions.append(
    h(
      'button',
      {
        class: 'btn',
        title: '到書櫃選要加進這個合集的漫畫',
        onclick: () => {
          closeDetail()
          if (currentNav !== 'library') pages.library()
          setTimeout(() => startShelfPick?.(item.id), 0)
        },
      },
      '加入漫畫',
    ),
    h(
      'button',
      {
        class: 'btn danger',
        title: '漫畫檔案不會刪除，只是不再組成合集',
        onclick: () => {
          if (!confirm(`解散合集「${item.title}」？裡面的漫畫會回到書櫃，檔案不會刪除。`)) return
          saveCollections(getCollections().filter((c) => c.id !== item.id))
          setShelfGroup(item.name, '')
          closeDetail()
          toast('已解散合集')
          reload()
        },
      },
      '解散合集',
    ),
  )

  const nameInput = h('input', { type: 'text', value: item.title, maxlength: '80' })
  const rename = () => {
    const v = nameInput.value.trim()
    if (!v) return
    update((c) => (c.name = v))
    toast('已改名')
  }
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') rename()
  }

  const groups = shelfGroups()
  const sel = h(
    'select',
    {
      onchange: () => {
        setShelfGroup(item.name, sel.value)
        reload()
      },
    },
    h('option', { value: '' }, '未分組'),
    groups.list.map((g) => h('option', { value: g, selected: g === groups.of[item.name] ? 'selected' : false }, g)),
  )

  // 每一本：跳到這本開始看、上移、下移、設為封面、從合集拿掉
  let start = 0
  const rows = item.members.map((b, i) => {
    const from = start
    start += b.pageCount
    const move = (d) =>
      update((c) => {
        const k = c.files.indexOf(b.name)
        const j = k + d
        if (k < 0 || j < 0 || j >= c.files.length) return
        ;[c.files[k], c.files[j]] = [c.files[j], c.files[k]]
      })
    return h(
      'div',
      {
        class: `col-row${item.col.cover === b.name ? ' is-cover' : ''}`,
        draggable: 'true',
        title: '拖曳可以調整順序',
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', b.name)
          e.currentTarget.classList.add('dragging')
        },
        ondragend: (e) => e.currentTarget.classList.remove('dragging'),
        ondragover: (e) => {
          e.preventDefault()
          e.currentTarget.classList.add('drop-here')
        },
        ondragleave: (e) => e.currentTarget.classList.remove('drop-here'),
        ondrop: (e) => {
          e.preventDefault()
          const from = e.dataTransfer.getData('text/plain')
          if (!from || from === b.name) return
          update((c) => {
            const list = c.files.filter((f) => f !== from)
            list.splice(list.indexOf(b.name) + (c.files.indexOf(from) < c.files.indexOf(b.name) ? 1 : 0), 0, from)
            c.files = list
          })
        },
      },
      h('span', { class: 'drag-handle' }, '⋮⋮'),
      h('img', { src: b.cover || '', alt: '', onclick: () => openCollection(item, from) }),
      h('div', { class: 'col-row-body' }, h('div', { class: 'col-row-title' }, `${i + 1}. ${b.title}${b.chapter ? ` ${b.chapter}` : ''}`), h('div', { class: 'dl-st' }, `${b.pageCount} 頁・從總第 ${from + 1} 頁開始${item.col.cover === b.name ? '・封面' : ''}`)),
      h(
        'div',
        { class: 'dl-btns' },
        h('button', { class: 'btn primary', onclick: () => openCollection(item, from) }, '從這本看'),
        h('button', { class: 'btn', title: '這本的管理視窗：用此漫畫搜尋、作者相關作品、刪除…', onclick: () => bookPopup(b, reload) }, '搜尋 / 管理'),
        h('button', { class: 'btn', disabled: i === 0 ? 'disabled' : false, title: '往前移', onclick: () => move(-1) }, '↑'),
        h('button', { class: 'btn', disabled: i === item.members.length - 1 ? 'disabled' : false, title: '往後移', onclick: () => move(1) }, '↓'),
        h('button', { class: 'btn', title: '用這本當合集封面', onclick: () => update((c) => (c.cover = b.name)) }, '設為封面'),
        h(
          'button',
          {
            class: 'btn',
            title: '從合集拿掉（回到書櫃，不刪檔案）',
            onclick: () =>
              update((c) => {
                c.files = c.files.filter((f) => f !== b.name)
                if (c.cover === b.name) c.cover = c.files[0]
              }),
          },
          '移出',
        ),
      ),
    )
  })

  const box = h(
    'div',
    { class: 'detail-box book-pop' },
    h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×'),
    h(
      'div',
      { class: 'detail-main' },
      h('div', { class: 'cover' }, item.cover ? h('img', { src: item.cover, alt: '' }) : null),
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'badge col inline' }, '合集'),
        h('h1', {}, item.title),
        h('div', { class: 'info' }, h('span', {}, '本數', h('b', {}, String(item.members.length))), h('span', {}, '總頁數', h('b', {}, String(item.pageCount))), item.missing ? h('span', {}, '檔案不見', h('b', {}, `${item.missing} 本`)) : null),
        h('div', { class: 'tag-group' }, h('span', { class: 'k' }, '名稱'), h('div', { class: 'v group-row' }, nameInput, h('button', { class: 'btn', onclick: rename }, '改名'))),
        h('div', { class: 'tag-group' }, h('span', { class: 'k' }, '分組'), h('div', { class: 'v group-row' }, sel)),
        actions,
      ),
    ),
    h('h3', {}, '合集內容（點封面或「從這本看」會從那本的第一頁開始）'),
    h('div', { class: 'dl-list' }, rows),
    h('h3', {}, '用此合集搜尋'),
    searchPanel([
      { label: '合集名稱', q: cleanTitle(item.title) },
      ...item.members.map((b) => ({ label: '書名', q: cleanTitle(b.title) })),
      ...item.authors.map((a) => ({ label: '作者', q: a })),
    ]),
  )
  detailToken++
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
}

/** 書櫃備份 / 還原視窗：匯出成 JSON、從 JSON（或程式自動備份）還原、加入放漫畫的資料夾 */
function backupPopup(reload) {
  const result = h('div', { class: 'backup-result' })
  const show = (...nodes) => result.replaceChildren(...nodes)
  const n = (c) => `觀看紀錄 ${c.history} 筆・閱讀進度 ${c.progress} 本・合集 ${c.collections} 個・已分組 ${c.grouped} 本`
  const doExport = async () => {
    const r = await window.hub.backup.export()
    if (r.canceled) return
    if (!r.ok) return show(status(`匯出失敗：${r.error}`, true))
    show(h('p', {}, '已匯出：', h('b', {}, r.file)), h('p', { class: 'hint-inline' }, n(r.counts)), h('button', { class: 'btn', onclick: () => window.hub.dl.show(r.file) }, '在資料夾顯示'))
  }
  const doImport = async () => {
    if (!confirm('從備份檔還原：會用備份檔的內容取代目前的觀看紀錄、閱讀進度、合集、分組和設定。\n目前的資料會先另存一份在程式資料夾的 backup，還原錯了可以再還原回來。\n\n要繼續嗎？')) return
    const r = await window.hub.backup.import()
    if (r.canceled) return
    if (!r.ok) return show(status(`還原失敗：${r.error}`, true))
    const lines = [
      `已還原${r.exportedAt ? `（備份時間 ${new Date(r.exportedAt).toLocaleString()}${r.host ? `，來自 ${r.host}` : ''}）` : ''}`,
      n(r.counts),
      r.missing.length ? `備份裡的漫畫資料夾在這台電腦找不到：\n${r.missing.join('\n')}\n請把漫畫檔（CBZ）複製到下載資料夾，或用「加入漫畫資料夾」選你放漫畫的地方。` : '',
      `下載資料夾：${r.downloadDir}`,
      `還原前的資料另存在：${r.safety}`,
    ].filter(Boolean)
    alert(lines.join('\n\n'))
    // 頁面裡的資料是開程式時讀的，重新載入才會換成還原後的內容
    location.reload()
  }
  const doAddDir = async () => {
    const r = await window.hub.backup.addDir()
    if (r.canceled) return
    if (!r.ok) return toast(r.error || '加入失敗')
    toast('已加入書櫃')
    reload?.()
    show(h('p', {}, '已把這個資料夾的漫畫加進書櫃：', h('b', {}, r.dir)))
  }
  const box = h(
    'div',
    { class: 'detail-box col-dialog' },
    h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×'),
    h('h2', {}, '書櫃備份 / 還原'),
    h(
      'p',
      { class: 'hint-inline' },
      '備份檔包含觀看紀錄、閱讀進度、合集、分組、設定和書櫃記得的資料夾，不含漫畫檔本身。電腦重灌前：匯出備份檔，並把下載資料夾裡的漫畫（CBZ）一起複製到隨身碟或雲端。',
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onclick: doExport }, '匯出備份檔…'),
      h('button', { class: 'btn', onclick: doImport }, '從備份檔還原…'),
      h('button', { class: 'btn', title: '漫畫放在下載資料夾以外的地方時，把那個資料夾加進書櫃', onclick: doAddDir }, '加入漫畫資料夾…'),
    ),
    h(
      'p',
      { class: 'hint-inline' },
      '重灌後還原：先開 ComicHub，按「從備份檔還原」選備份檔，再把漫畫複製到下載資料夾（或用「加入漫畫資料夾」）。合集、分組、進度是用檔名對應的，換資料夾也沒關係。也可以選程式自動備份的「ComicHub 紀錄備份.json」（在程式資料夾的 backup 裡）。',
    ),
    result,
  )
  detailToken++
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
}

function openLocal(b, startPage = 0) {
  if (!b.pageCount) return toast('這個檔案裡沒有圖片')
  closeDetail()
  openReader(
    { site: siteOfLocal(b) || 'local', id: b.id, pkey: localKey(b), title: b.title, subtitle: b.chapter, chapters: [], local: true, localPages: b.pages.map((url) => ({ url, segs: 0 })) },
    null,
    startPage,
  )
}

async function openLocalFile(file) {
  const r = await window.hub.lib.open(file)
  if (!r.ok) return toast(`打不開：${r.error}`)
  openLocal(r.book)
}

function setFavBtn(btn, on, id) {
  btn.disabled = false
  btn.textContent = on ? '★ 已收藏' : '☆ 收藏'
  btn.classList.toggle('fav-on', on)
  btn.onclick = async () => {
    btn.disabled = true
    try {
      await SITES.nh.setFavorite(id, !on)
      setFavBtn(btn, !on, id)
      toast(on ? '已取消收藏' : `已加入 ${SITES.nh.label} 收藏`)
    } catch (e) {
      btn.disabled = false
      toast(e.message)
    }
  }
}

function closeDetail() {
  detailToken++
  detailEl.classList.add('hidden')
  detailEl.replaceChildren()
}

// ---------- 閱讀器 ----------

const readerEl = $('#reader')
let readerToken = 0
let observer = null

/** 繼續閱讀用：開到某一頁時，上面的圖片載入會把畫面往下推，所以先「釘住」那一頁，使用者自己捲動就放開 */
let pinEl = null
const unpin = () => {
  pinEl = null
}
for (const ev of ['wheel', 'mousedown', 'touchstart']) readerEl.addEventListener(ev, unpin, { passive: true })
document.addEventListener('keydown', unpin)

async function openReader(d, chapterId, startPage = 0) {
  const token = ++readerToken
  pinEl = null
  const chIndex = d.chapters.findIndex((c) => c.id === chapterId)
  const chapter = chIndex >= 0 ? d.chapters[chIndex] : null
  const width = store.get('pageWidth', 900)
  readerEl.style.setProperty('--page-w', width + 'px')
  const title = h('div', { class: 't' }, SITES[d.site] ? badge(d.site, true) : null, ' ', d.title, chapter && d.chapters.length > 1 ? `　/　${chapter.title}` : '', d.subtitle ? `　/　${d.subtitle}` : '')
  const counter = h('span', {}, '')
  // 合集：上方多一個「跳到第幾本」的選單
  let els = []
  const tocSel = d.toc
    ? h(
        'select',
        {
          class: 'toc-sel',
          title: '跳到合集裡某一本的第一頁',
          onchange: () => {
            const el = els[d.toc[Number(tocSel.value)].start]
            if (!el) return
            stopWheel()
            // 前面的圖還沒載完會把畫面推走，先釘住這一頁
            pinEl = el
            readerEl.scrollTop = el.offsetTop
            setTimeout(() => {
              if (pinEl === el) pinEl = null
            }, 15000)
            tocSel.blur()
          },
        },
        d.toc.map((t, i) => h('option', { value: i }, `${i + 1}. ${t.title}`)),
      )
    : null
  const setW = (dw) => {
    const w = Math.max(400, Math.min(2000, store.get('pageWidth', 900) + dw))
    store.set('pageWidth', w)
    readerEl.style.setProperty('--page-w', w + 'px')
  }
  const bar = h(
    'div',
    { class: 'reader-bar' },
    h('button', { onclick: closeReader }, '← 返回'),
    title,
    tocSel,
    counter,
    d.local ? null : h('button', { onclick: () => download(d, [chapter || d.chapters[0] || null]), title: '下載成 CBZ' }, chapter && d.chapters.length > 1 ? '下載本話' : '下載'),
    h('button', { onclick: () => setW(-100), title: '縮小 (-)' }, '－'),
    h('button', { onclick: () => setW(100), title: '放大 (+)' }, '＋'),
  )
  const list = h('div', { class: 'pages' }, loading())
  readerEl.replaceChildren(bar, list)
  readerEl.classList.remove('hidden')
  readerEl.scrollTop = 0
  readerEl.focus()

  if (chapter) {
    const key = `read_${d.site}_${d.id}`
    const set = new Set(store.get(key, []))
    set.add(chapter.id)
    store.set(key, [...set])
    addHistory({ site: d.site, id: d.id, title: d.title, cover: d.cover, lang: d.lang }, chapter.title)
  }

  let imgs
  try {
    imgs = d.local ? d.localPages : await SITES[d.site].read(d, chapterId)
  } catch (e) {
    if (token !== readerToken) return
    list.replaceChildren(status(e.message, true), h('button', { class: 'load-more', onclick: () => openReader(d, chapterId) }, '重試'))
    return
  }
  if (token !== readerToken) return
  counter.textContent = `共 ${imgs.length} 頁`
  observer?.disconnect()
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        observer.unobserve(en.target)
        loadPage(en.target)
      }
    },
    { root: readerEl, rootMargin: '1800px 0px' },
  )
  els = imgs.map((p, i) => {
    const el = h('div', { class: 'page', 'data-i': i }, `${i + 1}`)
    el.page = p
    observer.observe(el)
    return el
  })
  const next = chIndex >= 0 && chIndex < d.chapters.length - 1 ? d.chapters[chIndex + 1] : null
  const end = h(
    'div',
    { class: 'reader-end' },
    next ? h('button', { class: 'btn primary', onclick: () => openReader(d, next.id) }, `下一話：${next.title}`) : '— 完 —',
  )
  list.replaceChildren(...els, end)

  // 從上次的頁數開始
  const start = Math.max(0, Math.min(startPage, els.length - 1))
  if (start > 0) {
    pinEl = els[start]
    readerEl.scrollTop = pinEl.offsetTop
    setTimeout(() => {
      if (pinEl === els[start]) pinEl = null
    }, 15000)
  }

  // 捲動時更新頁碼、記住看到哪一頁、讓上方列淡出
  const pkey = progressKey(d)
  const histItem = d.local ? null : { site: d.site, id: d.id }
  let lastY = 0
  let saved = -1
  let saveTimer = null
  readerEl.onscroll = () => {
    const y = readerEl.scrollTop
    bar.classList.toggle('faded', y > lastY && y > 200)
    lastY = y
    const mid = y + readerEl.clientHeight / 2
    let cur = 0
    for (const el of els) {
      if (el.offsetTop > mid) break
      cur = Number(el.dataset.i)
    }
    if (d.toc) {
      // 合集：顯示「第幾本 本內頁數 / 這本頁數」，選單跟著換
      let bi = 0
      while (bi < d.toc.length - 1 && d.toc[bi + 1].start <= cur) bi++
      const t = d.toc[bi]
      if (tocSel && document.activeElement !== tocSel) tocSel.value = String(bi)
      counter.textContent = `第 ${bi + 1} 本 ${cur - t.start + 1} / ${t.count}（總 ${cur + 1} / ${imgs.length}）`
    } else counter.textContent = `${cur + 1} / ${imgs.length}`
    // 用畫面頂端那一頁當進度（下次從這頁開頭開始）
    let topPage = 0
    for (const el of els) {
      if (el.offsetTop > y + 60) break
      topPage = Number(el.dataset.i)
    }
    // 釘住某一頁（繼續閱讀 / 從目錄跳）時，只記那一頁，不記載入中被推來推去的位置
    if (topPage === saved || (pinEl && topPage !== Number(pinEl.dataset.i))) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (token !== readerToken) return
      saved = topPage
      saveProgress(pkey, { chapterId: chapter?.id || null, chapterTitle: chapter && d.chapters.length > 1 ? chapter.title : '', page: topPage, total: imgs.length }, histItem)
    }, 500)
  }
  // 一打開就先記一次（只點開沒捲也算看過第一頁 / 從上次那頁開始）
  if (!getProgress(pkey) || getProgress(pkey).chapterId !== (chapter?.id || null)) {
    saveProgress(pkey, { chapterId: chapter?.id || null, chapterTitle: chapter && d.chapters.length > 1 ? chapter.title : '', page: start, total: imgs.length }, histItem)
  }
}

async function loadPage(el, retry = 0) {
  const p = el.page
  // eh 站的圖片網址要先開閱讀頁才拿得到；重試時換一台圖片伺服器
  if (p.resolve && (!p.url || retry)) {
    try {
      p.url = await p.resolve(retry > 0)
    } catch (e) {
      el.replaceChildren(h('div', { class: 'err' }, `第 ${Number(el.dataset.i) + 1} 頁：${e.message} `, h('button', { class: 'btn', onclick: () => loadPage(el, 1) }, '重試')))
      return
    }
  }
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    el.classList.add('loaded')
    if (p.segs > 0) el.replaceChildren(descramble(img, p.segs))
    else el.replaceChildren(img)
    // 上面的圖載入後高度變了，把畫面拉回要繼續看的那一頁
    if (pinEl && pinEl.isConnected) readerEl.scrollTop = pinEl.offsetTop
  }
  img.onerror = () => {
    if (retry < 2) return setTimeout(() => loadPage(el, retry + 1), 1200)
    el.replaceChildren(h('div', { class: 'err' }, `第 ${Number(el.dataset.i) + 1} 頁載入失敗 `, h('button', { class: 'btn', onclick: () => loadPage(el) }, '重試')))
  }
  img.src = p.url
}

/** jm 站的圖被橫切成 num 條上下倒置，照網站的演算法拼回來 */
function descramble(img, num) {
  const w = img.naturalWidth
  const hgt = img.naturalHeight
  const c = document.createElement('canvas')
  c.width = w
  c.height = hgt
  const ctx = c.getContext('2d')
  const over = hgt % num
  const base = Math.floor(hgt / num)
  for (let i = 0; i < num; i++) {
    let move = base
    const ySrc = hgt - base * (i + 1) - over
    let yDst = base * i
    if (i === 0) move += over
    else yDst += over
    ctx.drawImage(img, 0, ySrc, w, move, 0, yDst, w, move)
  }
  return c
}

/** 滾輪一格大約捲的距離（Chromium 一格是 100px 左右） */
const WHEEL_STEP = 100
let wheelTarget = null
let wheelFrame = 0

/**
 * 模擬滑鼠滾輪：目標位置往前加一段，再用動畫慢慢捲過去。
 * 按住方向鍵時鍵盤會連續送 keydown，目標一直往前推，就會順順地一直捲（不會一格一格頓）。
 */
function stopWheel() {
  cancelAnimationFrame(wheelFrame)
  wheelFrame = 0
  wheelTarget = null
}

function wheelScroll(delta) {
  const max = readerEl.scrollHeight - readerEl.clientHeight
  const from = wheelTarget ?? readerEl.scrollTop
  wheelTarget = Math.max(0, Math.min(max, from + delta))
  if (wheelFrame) return
  const step = () => {
    const cur = readerEl.scrollTop
    const diff = wheelTarget - cur
    if (Math.abs(diff) < 1) {
      readerEl.scrollTop = wheelTarget
      wheelTarget = null
      wheelFrame = 0
      return
    }
    // 每一格走剩下距離的 25%，前快後慢，跟滾輪的平滑捲動差不多
    readerEl.scrollTop = cur + diff * 0.25
    wheelFrame = requestAnimationFrame(step)
  }
  wheelFrame = requestAnimationFrame(step)
}

// 使用者自己用滑鼠捲動時，放掉鍵盤捲動的目標，免得被拉回去
readerEl.addEventListener('wheel', stopWheel, { passive: true })

/**
 * 方向鍵換頁：跳到下一頁 / 上一頁的頂端。
 * 比畫面還高的頁（條漫）先一段一段捲完，捲到底才換下一頁，免得跳過內容。
 */
function turnPage(dir) {
  stopWheel()
  const els = [...readerEl.querySelectorAll('.page')]
  if (!els.length) return
  const top = readerEl.scrollTop
  const view = readerEl.clientHeight
  const step = view * 0.9
  // 目前這頁 = 頂端已經捲過畫面頂端的最後一頁（多留 2px 誤差）
  let cur = 0
  for (let i = 0; i < els.length; i++) {
    if (els[i].offsetTop <= top + 2) cur = i
    else break
  }
  const el = els[cur]
  const pageTop = el.offsetTop
  const pageBottom = pageTop + el.offsetHeight
  let target
  if (dir > 0) {
    if (pageBottom - (top + view) > 40) target = Math.min(top + step, pageBottom - view)
    else if (cur < els.length - 1) target = els[cur + 1].offsetTop
    else target = readerEl.scrollHeight
  } else if (top - pageTop > 2) {
    // 這頁的開頭還在上面：長頁就往回捲一段，不然回到這頁頂端
    target = Math.max(pageTop, top - step)
  } else if (cur > 0) {
    const prev = els[cur - 1]
    // 上一頁比畫面高時，停在它的最後一段
    target = prev.offsetHeight > view ? prev.offsetTop + prev.offsetHeight - view : prev.offsetTop
  } else target = 0
  readerEl.scrollTop = target
}

function closeReader() {
  stopWheel()
  readerToken++
  observer?.disconnect()
  readerEl.onscroll = null
  readerEl.classList.add('hidden')
  readerEl.replaceChildren()
}

// ---------- 全域 ----------

/** 上方的語言切換：全部／中文／English／日本語，切換後重新載入目前頁面 */
function setupLang() {
  const box = $('#langToggles')
  const opts = [['', '全部語言'], ...Object.entries(LANGS)]
  const render = () =>
    box.replaceChildren(
      ...opts.map(([k, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `lang-btn${lang === k ? ' on' : ''}`,
            'data-lang': k,
            onclick: () => {
              if (lang === k) return
              lang = k
              setLangFilter(k)
              store.set('lang', k)
              render()
              if (currentNav === 'search' && lastSearch) pages.search(...lastSearch)
              else if (['home', 'favorites', 'history', 'library'].includes(currentNav)) pages[currentNav]()
            },
          },
          label,
        ),
      ),
    )
  render()
}

// ---------- 程式內更新 ----------

const REPO = 'DLIN131/ComicHub'
const ZIP_NAME = 'ComicHub-Windows.zip'

/** 目前版本的文字；version.js 由 CI 寫入（APP_VERSION = run_number），本機開發是 0 */
const versionText = () => (Number(window.APP_VERSION) ? `v1.0.${Number(window.APP_VERSION)}` : '開發版')

// ---------- 更新紀錄（change log） ----------

/** 從 GitHub 的發布說明拿每一版的內容；抓不到（離線）就用上次存的 */
async function fetchChangelog(timeoutMs = 8000) {
  // 連不到 GitHub（被擋、網路慢）時不要一直等，逾時就用上次存的
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json())
      .map((r) => {
        const code = Number(String(r.tag_name || '').split('.').pop()) || 0
        // 發布說明：第一行是標題，下面是條列；--- 以下是固定的下載網址，Co-Authored-By 也不用給使用者看
        const lines = String(r.body || '')
          .split('\n---')[0]
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('Co-Authored-By'))
        return { code, date: (r.published_at || '').slice(0, 10), title: lines[0] || '', items: lines.slice(1).map((l) => l.replace(/^[-*•]\s*/, '')) }
      })
      .filter((r) => r.code)
      .sort((a, b) => b.code - a.code)
    store.set('changelog', list)
    return list
  } catch {
    return store.get('changelog', [])
  } finally {
    clearTimeout(timer)
  }
}

/** 更新紀錄視窗；since 有值時只顯示比它新的版本（剛更新完用） */
async function showChangelog({ since = 0, title = '更新紀錄', list: preloaded = null } = {}) {
  const box = h('div', { class: 'detail-box changelog' }, h('button', { class: 'close', onclick: closeDetail, title: '關閉 (Esc)' }, '×'), h('h2', {}, title), loading())
  detailToken++
  detailEl.replaceChildren(box)
  detailEl.classList.remove('hidden')
  detailEl.scrollTop = 0
  const myToken = detailToken
  const list = (preloaded || (await fetchChangelog())).filter((r) => r.code > since)
  // 等的時候使用者已經關掉或開了別的視窗，就不要蓋回去
  if (myToken !== detailToken) return
  const current = Number(window.APP_VERSION) || 0
  box.lastChild.replaceWith(
    list.length
      ? h(
          'div',
          { class: 'cl-list' },
          list.map((r) =>
            h(
              'div',
              { class: `cl-item${r.code === current ? ' current' : ''}` },
              h('div', { class: 'cl-head' }, h('b', {}, `v1.0.${r.code}`), r.code === current ? h('span', { class: 'cl-now' }, '目前版本') : null, h('span', { class: 'cl-date' }, r.date)),
              h('div', { class: 'cl-title' }, r.title),
              r.items.length ? h('ul', {}, r.items.map((i) => h('li', {}, i))) : null,
            ),
          ),
        )
      : status('讀不到更新紀錄（第一次查看需要網路）'),
  )
}

/** 更新後第一次開：自動顯示這次更新了什麼（從上次用的版本之後的每一版） */
async function showWhatsNew() {
  const current = Number(window.APP_VERSION) || 0
  if (!current) return
  const seen = store.get('lastSeenVersion', 0)
  store.set('lastSeenVersion', current)
  // 全新安裝不跳；真的更新過才跳
  if (!seen || seen >= current) return
  // 先在背景讀好，讀到了才跳出來；6 秒讀不到就算了。
  // 以前是一開程式就先蓋一層半透明黑幕 + 載入中，連不到 GitHub 時就一直卡著，看起來像黑畫面
  const list = (await fetchChangelog(6000)).filter((r) => r.code > seen)
  if (!list.length || !detailEl.classList.contains('hidden') || !readerEl.classList.contains('hidden')) return
  showChangelog({ since: seen, title: `已更新到 v1.0.${current}`, list })
}

/**
 * 檢查新版；有的話右下角跳更新提示。manual = 使用者自己按「檢查更新」（不管有沒有略過這版都顯示）。
 * 回傳 'dev' | 'latest' | 'shown' | 'error'
 */
async function checkUpdate(manual = false) {
  const current = Number(window.APP_VERSION) || 0
  if (!current) return 'dev'
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return 'error'
    const r = await res.json()
    const code = Number(String(r.tag_name || '').split('.').pop()) || 0
    const asset = (r.assets || []).find((a) => a.name === ZIP_NAME)
    if (code <= current || !asset) return 'latest'
    if (!manual && store.get('skippedVersion', 0) === code) return 'latest'
    document.querySelector('.update-bar')?.remove()
    // 發布說明裡 --- 以下是固定的下載資訊，Co-Authored-By 也不用給使用者看
    const notes = String(r.body || '')
      .split('\n---')[0]
      .split('\n')
      .filter((l) => !l.startsWith('Co-Authored-By'))
      .join('\n')
      .trim()
    const st = h('div', { class: 'status' })
    const primary = h('button', { class: 'btn primary' }, '立即更新')
    const skip = h('button', { class: 'btn' }, '略過這個版本')
    const later = h('button', { class: 'btn' }, '稍後')
    const bar = h(
      'div',
      { class: 'update-bar' },
      h('div', {}, h('b', {}, `發現新版本 v1.0.${code}`), `（目前 v1.0.${current}）`, h('div', { class: 'notes' }, notes), st),
      primary,
      skip,
      later,
    )
    const inApp = window.updater && (await window.updater.supported().catch(() => false))
    let busy = false
    primary.onclick = async () => {
      // 不是打包版（例如開發時）就退回用瀏覽器下載
      if (!inApp) {
        window.hub.external(asset.browser_download_url)
        return bar.remove()
      }
      if (busy) return
      if (dl.activeCount() && !confirm('還有作品在下載，更新會中斷下載。要繼續嗎？')) return
      busy = true
      primary.textContent = '下載中…'
      skip.disabled = later.disabled = true
      try {
        await window.updater.download(asset.browser_download_url, (p) => {
          st.textContent = p >= 0 ? `下載中 ${p}%` : '下載中…'
          if (p >= 100) st.textContent = '解壓縮中…'
        })
        st.textContent = '下載完成，程式會關閉並自動重新開啟'
        primary.textContent = '安裝中…'
        await window.updater.install()
      } catch (err) {
        busy = false
        primary.textContent = '重試'
        skip.disabled = later.disabled = false
        st.textContent = `更新失敗：${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
      }
    }
    skip.onclick = () => {
      store.set('skippedVersion', code)
      bar.remove()
    }
    later.onclick = () => bar.remove()
    document.body.append(bar)
    return 'shown'
  } catch {
    return 'error'
  }
}

function setupSearch() {
  const cfg = getConfig().sites
  $('#searchInput').placeholder = `關鍵字或編號（123、${cfg.jm.prefix}123、${cfg.wn.prefix}123）`
  const enabled = new Set(store.get('searchSites', SITE_KEYS))
  const box = $('#siteToggles')
  for (const k of SITE_KEYS) {
    const chip = h('button', { type: 'button', class: `chip${enabled.has(k) ? ' on' : ''}`, 'data-site': k, title: `搜尋時包含 ${SITES[k].label}` }, SITES[k].short)
    chip.onclick = () => {
      if (enabled.has(k)) {
        if (enabled.size === 1) return toast('至少要選一個站')
        enabled.delete(k)
      } else enabled.add(k)
      chip.classList.toggle('on', enabled.has(k))
      store.set('searchSites', [...enabled])
    }
    box.append(chip)
  }
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault()
    const q = $('#searchInput').value.trim()
    if (!q) return
    closeDetail()
    closeReader()
    pages.search(q, [...enabled])
  }
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]')
  if (!nav) return
  closeDetail()
  closeReader()
  pages[nav.dataset.nav]()
})

detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) closeDetail()
})

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return
  if (!readerEl.classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === 'Backspace') closeReader()
    else if (e.key === '+' || e.key === '=') readerEl.querySelector('.reader-bar button[title^="放大"]').click()
    else if (e.key === '-') readerEl.querySelector('.reader-bar button[title^="縮小"]').click()
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // ↑↓ 跟滑鼠滾輪一樣：每按一下平滑捲一小段，按住就一直捲
      e.preventDefault()
      wheelScroll(e.key === 'ArrowDown' ? WHEEL_STEP : -WHEEL_STEP)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      turnPage(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      turnPage(-1)
    } else if (e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault()
      readerEl.scrollBy({ top: readerEl.clientHeight * 0.9, behavior: 'smooth' })
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      readerEl.scrollBy({ top: -readerEl.clientHeight * 0.9, behavior: 'smooth' })
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      readerEl.scrollTop = e.key === 'Home' ? 0 : readerEl.scrollHeight
    }
    return
  }
  if (e.key === 'Escape' && !detailEl.classList.contains('hidden')) closeDetail()
})

function updateDlCount() {
  const n = dl.activeCount()
  const el = $('#dlCount')
  el.textContent = n
  el.classList.toggle('hidden', !n)
}
dl.onChange(updateDlCount)

// 下載完成 / 失敗時跳提示（不用一直盯著「下載」頁）
const lastStatus = new Map(dl.allJobs().map((j) => [j.key, j.status]))
dl.onChange((jobs) => {
  for (const j of jobs) {
    const before = lastStatus.get(j.key)
    if (before !== j.status && (before === 'running' || before === 'queued')) {
      const name = `${j.title}${j.chapterTitle ? ` ${j.chapterTitle}` : ''}`
      if (j.status === 'done') toast(`下載完成：${name}`)
      else if (j.status === 'error') toast(`下載失敗：${name}（${j.error}）`)
    }
    lastStatus.set(j.key, j.status)
  }
})

/**
 * 啟動的每一步各自包起來：某一步出錯（例如舊資料裡有奇怪的值）只記錯誤，不會整個卡住變黑畫面。
 * 錯誤用 console.error 印出，主程序會記到 startup.log（見 watchdog.js）。
 */
const step = (name, fn) => {
  try {
    fn()
  } catch (e) {
    console.error(`startup step "${name}" failed: ${e && e.stack ? e.stack : e}`)
  }
}

/** 頁面上方的提示條（要使用者注意、不會自己消失的訊息） */
function notice(msg) {
  const bar = h('div', { class: 'notice-bar' }, h('span', {}, msg), h('button', { class: 'btn', onclick: () => bar.remove() }, '知道了'))
  view.before(bar)
}

const startup = () => {
  step('version label', () =>
  $('.brand').append(
    h(
      'span',
      {
        class: 'ver',
        title: '看更新紀錄',
        onclick: (e) => {
          // 版本字在 Logo 裡面，點它不要跳回首頁
          e.stopPropagation()
          showChangelog()
        },
      },
      versionText(),
    ),
  ))
  step('language', setupLang)
  step('search', setupSearch)
  step('check update', () => checkUpdate())
  step("what's new", () => showWhatsNew())
  // 資料夾被刪掉後，從程式資料夾的備份把紀錄救回來了
  step('restore notice', () => {
    if (store.get('_restoredFrom')) {
      toast('已從備份還原觀看紀錄和設定')
      store.set('_restoredFrom', null)
    }
  })
}

loadConfig()
  .then(startup)
  .catch((e) => console.error(`startup failed: ${e && e.stack ? e.stack : e}`))
  .finally(() => {
    // 告訴主程序畫面載好了（沒回報的話會自動重載，避免黑畫面卡住）
    window.hub.ready()
    step('home page', () => pages.home())
  })

// 測試用
window.__app = { pages, openDetail, openReader, closeDetail, SITES, dl, showChangelog, showWhatsNew, notice, toast }
