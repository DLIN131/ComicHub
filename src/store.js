// 頁面用的小資料庫：讀寫都走主程序的 state.json（見 state.js）。
// 第一次用新版時，把舊版存在 localStorage 的資料搬過去。
const cache = (() => {
  try {
    return window.hub.state.all() || {}
  } catch {
    return {}
  }
})()

if (!cache._migrated) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k in cache) continue
      try {
        const v = JSON.parse(localStorage.getItem(k))
        cache[k] = v
        window.hub.state.set(k, v)
      } catch {}
    }
  } catch {}
  cache._migrated = true
  window.hub.state.set('_migrated', true)
}

export const store = {
  get(k, d) {
    return cache[k] ?? d
  },
  set(k, v) {
    cache[k] = v
    window.hub.state.set(k, v)
  },
}
