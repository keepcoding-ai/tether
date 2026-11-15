// The tabs' files (Tether Browser E13, design §2.3, §4.3, §12a, review M1), against the real gate of the app built with
// TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe, real tetherd, loopback only). The agent is the vendored
// `tether-browser` MCP server keyed as an inert "soul" slot. Two local sites: the page (localhost) and, inside it, a frame of
// another origin (127.0.0.1) that owns the file field and receives what it gets.
//   1. a download lands in `<home>/browser/downloads/<slot>/` under a safe name that never overwrites (the second one gets `-1`),
//      the agent's WebDownload lists it by that name (the package marks it failed in adopt mode: see the report), and the pad
//      lists it under "Baixados" with "Mostrar na pasta" (in a test build it records the path instead of opening a window);
//   2. a download over the 50 MB ceiling is cancelled and nothing is left in the folder;
//   3. WebUpload into the frame of the other origin shows the tether's dialog naming the agent, the file, its folder and "O campo é
//      de ‹frame›, dentro de ‹página›", with the page's picture; "Não permitir" fails WebUpload with UPLOAD_NOT_ALLOWED and the
//      site gets nothing; "Permitir" attaches and the site gets the file;
//   4. the person takes the tab while a question waits: the dialog goes, WebUpload is refused;
//   5. the gate refuses the package's attach shape without a consent (a raw client with the same key).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, launchHidden, rawCdp, root, serverMjs, sleep, inBrowser } from './browser-kit.ts'

declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    slots(): SlotState[]
    openSlot(id: string): Promise<void>
    browserPadOpen(): void
    browserPad(): { downloads: { slotId: string; agent: string; files: { name: string; meta: string }[] }[] } | undefined
    browserShowDownload(name: string): boolean
  }
  tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> }
}
type Tabs = {
  control: { take(id: string): void; giveBack(id: string): Promise<void>; control(id: string): string }
  gate(): Promise<{ port: number } | null>
  registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] }
  downloadsDir(): string
  shownInFolder: string[]
  openUploads(): { tabId: string }[]
}

const pipe = `\\\\.\\pipe\\tether-brfiles-${process.pid}`
const FAKE_SOUL = `"${process.execPath}" -e "setInterval(()=>{},1000)"`
const html = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,">${body}`
const BIG = 51 * 1024 * 1024

function listen(server: Server, host: string): Promise<number> {
  return new Promise(r => server.listen(0, host, () => r((server.address() as AddressInfo).port)))
}

/** The frame's site (127.0.0.1): the file field, and what it receives. */
async function frameSite(): Promise<{ server: Server; origin: string; uploads: string[] }> {
  const uploads: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/upload') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => { uploads.push(body); res.writeHead(200).end('ok') })
      return
    }
    if (url.pathname === '/form.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html('Form', `<input type="file" id="f" aria-label="Arquivo do site"><script>
        document.getElementById('f').addEventListener('change', e => { const file = e.target.files[0]; if (file) fetch('/upload', { method: 'POST', body: file }) })
      </script>`))
    }
    res.writeHead(404).end()
  })
  const port = await listen(server, '127.0.0.1')
  return { server, origin: `http://127.0.0.1:${port}`, uploads }
}

/** The page's site (localhost): the frame of the other site, two downloads and a big one. */
async function pageSite(frameOrigin: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html('Página', `<p>Página do site</p><a href="/dl/report">Baixar relatório</a> <a href="/dl/big">Baixar grande</a> <a href="/dl/rlo">Baixar fatura</a> <a href="/dl/url">Baixar atalho</a>
        <iframe src="${frameOrigin}/form.html" width="400" height="120"></iframe>`))
    }
    if (url.pathname === '/dl/report') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' })
      return res.end('the report')
    }
    if (url.pathname === '/dl/rlo') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="fatura.bin"; filename*=UTF-8''${encodeURIComponent('fatura\u202Efdp.exe')}` })
      return res.end('MZ not really')
    }
    if (url.pathname === '/dl/url') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="atalho.url"' })
      return res.end('[InternetShortcut]\r\nURL=https://example.invalid/\r\nIconFile=\\\\192.0.2.1\\share\\x.ico\r\n')
    }
    if (url.pathname === '/dl/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': String(BIG) })
      const chunk = Buffer.alloc(1024 * 1024)
      let sent = 0
      const pump = (): void => {
        while (sent < BIG) {
          sent += chunk.length
          if (!res.write(chunk)) { res.once('drain', pump); return }
        }
        res.end()
      }
      res.on('error', () => {})
      req.socket.on('error', () => {})
      return pump()
    }
    res.writeHead(404).end()
  })
  const port = await listen(server, '127.0.0.1')
  return { server, origin: `http://localhost:${port}` }
}

