// 抓資料都在主程序做：每個站有自己的 partition（cookie / 登入狀態互不干擾），
// 一般請求走 session.fetch；遇到 Cloudflare 驗證頁就改用隱藏視窗載入真的網頁，過關後 cookie 留在 partition 裡，之後 fetch 就能直接用。
const { app, BrowserWindow, safeStorage, session } = require('electron')
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
    keepLoginCookies(site, ses)
  }
  // jm 站的登入是記在網站伺服器上，大約 30 分鐘沒動作就會被登出；程式開著時每 10 分鐘碰一下「我的」頁保持登入。
  // 電腦關機 / 重開機之後伺服器那邊早就過期了，cookie 還在也沒用 → 使用者同意記住密碼的話，開程式時自動重新登入
  setInterval(() => {
    if (loadAccounts().jm?.seen) authStatus('jm').catch(() => {})
  }, 10 * 60 * 1000)
  setTimeout(() => {
    if (loadAccounts().jm?.seen && hasCred('jm')) authStatus('jm').catch(() => {})
  }, 4000)
}

const flushTimers = {}
/** cookie 變動後幾秒內就寫到硬碟（Chromium 平常最多隔 30 秒才寫，關機時沒寫到的就沒了） */
function flushCookiesSoon(site) {
  clearTimeout(flushTimers[site])
  flushTimers[site] = setTimeout(() => sesOf(site).cookies.flushStore().catch(() => {}), 2000)
}
/** Windows 登出 / 關機時呼叫：馬上把各站 cookie 寫到硬碟 */
function flushAllCookies() {
  return Promise.all(Object.keys(SITES).map((s) => sesOf(s).cookies.flushStore().catch(() => {})))
}

/**
 * 有的站登入用的是「工作階段 cookie」（沒有到期日），Chromium 關程式就丟掉，
 * 結果每次重開都被登出。把該站自己網域的這種 cookie 改成 30 天後到期，就會存到硬碟。
 */
function keepLoginCookies(site, ses) {
  ses.cookies.on('changed', (_e, c, _cause, removed) => {
    const host = c.domain.replace(/^\./, '')
    const root = rootDomain(new URL(base(site)).hostname)
    if (host !== root && !host.endsWith('.' + root)) return
    flushCookiesSoon(site)
    if (removed || !c.session) return
    ses.cookies
      .set({
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        // 開頭有點的是整個網域共用；沒有點的是只給這台主機，不能帶 domain
        domain: c.domain.startsWith('.') ? c.domain : undefined,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: Date.now() / 1000 + 30 * 24 * 3600,
      })
      .catch(() => {})
  })
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

async function checkAuth(site) {
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
 * 網址 /user/<帳號> → 收藏分頁連結 /user/<帳號>/favorite → 選單「我的」
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
  // 抓不到就回空字串，讓使用者自己填；不要猜（以前猜「出現最多次的帳號」可能抓到別人，收藏就變成空的）
  return menu ? dec(menu) : ''
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
/** 上次登入時打的帳號（下次登入視窗先幫忙填好；只記帳號，不記密碼） */
const lastLogin = (site) => loadAccounts()[site]?.login || accountName(site)
function setLastLogin(site, login) {
  const a = loadAccounts()
  a[site] = { ...a[site], login: String(login || '').trim() }
  saveAccounts()
}
function saveAccounts() {
  try {
    fs.writeFileSync(accountsFile(), JSON.stringify(loadAccounts(), null, 2))
  } catch {}
}
function setAccountName(site, name) {
  const a = loadAccounts()
  const v = String(name || '').trim()
  a[site] = { ...a[site], name: v }
  if (!v) delete a[site].name
  saveAccounts()
  return { ok: true }
}

/**
 * 包一層：記住「這個站登入過」。之後變成沒登入（網站那邊的登入過期了）就回 expired，
 * 畫面才能說「登入已過期，請重新登入」，而不是只顯示空的收藏。
 */
async function authStatus(site) {
  let s = await checkAuth(site)
  const a = loadAccounts()
  // 過期了、使用者有讓程式記住密碼 → 自動重新登入一次（5 分鐘內失敗過就不再試，免得一直被網站擋）
  if (!s.loggedIn && !s.error && a[site]?.seen && hasCred(site)) {
    if (await autoLogin(site)) {
      s = await checkAuth(site)
      if (s.loggedIn) s.autoLogin = true
    }
  }
  if (s.loggedIn && !a[site]?.seen) {
    a[site] = { ...a[site], seen: true }
    saveAccounts()
  }
  if (!s.loggedIn && !s.error && a[site]?.seen) s.expired = true
  s.remembered = hasCred(site)
  return s
}

// ---------- 記住密碼、自動重新登入（目前只有 jm 需要） ----------
// 密碼用 Windows 的 DPAPI（Electron safeStorage）加密後存在 accounts.json，只有這台電腦的這個 Windows 帳號解得開。
// 一定要使用者在登入後按「記住」才會存；登出或按「忘記密碼」就刪掉。

const CRED_SITES = ['jm']
/** 登入視窗剛拿到、還沒決定要不要記住的帳密（只放記憶體） */
const pendingCred = {}

const hasCred = (site) => !!loadAccounts()[site]?.cred

function readCred(site) {
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(loadAccounts()[site].cred, 'base64')))
  } catch {
    return null
  }
}

