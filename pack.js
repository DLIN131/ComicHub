// 打包 Windows 版：node pack.js [輸出資料夾]
const { packager } = require('@electron/packager')
const path = require('path')
const fs = require('fs')

const out = process.argv[2] || 'dist'
const version = process.env.APP_VERSION || require('./package.json').version

packager({
  dir: __dirname,
  name: 'ComicHub',
  platform: 'win32',
  arch: 'x64',
  out,
  overwrite: true,
  asar: true,
  icon: path.join(__dirname, 'src', 'icon.ico'),
  appVersion: version,
  // 只排除專案根目錄的東西（路徑以 / 開頭、相對於專案資料夾）
  // downloads、backup 是開發時放在專案資料夾的漫畫和紀錄備份（見 paths.js），不能打包進去
  ignore: [/^\/dist($|\/)/, /^\/downloads($|\/)/, /^\/backup($|\/)/, /^\/pack\.js$/, /^\/\.gitignore$/, /^\/README\.md$/, /^\/project\.context\.md$/],
})
  .then(([appPath]) => {
    fs.writeFileSync(path.join(appPath, 'version.txt'), version)
    console.log(`打包完成：${appPath}（v${version}）`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
