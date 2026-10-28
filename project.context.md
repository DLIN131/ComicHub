# ComicHub 專案脈絡（project.context.md）

這份文件記錄 ComicHub 的架構、資料放在哪、開發與發布的規則，以及**每一次改動的技術細節和修了什麼**。
每次改程式都要在最下面的「改版紀錄」補一筆（版本號 = 發布後的 v1.0.N）。

> 這個 repo 是公開的：文件、程式碼、commit 訊息裡**不能出現來源網站的名稱或網域**，
> 一律用代號 **NH / JM / WN / EH**（程式裡是 `nh` / `jm` / `wn` / `eh`）。
> 提交前用 `git grep -i` 檢查（關鍵字清單見下方「提交前檢查」）。

---

## 1. 概要

- Windows 桌面程式，Electron 33（本機 Node 18；CI 用 Node 20）。
- 整合四個漫畫站：瀏覽、搜尋、閱讀、下載成 CBZ、離線書櫃、各站登入與收藏。
- 發布：推到 `main` → GitHub Actions 打包 → Release `v1.0.<run_number>`，附 `ComicHub-Windows.zip`。
  固定下載網址：`https://github.com/DLIN131/ComicHub/releases/latest/download/ComicHub-Windows.zip`
- 程式內更新：右下角提示 → 下載 zip → 解壓 → PowerShell 腳本等程式關掉後覆蓋 → 重開。

## 2. 檔案結構

### 主程序（Node / Electron main）

| 檔案 | 內容 |
|---|---|
| `main.js` | 主視窗、IPC、圖片 Referer、登入視窗（各站自己的登入頁）、單一執行鎖、啟動前清快取 |
| `fetcher.js` | 各站網路請求。每站一個 partition（`persist:nh` 等，cookie 互不干擾）；Cloudflare 驗證頁改用隱藏視窗載入；站名 / 網址以 **Base64** 存；登入狀態判斷、保持登入、帳號名稱（`accounts.json`）、JM 記住密碼自動重新登入 |
| `downloads.js` | 下載資料夾設定、CBZ（STORE zip）寫入器、`ComicInfo.xml` |
| `library.js` | 書櫃：讀 CBZ/ZIP（STORE + DEFLATE，不支援 ZIP64），`cbz://book/<id>/<index>` 自訂協定提供圖片，`library.json` 記住用過的資料夾和外部檔案 |
| `state.js` | 程式資料存檔 `state.json`（主程序寫檔，原子寫入 + `.bak`），備份到程式資料夾 `backup/` |
| `paths.js` | 資料預設位置：程式資料夾（打包版 = `ComicHub.exe` 所在；開發 = 專案資料夾），不能寫入時退回 userData |
| `backup.js` | 書櫃備份 / 還原（匯出 JSON、從 JSON 或自動備份還原、加入漫畫資料夾） |
| `updater.js` | 程式內更新（下載、解壓、`update.ps1` 覆蓋） |
| `watchdog.js` | 啟動自我檢查 / 自動修復 / `startup.log` |
| `preload.js` | `window.hub`（給頁面用的 IPC 介面）、`window.updater` |
| `pack.js` | 本機打包 Windows 版（`npm run pack` → `dist/ComicHub-win32-x64`） |

### 頁面（renderer，`src/`）

| 檔案 | 內容 |
|---|---|
| `index.html` | 外框、CSP（`img-src * data: blob: cbz:`、`connect-src https://api.github.com`） |
| `app.js` | 全部畫面：首頁、搜尋、作品頁、閱讀器、收藏、紀錄、書櫃、合集、下載頁、帳號頁、更新紀錄、啟動流程 |
| `sites.js` | 四站轉接層，轉成統一格式：列表項目 `{site,id,title,cover,sub,lang}`、作品 `{…tags, chapters, pages}`、閱讀頁 `[{url, segs}]` |
| `downloader.js` | 下載佇列（一次一本、每本 4 張並行，依頁碼順序寫入），JM 打亂的圖先重組 |
| `store.js` | 頁面讀寫資料（透過 `window.hub.state`，第一次會把舊 localStorage 搬過來） |
| `version.js` | `window.APP_VERSION`（CI 寫入 run_number，本機 0 = 開發版） |
| `style.css` | 樣式 |

## 3. 各站要點