/** 登入視窗關掉時呼叫：已經記住過的直接更新（可能換了密碼），不然先放著等使用者決定 */
function offerCred(site, user, pass) {
  if (!CRED_SITES.includes(site) || !user || !pass || !safeStorage.isEncryptionAvailable()) return false
  if (hasCred(site)) {
    saveCred(site, { user, pass })
    return false
  }
  pendingCred[site] = { user, pass }
  return true
}

function saveCred(site, cred) {
  const a = loadAccounts()
  a[site] = { ...a[site], cred: safeStorage.encryptString(JSON.stringify(cred)).toString('base64') }
  saveAccounts()
}

/** 使用者回答要不要記住密碼；remember=false 也用來「忘記密碼」 */
function rememberCred(site, remember) {
  const a = loadAccounts()
  if (remember && pendingCred[site]) saveCred(site, pendingCred[site])
  if (!remember && a[site]?.cred) {
    delete a[site].cred
    saveAccounts()
  }
  delete pendingCred[site]
  return { ok: true, remembered: hasCred(site) }
}

const autoLoginState = {}
/** 用隱藏視窗打開登入頁，填好帳密、勾「記住我」、按登入，等網站登入成功 */
function autoLogin(site) {
  const st = (autoLoginState[site] ||= { busy: null, failedAt: 0 })
  if (st.busy) return st.busy
  if (Date.now() - st.failedAt < 5 * 60 * 1000) return Promise.resolve(false)
  const cred = readCred(site)
  if (!cred) return Promise.resolve(false)
  const log = (m) => require('./watchdog').log(`auto login ${site}: ${m}`)
  st.busy = (async () => {
    const w = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { partition: partition(site), contextIsolation: true, backgroundThrottling: false } })
    w.webContents.setAudioMuted(true)
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await w.loadURL(loginUrl(site)).catch(() => {})
      let ok = false
      for (let i = 0; i < 12 && !ok; i++) {
        // 頁面上有好幾個登入表單（兩個在隱藏的彈窗裡），填看得到的那一個；按鈕是 type="button"，由網站的程式送出
        const filled = await w.webContents
          .executeJavaScript(
            `(() => {
              const forms = [...document.querySelectorAll('form')].filter((f) => f.querySelector('input[type="password"]'))
              const f = forms.find((x) => x.querySelector('input[type="password"]').offsetParent !== null) || forms[0]
              if (!f) return false
              const u = f.querySelector('input[name="username"]'), p = f.querySelector('input[type="password"]')
              u.value = ${JSON.stringify(cred.user)}; p.value = ${JSON.stringify(cred.pass)}
              for (const el of [u, p]) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
              f.querySelectorAll('input[type="checkbox"]').forEach((c) => { if (/remember/i.test(c.name)) c.checked = true })
              const btn = f.querySelector('.login_submit, button[name="submit_login"], [type="submit"]')
              if (btn) btn.click(); else f.submit()
              return true
            })()`,
          )
          .catch(() => false)
        if (!filled) {
          // 可能還在 Cloudflare 驗證頁，等一下再試
          await sleep(2500)
          continue
        }
        for (let j = 0; j < 10 && !ok; j++) {
          await sleep(2000)
          ok = (await checkAuth(site).catch(() => ({}))).loggedIn
        }
        break
      }
      log(ok ? 'ok' : 'failed')
      if (!ok) st.failedAt = Date.now()
      return ok
    } finally {
      if (!w.isDestroyed()) w.destroy()
      st.busy = null
    }
  })()
  return st.busy
}

/** eh 站的帳號在論壇子網域 */
const forumUrl = (p) => base('eh').replace('://', '://forums.') + p

async function logout(site) {
  const ses = sesOf(site)
  if (site === 'nh') await ses.fetch(base('nh') + '/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  await ses.clearStorageData()
  // 自己登出的就不算「過期」，帳號名稱也一起清掉；只留下次登入要預先填的帳號
  const a = loadAccounts()
  const login = a[site]?.login
  delete a[site]
  if (login) a[site] = { login }
  saveAccounts()
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

module.exports = {
  init,
  get,
  bytes,
  config,
  setBase,
  label,
  base,
  partition,
  loginUrl,
  siteForUrl,
  authStatus,
  logout,
  jmReader,
  accountName,
  setAccountName,
  lastLogin,
  setLastLogin,
  offerCred,
  rememberCred,
  flushAllCookies,
}