function mcp(endpointFile: string, keyFile: string, uploadDir: string): { child: ChildProcessWithoutNullStreams; tool(name: string, args?: object, ms?: number): Promise<{ text: string; isError: boolean }> } {
  const env = cleanEnv()
  env.ELECTRON_RUN_AS_NODE = '1'
  env.ATRIUM_BROWSER_UPLOAD_DIRS = uploadDir
  const child = spawn(electronPath, [serverMjs, '--adopt-endpoint-file', endpointFile, '--adopt-key-file', keyFile], { env, stdio: 'pipe', windowsHide: true })
  const pending = new Map<number, (m: any) => void>()
  let buf = ''
  let next = 10
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { const m = JSON.parse(line); if (m.id !== undefined) pending.get(m.id)?.(m) } catch { /* not ours */ }
    }
  })
  child.stderr.on('data', () => {})
  const rpc = (method: string, params: object): Promise<any> => new Promise(r => {
    const id = ++next
    pending.set(id, r)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'files-e2e', version: '1' } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
  return {
    child,
    tool: async (name, args = {}, ms = 30_000) => {
      await ready
      const m = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(ms).then(() => ({ error: { message: `${name}: no answer` } }))])
      if (m.error) return { text: String(m.error.message), isError: true }
      const text = (m.result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return { text, isError: m.result.isError === true }
    },
  }
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

