// 抓資料都在主程序做：每個站有自己的 partition（cookie / 登入狀態互不干擾），
// 一般請求走 session.fetch；遇到 Cloudflare 驗證頁就改用隱藏視窗載入真的網頁，過關後 cookie 留在 partition 裡，之後 fetch 就能直接用。
const { app, BrowserWindow, session } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 站名、網址、編號前綴以 Base64 存放，原始碼裡不出現明文
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8')
const SITES = {
  nh: { label: b64('bmhlbnRhaQ=='), base: b64('aHR0cHM6Ly9uaGVudGFpLm5ldA=='), login: '/login/', prefix: '#' },
  jm: { label: b64('56aB5ryr5aSp5aCC'), base: b64('aHR0cHM6Ly8xOGNvbWljLnZpcA=='), login: '/login', prefix: 'JM' },
  wn: { label: b64('57Sz5aOr5ryr55Wr'), base: b64('aHR0cHM6Ly93d3cud25hY2cuY29t'), login: '/users-login.html', prefix: b64('d25hY2c=') },
  eh: { label: b64('RS1IZW50YWk='), base: b64('aHR0cHM6Ly9lLWhlbnRhaS5vcmc='), login: null, prefix: '' },
}

let UA = ''
let overrides = {}
const settingsFile = () => path.join(app.getPath('userData'), 'sites.json')

function init(ua) {
  UA = ua
  try {
    overrides = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    overrides = {}
  }
  for (const site of Object.keys(SITES)) {
    const ses = sesOf(site)
    ses.setUserAgent(UA)
    // 隱藏視窗只要 HTML，圖片 / 影片 / 字型都不載，速度快很多
    ses.webRequest.onBeforeRequest((details, cb) => {
      const hidden = workers[site]
      const fromWorker = hidden && !hidden.isDestroyed() && details.webContentsId === hidden.webContents.id
      cb({ cancel: fromWorker && ['image', 'media', 'font'].includes(details.resourceType) })
    })
  }
}

const label = (site) => SITES[site].label
const base = (site) => (overrides[site] || SITES[site].base).replace(/\/+$/, '')
const partition = (site) => `persist:${site}`
const sesOf = (site) => session.fromPartition(partition(site))
const loginUrl = (site) => (site === 'eh' ? forumUrl('/index.php?act=Login&CODE=00') : base(site) + SITES[site].login)

/** 取網域最後兩段，例如 cdn.example.com → example.com */
function rootDomain(host) {
  return host.split('.').slice(-2).join('.')
}

function siteForUrl(url) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const site of Object.keys(SITES)) {
    const root = rootDomain(new URL(base(site)).hostname)
    if (host === root || host.endsWith('.' + root)) return site
  }
  return null
}

function config() {
  const sites = {}
  for (const [k, v] of Object.entries(SITES)) sites[k] = { label: v.label, base: base(k), defaultBase: v.base, prefix: v.prefix }
  return { sites }
}

function setBase(site, value) {
  const v = String(value || '').trim().replace(/\/+$/, '')
  if (!v || v === SITES[site].base) delete overrides[site]
  else {
    if (!/^https?:\/\/[^/]+$/.test(v)) return { ok: false, error: '網址格式要像 https://example.com' }
    overrides[site] = v
  }
  fs.writeFileSync(settingsFile(), JSON.stringify(overrides, null, 2))
  return { ok: true, config: config() }
}

const isChallenge = (status, text) =>
  (status === 403 || status === 503) && /challenge-platform|Just a moment|cf-chl|Attention Required/i.test(text)

// ---------- 隱藏視窗（過 Cloudflare 用） ----------

const workers = {}
const queues = {}

