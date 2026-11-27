// Captures of the bench page (a `--bench` build of the remote web client): Electron used as a plain browser, one hidden
// off-screen window per shot at the size asked, the page served from this process over http on localhost (the page's CSP
// needs a real origin: 'self' means nothing on file://). One run, then it exits; nothing is left listening.
//   CAPTURE_DIR      the built folder (app.css, bench.html, bench.js)
//   CAPTURE_OUT      where the PNGs go
//   CAPTURE_PROFILE  Electron's user data folder (a throwaway one)
//   CAPTURE_SHOTS    JSON: [{ "name": "390", "width": 390, "height": 844, "hash": "tema=escuro" }, ...]
// The page says it settled with `data-ready` on <html> (bench/page/regency-bench.ts).
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { join } = require('node:path')

const dir = process.env.CAPTURE_DIR
const out = process.env.CAPTURE_OUT
const profile = process.env.CAPTURE_PROFILE
let shots
try { shots = JSON.parse(process.env.CAPTURE_SHOTS ?? '') } catch { shots = undefined }
if (!dir || !out || !profile || !Array.isArray(shots)) { console.error('CAPTURE_DIR, CAPTURE_OUT, CAPTURE_PROFILE and CAPTURE_SHOTS are required'); process.exit(2) }
app.setPath('userData', profile)

const FILES = {
  '/bench.html': ['bench.html', 'text/html; charset=utf-8'],
  '/bench.js': ['bench.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
}

const server = createServer((req, res) => {
  const f = FILES[new URL(req.url ?? '/', 'http://localhost').pathname]
  if (!f) { res.writeHead(404); res.end(); return }
  let body
  try { body = readFileSync(join(dir, f[0])) } catch { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
})

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

async function shoot(base, shot) {
  const win = new BrowserWindow({
    width: shot.width, height: shot.height, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  const problems = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) problems.push(message) })
  // A window cannot be wider than the screen it is on: a wider shot (the TV's 2560) is the page zoomed out to the width the
  // window got, so the page lays itself out at the CSS width asked and the picture is that view, smaller.
  const [gotWidth] = win.getContentSize()
  const zoom = gotWidth < shot.width ? gotWidth / shot.width : 1
  if (zoom < 1) win.setContentSize(gotWidth, Math.round(shot.height * zoom))
  try {
    await win.loadURL(`${base}/bench.html#${shot.hash ?? ''}`)
    // The zoom is kept per origin: every shot sets its own.
    win.webContents.setZoomFactor(zoom)
    if (zoom < 1) await wait(600)
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await win.webContents.executeJavaScript('document.documentElement.dataset.ready === "1"').catch(() => false)
      if (!ready) await wait(100)
    }
    // A frame or two after the last change, so the off-screen surface holds what the page shows.
    await wait(400)
    const facts = await win.webContents.executeJavaScript(`(() => {
      const rr = document.querySelector('.rr'), rg = document.querySelector('.rg')
      return { link: rr?.dataset.link, tier: rr?.dataset.tier, pane: rg?.dataset.tier, width: innerWidth, icons: document.querySelectorAll('svg.ph').length,
        emptyIcons: [...document.querySelectorAll('svg.ph')].filter(s => !s.firstElementChild).length, scrollX: document.documentElement.scrollWidth > innerWidth }
    })()`).catch((e) => ({ error: String(e) }))
    const image = await win.webContents.capturePage()
    writeFileSync(join(out, `${shot.name}.png`), image.toPNG())
    console.log(JSON.stringify({ shot: shot.name, ready, ...(zoom < 1 ? { zoom: Number(zoom.toFixed(3)) } : {}), ...facts, problems }))
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true })
  await new Promise((done) => server.listen(0, 'localhost', done))
  const base = `http://localhost:${server.address().port}`
  for (const shot of shots) await shoot(base, shot)
  server.close()
  app.exit(0)
}).catch((err) => { console.error(err); server.close(); app.exit(1) })

app.on('window-all-closed', () => {})