- **NH**：官方 v2 API。登入 token 在 cookie `access_token`，過期用 `POST /auth/refresh` 換。語言篩選用 `language:xxx`（標籤 id：中 29963、英 12227、日 6346）。
- **JM**：網頁 HTML（有 Cloudflare，Electron 隱藏視窗可過）。閱讀頁圖片被切條打亂（`scramble_id` 220980，依 md5 算段數）→ canvas 重組；下載時用 OffscreenCanvas 重組後存 JPEG。
  - **同一個帳號同時只能在一個地方登入**：在瀏覽器 / 手機登入（或登出）會把程式這邊踢掉。
  - 登入狀態判斷：`GET /user/`，沒登入會被導到 `/login`。收藏網址要帳號名稱：登入視窗記下使用者在**看得到的**帳號欄打的字（頁面上有 3 個帳號欄，2 個在隱藏彈窗）。
  - **登入記在網站伺服器上，一陣子沒用就失效**（電腦關機 / 重開機後一定過期，cookie 還在也沒用）。程式開著每 10 分鐘碰一下保持登入；使用者登入後同意「記住密碼」的話，密碼用 `safeStorage`（Windows DPAPI）加密存在 `accounts.json` 的 `cred`，登入失效時用隱藏視窗打開登入頁、填看得到的那個表單、按 `.login_submit`（type=button，由網站的 JS 送出）自動重新登入；失敗後 5 分鐘內不再試。登入表單欄位：`username`、`password`、`id_remember`、按鈕 `submit_login`。
  - 登入頁一開就有整頁廣告，用 `insertCSS` 藏起來；預設勾「記住我」；程式開著每 10 分鐘碰一下保持登入。
- **WN**：一般 HTML。不存在的編號也回 200 → 沒有封面就當找不到。分類編號對應語言（中 1,9,10,20／日 12,13,14／英 16,17,18）。
- **EH**：作品編號是 `gid_token`（只能用網址查）。列表翻頁用 `next=` 游標。閱讀頁要再開每一頁拿圖片網址（`resolve(retry)`，重試帶 `nl=` 換伺服器）。登入在論壇子網域，會先出 Cloudflare 驗證。

## 4. 資料放在哪

