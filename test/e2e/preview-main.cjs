// Electron main for preview-shot.ts: opens docs/tether-preview.html in a bare offscreen BrowserWindow
// (1280×800, the size app.chrome uses), once per scheme (html[data-theme]), and writes a half-size
// preview-{light,dark}.png into the output directory given as the last argument.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const out = resolve(process.argv[process.argv.length - 1])
const page = join(__dirname, '..', '..', 'docs', 'tether-preview.html')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, webPreferences: { offscreen: true } })
  await win.loadFile(page)
  for (const scheme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(scheme)}`)
    await new Promise(r => setTimeout(r, 400))
    const img = await win.webContents.capturePage()
    writeFileSync(join(out, `preview-${scheme}.png`), img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG())
  }
  app.exit(0)
}).catch(err => { console.error(err); app.exit(1) })
