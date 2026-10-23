import { SITES, SITE_KEYS, LANGS, setLangFilter, loadConfig, getConfig } from './sites.js'
import * as dl from './downloader.js'

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

// ---------- 本機儲存 ----------

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
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

  search(q, sites, { keyword = false } = {}) {
    setNav('search')
    lastSearch = [q, sites, { keyword }]
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
          : loadFiltered((p) => SITES[s.site].search(q, p), s.page + 1)
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
          status(st.error ? `無法確認登入狀態：${st.error}` : `還沒登入${SITES[site].label}，登入後就能看到網站上的收藏`),
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
    let books = []
    // 只篩畫面，不重新讀資料夾
    const render = () => {
      if (currentNav !== 'library') return
      const groups = shelfGroups()
      let group = store.get('libGroup', 'all')
      if (group !== 'all' && group !== NO_GROUP && !groups.list.includes(group)) group = 'all'
      const kw = filterInput.value.trim().toLowerCase()
      const visible = books.filter((b) => passLang(localLang(b)) && (!kw || `${b.title} ${b.name} ${(b.authors || []).join(' ')}`.toLowerCase().includes(kw)))
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
        grid.replaceChildren(...shown.map((b) => localCard(b, load)))
        body.replaceChildren(grid)
      }
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
        ),
      ),
      tabs,
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
    const render = () => {
      if (currentNav !== 'downloads') return off()
      const jobs = dl.allJobs()
      if (!jobs.length) return list.replaceChildren(status('還沒有下載任何作品。在作品頁按「下載 CBZ」就會出現在這裡'))
      list.replaceChildren(
        ...jobs.map((j) => {
          const pct = j.status === 'done' ? 100 : j.total ? Math.round((j.done / j.total) * 100) : 0
          const btns = []
          if (j.status === 'queued' || j.status === 'running') btns.push(h('button', { class: 'btn', onclick: () => dl.cancel(j.key) }, '取消'))
          if ((j.status === 'error' || j.status === 'canceled') && j.d) btns.push(h('button', { class: 'btn', onclick: () => dl.retry(j.key) }, '重試'))
          if (j.status === 'done' && j.file) {
            btns.push(h('button', { class: 'btn primary', onclick: () => openLocalFile(j.file) }, '閱讀'))
            btns.push(h('button', { class: 'btn', onclick: () => window.hub.dl.show(j.file) }, '在資料夾顯示'))
          }
          return h(
            'div',
            { class: `dl-item ${j.status}` },
            h('img', { src: j.cover || '', alt: '', onclick: () => openDetail({ site: j.site, id: j.id, title: j.title, cover: j.cover }) }),
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
    const off = dl.onChange(render)
    view.replaceChildren(
      h('div', { class: 'section-head' }, h('h2', {}, '下載'), h('button', { class: 'more', onclick: () => dl.clearFinished() }, '清除已完成')),
      h(
        'div',
        { class: 'dl-head' },
        '儲存位置：',
        dirEl,
        h('button', { class: 'btn', onclick: () => window.hub.dl.openDir() }, '開啟資料夾'),
        h('button', { class: 'btn', onclick: async () => (dirEl.textContent = await window.hub.dl.chooseDir()) }, '變更位置'),
      ),
      list,
    )
    render()
  },

  account() {
    setNav('account')
    const cfg = getConfig()
    const cards = SITE_KEYS.map((k) => {
      const st = h('div', { class: 'st' }, h('span', { class: 'spinner' }), ' 確認中…')
      const btns = h('div', { class: 'row2' })
      const input = h('input', { value: cfg.sites[k].base, spellcheck: 'false' })
      const refresh = async () => {
        st.className = 'st'
        st.replaceChildren(h('span', { class: 'spinner' }), ' 確認中…')
        btns.replaceChildren()
        const s = await window.hub.authStatus(k)
        if (s.loggedIn) {
          st.className = 'st ok'
          st.textContent = `已登入${s.name ? `：${s.name}` : ''}`
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
        } else {
          st.textContent = s.error ? `未登入（${s.error}）` : '未登入'
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
        '按「登入」會開啟該網站自己的登入頁，帳號密碼直接在網站上輸入，本程式不會經手。',
        h('br'),
        '登入成功後關掉那個視窗即可，登入狀態會保存在本機，下次開程式不用重登。三個站的登入互相獨立。',
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

async function doLogin(site) {
  toast(`在新視窗登入 ${SITES[site].label}，完成後關閉視窗`)
  const s = await window.hub.login(site)
  if (site === 'jm') SITES.jm.username = s.name || ''
  toast(s.loggedIn ? `${SITES[site].label} 已登入${s.name ? `：${s.name}` : ''}` : `${SITES[site].label} 尚未登入`)
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
              onclick: () => {
                closeDetail()
                $('#searchInput').value = t.query
                pages.search(t.query, [d.site])
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
  actions.append(h('button', { class: 'btn primary', onclick: () => openReader(d, startId) }, d.chapters.length ? '從第一話開始' : '開始閱讀'))
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
  return h(
    'div',
    { class: `card${b.error ? ' broken' : ''}`, title: b.name, onclick: () => bookPopup(b, reload) },
    h(
      'div',
      { class: 'thumb' },
      b.cover ? h('img', { src: b.cover, loading: 'lazy', alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }) : h('div', { class: 'broken-icon' }, '!'),
      site ? badge(site) : h('span', { class: 'badge local' }, b.source || '本機'),
      langBadge(localLang(b).lang),
      group ? h('span', { class: 'group-tag' }, group) : null,
    ),
    h('div', { class: 'title' }, b.title),
    h('div', { class: 'sub' }, b.error ? `無法讀取：${b.error}` : [b.chapter, `${b.pageCount} 頁`].filter(Boolean).join('・')),
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
  if (!b.error) actions.append(h('button', { class: 'btn primary', onclick: () => openLocal(b) }, '開始閱讀'))
  if (srcSite) actions.append(h('button', { class: 'btn', onclick: () => openDetail({ site: srcSite, id: nm[2], title: b.title, cover: b.cover }) }, '網站作品頁'))
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

function openLocal(b) {
  if (!b.pageCount) return toast('這個檔案裡沒有圖片')
  closeDetail()
  openReader(
    { site: siteOfLocal(b) || 'local', id: b.id, title: b.title, subtitle: b.chapter, chapters: [], local: true, localPages: b.pages.map((url) => ({ url, segs: 0 })) },
    null,
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

async function openReader(d, chapterId) {
  const token = ++readerToken
  const chIndex = d.chapters.findIndex((c) => c.id === chapterId)
  const chapter = chIndex >= 0 ? d.chapters[chIndex] : null
  const width = store.get('pageWidth', 900)
  readerEl.style.setProperty('--page-w', width + 'px')
  const title = h('div', { class: 't' }, SITES[d.site] ? badge(d.site, true) : null, ' ', d.title, chapter && d.chapters.length > 1 ? `　/　${chapter.title}` : '', d.subtitle ? `　/　${d.subtitle}` : '')
  const counter = h('span', {}, '')
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
  const els = imgs.map((p, i) => {
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

  // 捲動時更新頁碼、讓上方列淡出
  let lastY = 0
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
    counter.textContent = `${cur + 1} / ${imgs.length}`
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

/**
 * 方向鍵換頁：跳到下一頁 / 上一頁的頂端。
 * 比畫面還高的頁（條漫）先一段一段捲完，捲到底才換下一頁，免得跳過內容。
 */
function turnPage(dir) {
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

/** version.js 由 CI 寫入（APP_VERSION = run_number），本機開發是 0，不檢查 */
async function checkUpdate() {
  const current = Number(window.APP_VERSION) || 0
  if (!current) return
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return
    const r = await res.json()
    const code = Number(String(r.tag_name || '').split('.').pop()) || 0
    const asset = (r.assets || []).find((a) => a.name === ZIP_NAME)
    if (code <= current || !asset || store.get('skippedVersion', 0) === code) return
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
  } catch {}
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
  if (e.target.tagName === 'INPUT') return
  if (!readerEl.classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === 'Backspace') closeReader()
    else if (e.key === '+' || e.key === '=') readerEl.querySelector('.reader-bar button[title^="放大"]').click()
    else if (e.key === '-') readerEl.querySelector('.reader-bar button[title^="縮小"]').click()
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      turnPage(1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
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

loadConfig().then(() => {
  setupLang()
  setupSearch()
  checkUpdate()
  pages.home()
})

// 測試用
window.__app = { pages, openDetail, openReader, closeDetail, SITES, dl }