| 位置 | 檔案 | 內容 |
|---|---|---|
| `%APPDATA%\ComicHub` | `state.json`、`state.json.bak` | 閱讀進度、紀錄、分組、合集、設定、下載紀錄、更新紀錄快取 |
| | `accounts.json` | 各站帳號名稱、上次登入的帳號、是否登入過；JM 使用者同意時的加密密碼 `cred`（DPAPI，只有這台電腦這個 Windows 帳號解得開；登出或「忘記密碼」就刪） |
| | `library.json` | 書櫃記得的資料夾、外部加入的檔案 |
| | `sites.json` | 使用者改過的網站網址 |
| | `downloads.json` | 使用者自選的下載資料夾（沒有 = 預設） |
| | `safe-mode.json`、`recovery.json`、`starting.flag`、`repair.flag` | 自動修復用 |
| | `startup.log`、`update.log` | 問題紀錄（本地時間） |
| | `Partitions\<站>\Network` | 各站登入 cookie（加密金鑰在 `Local State`） |
| 程式資料夾（`ComicHub.exe` 旁） | `backup\ComicHub 紀錄備份.json` | `state.json` 的備份（最多每分鐘寫一次 + 關程式時），AppData 被刪時自動還原 |
| | `backup\ComicHub 還原前的資料 <時間>.json` | 「從備份檔還原」前自動另存的目前資料（匯出格式，可以再還原回來） |
| | `downloads\` | 下載的漫畫預設位置 |

- 程式資料夾不能寫入（例如 Program Files）→ 這兩個改放 `%APPDATA%\ComicHub`。
- **預設位置一律以程式相關的資料夾為主，不要放到「下載」這種無關的地方**（使用者要求）。
- 開發時 `backup/`、`downloads/` 會出現在專案資料夾：已加進 `.gitignore`，`pack.js` 也排除不打包。

## 5. 開發、測試、發布

- 開發：`npm install`、`npm start`（F12 開發者工具、F11 全螢幕）。
- 測試方式：在 scratchpad 寫 Electron 腳本 `require('…/main.js')`，用 `app.setPath('userData', 測試資料夾)` **和** `app.setPath('downloads', 測試資料夾)`（不然會讀寫到使用者真的資料），透過 `window.__app` / `window.hub` 操作畫面、截圖檢查。
  - 測試視窗被蓋住時不會繪圖：呼叫 `webContents.setBackgroundThrottling(false)`。
  - 不要在使用者電腦上啟動打包版的測試副本（使用者拒絕過），用開發版測。
  - **改了啟動流程或資料格式，一定要測「已有資料（含下載紀錄）的狀態下重開」**（v1.0.19 的黑畫面就是漏了這個）。
- 發布：commit 訊息 = 更新說明（繁體中文、給使用者看的條列；結尾 `Co-Authored-By` 行），推到 `main` 會自動發布；`*.md` 的改動不觸發發布。
- 更新使用者的 `dist\ComicHub-win32-x64`：下載 release zip → 等 ComicHub 完全關閉 → `robocopy /MIR` 時**一定要 `/XD "<dist>\backup" "<dist>\downloads"`**（不然會刪掉使用者資料）→ 原本開著就重開。

### 提交前檢查

```
git grep -i -E "<四個站的英文名、網域、中文站名>" -- . ':!package-lock.json'
```

結果必須是空的（站名清單不寫在這份公開文件裡）。

## 6. 自動修復（watchdog.js）流程

頁面載好會送 `app:ready`。沒收到就依序：

1. 20 秒沒好 / 載入失敗 / 畫面程序當掉 → 重新載入一次
2. 還是不行 → 寫 `safe-mode.json`，關掉顯示卡加速重開
3. 還是不行 → 把 `state.json` 和備份改名成 `*.停用-<時間>.json`（**不刪**），用空白資料重開，畫面上方說明
4. 還是不行 → 顯示說明頁（附重新下載網址）

另外：每次啟動放 `starting.flag`，載好才拿掉；下次啟動還在 → 清掉 userData 裡 Chromium 的資料（保留 ComicHub 的檔案、`Local State`、各站 `Network`）。帳號頁「修復程式」= 手動觸發同樣的清理。
畫面上的錯誤用 `console-message`（level ≥ 3）記到 `startup.log`（preload 在隔離環境收不到頁面錯誤）。

---

## 7. 改版紀錄

格式：版本（日期）— 做了什麼／修了什麼；技術細節。

### v1.0.1（2026-10-24）第一版
- 三站（NH / JM / WN）首頁、搜尋（三站交錯、標示來源）、作品頁、直式閱讀器、編號搜尋、語言篩選（中／英／日）、下載 CBZ、各站登入與收藏、程式內更新。
- 站名 / 網域 Base64 存在 `fetcher.js`；CI 發布流程建立。

### v1.0.2 書櫃（離線閱讀）
- `library.js` 讀 CBZ/ZIP、`cbz://` 協定；連不上網站時首頁提示到書櫃。

### v1.0.3 閱讀器方向鍵換頁
- `turnPage()`：比畫面高的頁先捲完再換頁。

### v1.0.4 第四個來源 EH、書櫃管理視窗、用此漫畫搜尋
- EH 轉接層（游標翻頁、逐頁解析圖片網址）。
- 書櫃管理視窗（閱讀、分組、作者搜尋、刪除移到資源回收筒）；作品頁「用此漫畫搜尋」（`cleanTitle` / `parseAuthors`）。
- 修：下載檔名加作品編號、標題太長只截標題，避免不同作品 / 不同話撞名互相覆蓋（使用者回報「書櫃舊漫畫消失」，推測原因）。

### v1.0.5 修正程式內更新第二次以後失敗
- 原因：Electron 的 `fs` 把解壓出來的 `app.asar` 當資料夾，刪不掉（ENOTEMPTY）還鎖著。改用 `original-fs`、每次用新的暫存資料夾。

### v1.0.6 修正分組名稱、搜尋框打不了字
- 原因：`onkeydown = (e) => e.key === 'Enter' && …` 對其他鍵回傳 false = 取消按鍵。改成區塊寫法。

### v1.0.7 修正更新時找不到更新檔
- 原因：啟動 3 秒後的暫存清理把正在下載的 `update.zip` 刪掉。清理跳過正在用的 / 10 分鐘內的資料夾；加單一執行鎖；PowerShell 錯誤訊息改 UTF-8（不然變亂碼）。

### v1.0.8 書櫃記住漫畫、JM 登入
- `library.json` 記住用過的資料夾和外部加入的檔案（以前只在記憶體，重開就不見）。
- JM 登入頁廣告藏起來、登入判斷改用 `/user/`、登入成功自動關登入視窗。

### v1.0.9 JM 帳號名稱
- 登入時記下使用者輸入的帳號；帳號頁可以手動填。