function worker(site) {
  let w = workers[site]
  if (!w || w.isDestroyed()) {
    w = new BrowserWindow({
      show: false,
      width: 1000,
      height: 760,
      title: `${label(site)}：請完成驗證`,
      autoHideMenuBar: true,
      webPreferences: { partition: partition(site), contextIsolation: true, backgroundThrottling: false },
    })
    w.removeMenu()
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.setAudioMuted(true)
    // 使用者關掉驗證視窗時只是藏起來，不要讓等待中的請求永遠卡住
    w.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault()
        w.hide()
        w.giveUp = true
      }
    })
    workers[site] = w
  }
  return w
}

app.on('before-quit', () => {
  app.isQuitting = true
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用隱藏視窗載入網頁拿 HTML。15 秒還在驗證頁就把視窗顯示出來讓使用者手動點驗證 */
function loadViaWindow(site, url) {
  const run = async () => {
    const w = worker(site)
    w.giveUp = false
    w.loadURL(url).catch(() => {})
    const start = Date.now()
    while (Date.now() - start < 120000) {
      await sleep(600)
      if (w.isDestroyed()) break
      if (w.giveUp) throw new Error('驗證視窗被關閉了')
      if (w.webContents.isLoading() && Date.now() - start < 3000) continue
      let info
      try {
        info = await w.webContents.executeJavaScript(
          '({ title: document.title, ready: document.readyState, html: document.documentElement.outerHTML })',
        )
      } catch {
        continue
      }
      const challenged = /Just a moment|請稍候|Attention Required|cf-chl|challenge-platform/i.test(info.title + info.html.slice(0, 4000))
      if (!challenged && info.ready !== 'loading') {
        if (w.isVisible()) w.hide()
        // 網頁會一直跑廣告腳本，拿到內容就換成空白頁
        w.loadURL('about:blank').catch(() => {})
        return info.html
      }
      if (challenged && Date.now() - start > 15000 && !w.isVisible()) w.show()
    }
    if (!w.isDestroyed()) w.hide()
    throw new Error('網站驗證逾時，請稍後再試')
  }
  const prev = queues[site] || Promise.resolve()
  const p = prev.catch(() => {}).then(run)
  queues[site] = p
  return p
}

// ---------- 一般請求 ----------

async function nhToken() {
  const list = await sesOf('nh').cookies.get({ url: base('nh'), name: 'access_token' })
  return list[0] ? decodeURIComponent(list[0].value) : null
}

/** 網站本身的換票方式：refresh token 在 cookie 裡，POST /auth/refresh 會寫回新的 access_token */
async function nhRefresh() {
  try {
    const r = await sesOf('nh').fetch(base('nh') + '/auth/refresh', { method: 'POST', credentials: 'include' })
    return r.ok
  } catch {
    return false
  }
}

async function rawFetch(site, url, opts, token) {
  const headers = { Referer: base(site) + '/', ...(opts.headers || {}) }
  if (token) headers.Authorization = `User ${token}`
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const r = await sesOf(site).fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    credentials: 'include',
    redirect: 'follow',
  })
  return { status: r.status, url: r.url, text: await r.text() }
}

/**
 * 給頁面用的請求介面，回傳 { ok, data, status, error }（ipc 丟例外會被包成一串英文，自己處理比較好讀）。
 * opts: { json, method, body, headers }
 */
async function get(site, url, opts = {}) {
  const full = /^https?:/.test(url) ? url : base(site) + url
  try {
    let token = site === 'nh' ? await nhToken() : null
    let r = await rawFetch(site, full, opts, token)
    if (site === 'nh' && r.status === 401 && token && (await nhRefresh())) {
      token = await nhToken()
      r = await rawFetch(site, full, opts, token)
    }
    if (isChallenge(r.status, r.text)) {
      if ((opts.method || 'GET') !== 'GET') return { ok: false, status: r.status, error: '被網站驗證擋下，請先瀏覽一下該站再試' }
      const html = await loadViaWindow(site, full)
      return { ok: true, status: 200, data: opts.json ? JSON.parse(html) : html, url: full }
    }
    if (r.status < 200 || r.status >= 300) {
      let msg = `HTTP ${r.status}`
      try {
        const j = JSON.parse(r.text)
        msg = j.error || j.detail || msg
        if (typeof msg !== 'string') msg = JSON.stringify(msg)
      } catch {}
      if (r.status === 404) msg = '找不到（可能已被刪除）'
      if (r.status === 429) msg = '請求太頻繁，稍等一下再試'
      return { ok: false, status: r.status, error: msg }
    }
    return { ok: true, status: r.status, data: opts.json ? JSON.parse(r.text || 'null') : r.text, url: r.url }
  } catch (e) {
    const msg = e.message || String(e)
    // 斷網、DNS 失敗、網站被擋都是 net::ERR_ 開頭，給看得懂的說明
    return { ok: false, status: 0, error: /net::ERR_/.test(msg) ? `連不上網站（網路中斷或網站被擋，${msg.replace(/^.*net::/, '')}）` : msg }
  }
}