test('browser files: downloads by agent with "Baixados", the ceiling, the upload consent naming the frame, take cancels', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const frame = await frameSite()
  const site = await pageSite(frame.origin)
  const soulBefore = process.env.TETHER_SOUL_CMD
  process.env.TETHER_SOUL_CMD = FAKE_SOUL
  const home = mkdtempSync(join(tmpdir(), 'tether-brfiles-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'allow' } } }))
  const keysDir = join(home, 'browser', 'keys')
  mkdirSync(keysDir, { recursive: true })
  const uploadDir = join(home, 'to-send')
  mkdirSync(uploadDir)
  const sendFile = join(uploadDir, 'nota.txt')
  writeFileSync(sendFile, 'CONTEUDO-DA-NOTA-42')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let server: ReturnType<typeof mcp> | undefined
  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const B = <R>(fn: (t: Tabs, a: any) => R | Promise<R>, a?: unknown): Promise<R> =>
      inBrowser(T, new Function('_e', 'a', `return (${fn.toString()})(globalThis.__browserTabs, a)`) as never, a) as Promise<R>
    const slot = await win.evaluate(async dir => {
      const r = await window.tether.request({ t: 'create', kind: 'soul', cwd: dir, name: 'Sonda', start: true })
      await window.__tether.openSlot(r.slot!.slotId)
      return r.slot!.slotId
    }, root)
    await win.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running'), slot, { timeout: 20_000 })
    const KEY = 'filesFILESfilesFILESfilesFILES123456'
    writeFileSync(join(keysDir, `${slot}.key`), KEY)
    server = mcp(join(home, 'browser', 'endpoint.json'), join(keysDir, `${slot}.key`), uploadDir)
    const tool = server.tool
    const refOf = (tree: string, pattern: string): string => new RegExp(`${pattern}[^\\n]*\\[ref=(\\w+)\\]`).exec(tree)?.[1] ?? 'missing'

    const nav = await tool('WebNavigate', { url: `${site.origin}/page.html` })
    assert.equal(nav.isError, false, nav.text)
    const tabId = (await B(t => t.registry.list()))[0]!.tabId
    let tree = await until('the frame in the snapshot', async () => { const r = await tool('WebSnapshot'); return /Arquivo do site/.test(r.text) && r.text })

    // ---- 1. downloads land in the agent's folder, safe and never overwritten ----
    const folder = join(await B(t => t.downloadsDir()), slot)
    assert.equal((await tool('WebClick', { ref: refOf(tree, 'link "Baixar relatório"') })).isError, false)
    await until('first download saved', async () => existsSync(join(folder, 'report.txt')))
    tree = (await tool('WebSnapshot')).text
    assert.equal((await tool('WebClick', { ref: refOf(tree, 'link "Baixar relatório"') })).isError, false)
    await until('second download saved with a suffix', async () => existsSync(join(folder, 'report-1.txt')))
    assert.equal(readFileSync(join(folder, 'report.txt'), 'utf8'), 'the report')
    const listed = await until('WebDownload lists it by the final name', async () => { const r = await tool('WebDownload'); return /report-1\.txt[^}]*"status": "saved"/.test(r.text) && r.text })
    console.log(`WebDownload: ${listed.replace(/\s+/g, ' ').slice(0, 400)}`)
    // The gate tells the package's browser session too, so the package reads the state and the size.
    assert.match(listed, /saved/i, listed)
    assert.equal((listed.match(/"bytes": 10\b/g) ?? []).length, 2, listed)
    await win.evaluate(() => window.__tether.browserPadOpen())
    const pad = await until('"Baixados" in the pad', async () => { const p = await win.evaluate(() => window.__tether.browserPad()); return p && p.downloads.length > 0 && p.downloads[0]!.files.length === 2 && p })
    assert.equal(pad.downloads[0]!.slotId, slot)
    assert.equal(pad.downloads[0]!.agent, 'Sonda')
    assert.deepEqual(pad.downloads[0]!.files.map(f => f.name).sort(), ['report-1.txt', 'report.txt'])
    assert.match(pad.downloads[0]!.files[0]!.meta, /^10 B · agora$/)
    assert.equal(await win.evaluate(() => window.__tether.browserShowDownload('report.txt')), true)
    const shown = await until('"Mostrar na pasta"', async () => { const s = await B(t => t.shownInFolder); return s.length > 0 && s })
    assert.deepEqual(shown, [join(folder, 'report.txt')], 'the folder is shown on the file; the file is not opened')
    // The Mark of the Web (review N-M1): the Internet zone and the origin only, whoever wrote it (the log says which).
    const motw = readFileSync(join(folder, 'report.txt') + ':Zone.Identifier', 'utf8')
    console.log(`Zone.Identifier: ${JSON.stringify(motw)}; log: ${(readFileSync(join(home, 'tether-app.log'), 'utf8').match(/download concluído[^\n]*/g) ?? []).join(' | ')}`)
    assert.match(motw, /\[ZoneTransfer\]\r?\nZoneId=3/)
    assert.ok(!motw.includes('/dl/'), 'only the origin, never the path')

    // ---- 1b. a name with a bidi control and a shortcut arrive inert (review N-M1). Chromium already turns the RLO into `_`
    //      before the tether sees the name, and turns `.url` into `.download`; safeDownloadName does both when a name gets through
    //      (the unit test). ----
    for (const [link, file] of [['Baixar fatura', 'fatura_fdp.exe.download'], ['Baixar atalho', 'atalho.download']] as const) {
      tree = (await tool('WebSnapshot')).text
      assert.equal((await tool('WebClick', { ref: refOf(tree, `link "${link}"`) })).isError, false)
      await until(`${file} saved`, async () => existsSync(join(folder, file)), 10_000).catch(() => {
        throw new Error(`${file} not saved; the folder has ${JSON.stringify(readdirSync(folder))}`)
      })
      assert.match(readFileSync(join(folder, file) + ':Zone.Identifier', 'utf8'), /ZoneId=3/)
    }
    const names = readdirSync(folder)
    assert.ok(names.every(n => !/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(n)), JSON.stringify(names))
    assert.ok(names.every(n => !/\.(exe|url)$/i.test(n)), JSON.stringify(names))

    // ---- 2. over the ceiling: cancelled, nothing left ----
    tree = (await tool('WebSnapshot')).text
    assert.equal((await tool('WebClick', { ref: refOf(tree, 'link "Baixar grande"') })).isError, false)
    await until('the big one cancelled', async () => {
      const log = existsSync(join(home, 'tether-app.log')) ? readFileSync(join(home, 'tether-app.log'), 'utf8') : ''
      return /download cancelado: acima de 50 MB/.test(log)
    })
    await sleep(500)
    assert.deepEqual(readdirSync(folder).sort(), ['atalho.download', 'fatura_fdp.exe.download', 'report-1.txt', 'report.txt'], 'nothing of the big download is left')

    // ---- 3. upload into the frame of another origin ----
    const dialogText = (): Promise<string | undefined> => win.evaluate(() => document.querySelector('dialog[data-dialog="browser-upload"]')?.textContent ?? undefined)
    const answer = (choice: string): Promise<void> => win.evaluate(c => { document.querySelector<HTMLButtonElement>(`dialog[data-dialog="browser-upload"] button.choice[data-choice="${c}"]`)!.click() }, choice)
    tree = (await tool('WebSnapshot')).text
    const field = refOf(tree, 'Arquivo do site')
    assert.notEqual(field, 'missing', tree)
    const denied = tool('WebUpload', { ref: field, path: sendFile })
    const text = (await until("the upload dialog", dialogText))!
    assert.match(text, /Permitir que Sonda envie nota\.txt para http:\/\/127\.0\.0\.1:\d+\?/)
    assert.ok(text.includes(`O campo é de ${frame.origin}, dentro de ${site.origin}.`), text)
    assert.ok(text.includes(uploadDir), 'the folder is shown')
    assert.equal(await win.evaluate(() => !!document.querySelector('dialog[data-dialog="browser-upload"] img.ask-image')), true, "the page's picture is in the dialog")
    await answer('deny')
    const d = await denied
    assert.equal(d.isError, true)
    assert.match(d.text, /UPLOAD_NOT_ALLOWED/)
    await sleep(800)
    assert.deepEqual(frame.uploads, [], 'nothing reached the site')

    tree = (await tool('WebSnapshot')).text
    const allowed = tool('WebUpload', { ref: refOf(tree, 'Arquivo do site'), path: sendFile })
    await until('the upload dialog again', dialogText)
    await answer('allow')
    const a = await allowed
    assert.equal(a.isError, false, a.text)
    await until('the site got the file', async () => frame.uploads.length === 1)
    assert.equal(frame.uploads[0], 'CONTEUDO-DA-NOTA-42')

    // ---- 4. the person takes the tab while a question waits ----
    tree = (await tool('WebSnapshot')).text
    const pending = tool('WebUpload', { ref: refOf(tree, 'Arquivo do site'), path: sendFile })
    await until('the upload dialog, pending', dialogText)
    await B((t, id) => t.control.take(id), tabId)
    await until('the dialog withdrawn', async () => (await dialogText()) === undefined)
    const p = await pending
    assert.equal(p.isError, true)
    assert.match(p.text, /UPLOAD_NOT_ALLOWED|TAB_WITH_USER/)
    assert.deepEqual(await B(t => t.openUploads()), [])
    await B((t, id) => t.control.giveBack(id), tabId)
    assert.equal(frame.uploads.length, 1, 'nothing more reached the site')

    // ---- 5. the gate refuses the attach shape without a consent ----
    const gate = (await B(t => t.gate()))!
    const spy = await rawCdp(gate.port, KEY)
    const bs = (await spy.call('Target.attachToBrowserTarget')).result.sessionId as string
    const target = (await spy.call('Target.getTargets', {}, bs)).result.targetInfos[0].targetId as string
    const sid = (await spy.call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId as string
    const doc = (await spy.call('Runtime.evaluate', { expression: 'document' }, sid)).result.result.objectId as string
    const forged = await spy.call('Runtime.callFunctionOn', {
      objectId: doc, functionDeclaration: 'function (files) { return injected.setInputFiles(this, files) }', arguments: [{ value: [{ name: 'x', buffer: 'QUJD' }] }],
    }, sid)
    assert.match(String(forged.error?.message), /file attach refused: no consent/)
    spy.close()
  } finally {
    if (server) { server.child.kill(); await sleep(300) }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    frame.server.close()
    site.server.close()
    if (soulBefore === undefined) delete process.env.TETHER_SOUL_CMD
    else process.env.TETHER_SOUL_CMD = soulBefore
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})