### v1.0.10 重開被登出、JM 收藏空白
- 工作階段 cookie 在關程式時會被丟掉 → 各站自己網域的工作階段 cookie 改成 30 天。
- 拿掉「猜帳號名稱」（可能猜到別人 → 收藏是空的）。

### v1.0.11 顯示版本、JM 預設勾「記住我」、登入過期提示

### v1.0.12 JM 程式開著時每 10 分鐘保持登入

### v1.0.13 JM 被登出的說明
- 實測：JM 同帳號只能一處登入，瀏覽器登入後約 1 分鐘程式這邊就被登出。顯示說明、重新登入先填好帳號。

### v1.0.14 修正 JM 登入沒記下帳號
- 原因：讀到隱藏彈窗裡的帳號欄。改讀看得到的那一欄（`offsetParent !== null`）。

### v1.0.15 閱讀進度、不再吃磁碟
- 記住每本看到第幾話第幾頁（`progress`）；作品頁 / 書櫃「繼續閱讀」；繼續閱讀時「釘住」那一頁（上面的圖載入會把畫面推走）。
- `disable-http-cache` 關掉磁碟快取；舊快取啟動時清掉（userData 從 174 MB → 3 MB）。

### v1.0.16 修正舊快取沒清乾淨
- 清快取要在 app ready **之前**做（之後檔案被 Chromium 開著刪不掉）。

### v1.0.17 也清各站的 GPU 快取

### v1.0.18 修正關掉重開後進度、紀錄不見
- 原因：Chromium localStorage 在快速關掉重開時把上一次的資料丟掉（LevelDB `Delete type=0 #3`）。改成主程序自己寫 `state.json`（同步讀、非同步寫、300ms 合併、暫存檔改名 + `.bak`）。

### v1.0.19 下載頁顯示資料夾裡的漫畫、保留失敗紀錄
- 失敗的下載也存起來；下載完成 / 失敗提示；視窗窄時搜尋列換行。
- ⚠️ 這一版在 `downloader.js` 引入了 `KEEP` 先用後宣告的錯誤（見 v1.0.26）。

### v1.0.20 更新紀錄
- 點版本號 / 帳號頁「更新紀錄」看各版內容（讀 GitHub Releases，離線用快取）；更新後自動顯示。

### v1.0.21 閱讀時 ↑ ↓ 改成像滑鼠滾輪平滑捲動（← → 還是整頁換頁）

### v1.0.22 黑畫面處理（第一輪）
- 「更新內容」視窗不再一開程式就蓋黑幕等 GitHub（連不到時像黑畫面）。
- 加 `watchdog.js`：沒載好 → 重載 → 關顯示卡加速 → 說明頁；畫面擷取全黑也當黑畫面。
- 更新腳本等安裝資料夾所有程序結束才覆蓋、確認 `app.asar` 雜湊。

### v1.0.23 黑畫面自動修復、紀錄另外備份
- 上次沒成功開起來 → 下次啟動清 Chromium 資料（保留紀錄和登入）；帳號頁「修復程式」。
- 觀看紀錄備份到下載資料夾（v1.0.27 改到程式資料夾）。

### v1.0.24 書櫃合集
- 幾本串成一本連續看（不另外產生檔案）；閱讀時上方選單跳到每本第一頁；加入漫畫、拖曳 / ↑↓ 排序、選封面、改名、分組、解散。資料：`collections`；進度 key `col_<id>`。
- 修：從目錄跳頁後進度沒存（釘住頁面時的存檔判斷改用被釘住那頁的頁碼）。

### v1.0.25 黑畫面處理加強、log 用本地時間
- 啟動每一步各自 try/catch，不會整個卡住；`startup.log` 改本地時間並記下畫面上的實際錯誤（`console-message`）。
- 修復多一層：把資料改名放一旁（不刪）用空白資料開；自動清理不會刪掉放一旁的檔案。

### v1.0.26 修正有下載紀錄時開啟黑畫面（真正原因）
- 原因：v1.0.19 起 `downloader.js` 在宣告 `const KEEP` 之前就呼叫 `loadDone()` 用到它（TDZ）→ 只要有任何下載紀錄，頁面程式一載入就 `ReferenceError` → 黑畫面。刪 AppData 會好只是因為下載紀錄被刪了。
- 修：`KEEP` 移到前面、讀紀錄加 try/catch；用使用者的資料重現並確認舊版會壞、新版正常。
- 教訓：前面幾版懷疑顯示卡 / 快取 / 資料都不是主因；有了實際錯誤紀錄（v1.0.25）才找到。