/** 下載用：抓圖片原始位元組（帶該站 Referer），失敗重試兩次 */
async function bytes(site, url) {
  let last = ''
  for (let i = 0; i < 3; i++) {
    try {
      const r = await sesOf(site).fetch(url, { headers: { Referer: base(site) + '/' }, credentials: 'include' })
      if (r.ok) return { ok: true, data: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') || '' }
      last = `HTTP ${r.status}`
      if (r.status === 404) break
    } catch (e) {
      last = e.message
    }
    await sleep(1000 * (i + 1))
  }
  return { ok: false, error: last || '下載失敗' }
}

// ---------- 帳號 ----------

async function authStatus(site) {
  if (site === 'nh') {
    if (!(await nhToken()) && !(await nhRefresh())) return { loggedIn: false }
    const r = await get('nh', '/api/v2/user', { json: true })
    if (!r.ok) return { loggedIn: false, error: r.status === 401 ? '' : r.error }
    return { loggedIn: true, name: r.data.username || r.data.name || '' }
  }
  if (site === 'jm') {
    // 「我的」頁 /user/：沒登入會被導到 /login，登入後是自己的頁面（網址或頁面裡有 /user/<帳號>）
    const r = await get('jm', '/user/')
    if (!r.ok) return { loggedIn: false, error: r.error }
    const html = r.data
    const loginPage = /\/login(?:[/?#]|$)/.test(r.url || '') || /<title>\s*Login\b/i.test(html)
    if (loginPage) return { loggedIn: false }
    return { loggedIn: true, name: accountName('jm') || jmNameFrom(r.url, html) }
  }
  if (site === 'wn') {
    const r = await get('wn', '/users.html')
    if (!r.ok) return { loggedIn: false, error: r.error }
    const html = r.data
    if (/users-login\.html/.test(r.url) || !/users-logout|退出|登出/.test(html)) return { loggedIn: false }
    const m = html.match(/歡迎[：:,，\s]*(?:<[^>]+>)*\s*([^<\s]+)/) || html.match(/class="[^"]*user_name[^"]*"[^>]*>\s*([^<]+)/)
    return { loggedIn: true, name: m ? m[1].trim() : '' }
  }
  if (site === 'eh') {
    // 登入後論壇會在整個網域寫 ipb_member_id / ipb_pass_hash
    const list = await sesOf('eh').cookies.get({ url: base('eh'), name: 'ipb_member_id' })
    if (!list.length || list[0].value === '0') return { loggedIn: false }
    const r = await get('eh', forumUrl('/index.php'))
    const m = r.ok && r.data.match(/Logged in as:?\s*(?:<[^>]+>\s*)*([^<]+)</i)
    return { loggedIn: true, name: m ? m[1].trim() : '' }
  }
  return { loggedIn: false }
}

/**
 * 從 jm 站「我的」頁找帳號名稱（沒有帳號可以實測，所以多試幾種寫法）：
 * 網址 /user/<帳號> → 收藏分頁連結 /user/<帳號>/favorite → 選單「我的」→ 頁面上出現最多次的 /user/<帳號>
 */
function jmNameFrom(url, html) {
  const dec = (s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const fromUrl = (String(url || '').match(/\/user\/([^/?#]+)/) || [])[1]
  if (fromUrl) return dec(fromUrl)
  const fav = (html.match(/\/user\/([^"/?#\s]+)\/favorite/) || [])[1]
  if (fav) return dec(fav)
  const menu =
    (html.match(/href="(?:https?:\/\/[^/"]+)?\/user\/([^"/?#]+)\/?"[^>]*>[\s\S]{0,200}?我的/) || [])[1] ||
    (html.match(/href="(?:https?:\/\/[^/"]+)?\/user\/([^"/?#]+)\/?"[^>]*>\s*<i class="fas? fa-user-circle/) || [])[1]
  if (menu) return dec(menu)
  const count = {}
  for (const m of html.matchAll(/href="(?:https?:\/\/[^/"]+)?\/user\/([^"/?#]+)(?:\/[^"]*)?"/g)) count[m[1]] = (count[m[1]] || 0) + 1
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0]
  return top && top[1] >= 3 ? dec(top[0]) : ''
}

// ---------- 使用者自己設定 / 登入時記下的帳號名稱 ----------

const accountsFile = () => path.join(app.getPath('userData'), 'accounts.json')
let accounts = null
function loadAccounts() {
  if (!accounts) {
    try {
      accounts = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'))
    } catch {
      accounts = {}
    }
  }
  return accounts
}
const accountName = (site) => loadAccounts()[site]?.name || ''
function setAccountName(site, name) {
  const a = loadAccounts()
  const v = String(name || '').trim()
  if (v) a[site] = { name: v }
  else delete a[site]
  fs.writeFileSync(accountsFile(), JSON.stringify(a, null, 2))
  return { ok: true }
}

/** eh 站的帳號在論壇子網域 */
const forumUrl = (p) => base('eh').replace('://', '://forums.') + p

async function logout(site) {
  const ses = sesOf(site)
  if (site === 'nh') await ses.fetch(base('nh') + '/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  await ses.clearStorageData()
  setAccountName(site, '')
  return { loggedIn: false }
}

// ---------- jm 站閱讀頁：圖片被切條打亂，算出每張要切幾段 ----------

function jmSegments(scrambleId, aid, file) {
  if (aid < scrambleId) return 0
  if (aid < 268850) return 10
  const x = aid < 421926 ? 10 : 8
  const h = crypto.createHash('md5').update(`${aid}${file}`).digest('hex')
  return (h.charCodeAt(h.length - 1) % x) * 2 + 2
}

async function jmReader(id) {
  const r = await get('jm', `/photo/${id}`)
  if (!r.ok) return r
  const html = r.data
  const aid = Number((html.match(/var aid = (\d+);/) || [])[1] || id)
  const scramble = Number((html.match(/var scramble_id = (\d+);/) || [])[1] || 220980)
  let files = []
  try {
    files = JSON.parse((html.match(/var page_arr = (\[[^\]]*\]);/) || [])[1] || '[]')
  } catch {}
  const urls = {}
  const re = new RegExp(`data-original="([^"]*/media/photos/${aid}/([^"?/]+)[^"]*)"`, 'g')
  let m
  while ((m = re.exec(html))) if (!urls[m[2]]) urls[m[2]] = m[1]
  if (!files.length) files = Object.keys(urls)
  const cdn = (Object.values(urls)[0] || '').replace(/\/media\/photos\/.*$/, '') || base('jm').replace('//', '//cdn-msp.')
  const pages = files.map((f) => ({
    url: urls[f] || `${cdn}/media/photos/${aid}/${f}`,
    segs: f.endsWith('.gif') ? 0 : jmSegments(scramble, aid, f.replace(/\.[^.]+$/, '')),
  }))
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  return { ok: true, data: { aid, title: title.split('|')[0].trim(), pages } }
}

module.exports = { init, get, bytes, config, setBase, label, base, partition, loginUrl, siteForUrl, authStatus, logout, jmReader, accountName, setAccountName }