### v1.0.27 資料預設改放程式資料夾
- 新增 `paths.js`。觀看紀錄備份改到程式資料夾 `backup\`（舊的在「下載」的會搬過來後刪掉）；新安裝的下載預設 `downloads\`；舊使用者「下載\ComicHub」已有漫畫的繼續用（不自動搬檔案）。
- `pack.js`、`.gitignore` 排除 `downloads/`、`backup/`。
- （使用者電腦另外手動處理：把「下載\ComicHub」的漫畫搬到 dist 的 `downloads\`，下載位置改回預設。）

### v1.0.28（2026-10-28）合集裡的書可以搜尋、標籤搜所有站、JM 重開機自動登入、書櫃備份 / 還原
- **合集裡的書找不到、不能用此漫畫搜尋**：書加進合集後不再單獨顯示，書櫃搜尋只列出合集，點不到那本書的管理視窗（用此漫畫搜尋、作者搜尋）。
  - 書櫃有搜尋字時，合集裡符合的書也單獨列出（卡片右下標「合集：名稱」）。
  - 合集視窗每本多一個「搜尋 / 管理」按鈕，開那本的管理視窗；視窗底下加「用此合集搜尋」（合集名、每本書名、作者）。
- **點標籤只搜原本那一站**：`renderDetail` 的標籤原本是 `pages.search(t.query, [d.site])`。改成搜所有勾選的站：`pages.search` 加 `siteQuery` 選項，原本的站用自己的標籤語法（NH `tag:"…"`、EH `f:"…$"`），其他站用標籤名當關鍵字（`tagWord` 去掉 EH 的 `f:` / `m:` 前綴）。
- **JM 電腦重開機後要重新登入**：查了使用者的 cookie 資料庫，登入 cookie `AVS` 已經存成 30 天（v1.0.10 的處理有效）。真正原因：JM 的登入記在伺服器上，一陣子沒用就失效，電腦關一晚 cookie 還在也沒用（網站沒有給「記住我」的長效 cookie）。
  - 登入成功後問使用者要不要「記住密碼」，同意才用 `safeStorage` 加密存（`fetcher.offerCred / rememberCred`）。登入視窗輪詢時一併讀看得到那個表單的密碼欄，只放記憶體，等使用者回答。已經記住過的，重新登入時直接更新。
  - `authStatus` 發現過期又有記住密碼 → `autoLogin`：隱藏視窗填表、按登入，每 2 秒檢查一次，最多 20 秒。同時只跑一個；失敗後 5 分鐘內不再試；結果記到 startup.log（不記密碼）。開程式 4 秒後的檢查和每 10 分鐘的保持登入都走這裡，所以重開機後一開程式就自動登入。
  - 帳號頁顯示「已記住密碼」和「忘記密碼」；登出也會刪掉。
  - 另外：cookie 變動 2 秒後 `flushStore()`；主視窗 `session-end`（Windows 關機 / 登出）時寫 `state.json` 和各站 cookie。
  - 測試用本機假網站：`sites.json` 把 JM 網址指到 127.0.0.1，假網站有三個登入表單（兩個隱藏），按鈕 type=button 用 fetch 送出，伺服器端 session 可以清掉。測了登入 → 記住 → 過期自動重登 → 密碼錯不重複試 → 重開程式自動登入 → 忘記密碼。**沒有用真的帳號測過**。
- **書櫃備份 / 還原**（新增 `backup.js`，書櫃頁「備份 / 還原」）：
  - 匯出格式：`{ app, kind: 'comichub-backup', format: 1, exportedAt, host, state, library: { dirs, files }, downloadDir }`，預設存到程式資料夾 `backup\`。不含漫畫檔，CBZ 要另外複製。
  - 還原也吃程式自動備份的「ComicHub 紀錄備份.json」（整份就是 state）。流程：
    1. 目前資料另存「還原前的資料 <時間>.json」
    2. `state.replaceAll` 換成備份內容
    3. 書櫃記得的資料夾 / 檔案，這台電腦有的才加回去
    4. 備份裡的下載資料夾存在就沿用
    5. 頁面 `location.reload()` 讀新資料
  - 合集、分組、進度都用檔名對應，漫畫換資料夾也對得起來。
  - 「加入漫畫資料夾」：重灌後漫畫放在別處時，把資料夾加進書櫃（`library.remember('dirs')`）。
