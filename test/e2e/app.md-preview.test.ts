// E2E of the markdown preview (F5, delivery 4): against the real tetherd on a private home/pipe, hidden window.
//   1. Ctrl+Shift+V on a markdown note opens "Prévia: nome.md" in the same group; the palette lists both commands; a
//      shell pane has neither, and Ctrl+Shift+V there opens nothing (the terminal keeps its paste);
//   2. the document is drawn: title, table, strikethrough, coloured code, task list; relative image loads from the note's
//      folder, an image outside it and a remote one are inert placeholders;
//   3. hostile text does not run: a <script>, an <img onerror>, a javascript: link are text or nothing; the frame is
//      sandboxed without allow-scripts, and even DOM injected into it by force executes nothing;
//   4. typing in the editor updates the preview; a change of the file from outside updates it (editor open, then closed);
//   5. "abrir prévia ao lado": scrolling the editor scrolls the preview and the other way round; a double click in the
//      preview puts the editor's cursor on that line;
//   6. links: a relative one opens the file as a note, a web one goes to the system browser, an #anchor scrolls the preview;
//   7. the main process is killed and relaunched: the preview comes back, tied to the same file, same group;
//   8. screenshots md-preview-{dark,light}.png.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Frame, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Note = { id: string; path: string; text: string; dirty: boolean; cursor: { lineNumber: number; column: number } | undefined; scrollTop: number; topLine: number; focused: boolean }
type Preview = { id: string; path: string; sandbox: string; text: string; html: string; scrollTop: number; scrollHeight: number; topLine: number; blocks: number; error: string | undefined; rendered: number }
type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  frameOf(id: string): string | undefined
  groupOf(id: string): string | undefined
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  commands(): { id: string; title: string; hint: string; available: boolean }[]
  notes(): Note[]
  note(id: string): Note | undefined
  scrollNote(id: string, top: number): void
  openNote(path: string): Promise<void>
  previews(): Preview[]
  preview(id: string): Preview | undefined
  previewRect(id: string, selector: string): { x: number; y: number; width: number; height: number } | undefined
  layout(): unknown
}
declare const window: { __tether: Hooks; __pwned?: number; scrollTo(x: number, y: number): void; scrollY: number }
// The page's and the preview frame's documents are read from evaluate callbacks: loosely typed on purpose.
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-mdpreview-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text().slice(0, 300)}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 820))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.resize({ width: Math.round(img.getSize().width / 2), quality: 'best' }).toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64')

/** A long document: a title, a table, code, links, hostile bits, then forty sections and an anchor target at the end. */
function sampleMarkdown(): string {
  const sections = Array.from({ length: 40 }, (_, i) => `## Seção ${i + 1}\n\nParágrafo da seção ${i + 1}, com texto o bastante para ocupar uma linha inteira da prévia e mais um pouco.\nSegunda linha da seção ${i + 1}.\n`).join('\n')
  return [
    '# Título da prévia',
    '',
    'Texto com **negrito**, ~~tachado~~ e `código`. Veja [outro arquivo](outro.md), [a web](https://example.com/pagina) e [o fim](#seção-final).',
    '',
    '| Coluna A | Coluna B |',
    '|----------|----------|',
    '| um       | dois     |',
    '',
    '- [ ] tarefa aberta',
    '- [x] tarefa feita',
    '',
    '```ts',
    'const total: number = 1 + 2',
    '```',
    '',
    '![figura](img/pic.png) ![fora](../fora.png) ![remota](https://example.invalid/pixel.png)',
    '',
    '<script>window.__pwned = 1; parent.__pwned = 1</script>',
    '<img src="img/pic.png" onerror="parent.__pwned = 2">',
    '[clique](javascript:window.__pwned=3)',
    '',
    sections,
    '## Seção Final',
    '',
    'O fim.',
    '',
  ].join('\n')
}

test('app md-preview: Ctrl+Shift+V, GFM, nothing hostile runs, live, scroll sync, links, kill and resume', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-mdp-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-mdp-files-'))
  const dir = join(base, 'notas')
  mkdirSync(join(dir, 'img'), { recursive: true })
  const mdPath = join(dir, 'leia-me.md')
  writeFileSync(mdPath, sampleMarkdown())
  writeFileSync(join(dir, 'outro.md'), '# Outro arquivo\n\nconteudo\n')
  writeFileSync(join(dir, 'img', 'pic.png'), PNG)
  writeFileSync(join(base, 'fora.png'), PNG)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const opened: string[] = []
    // The system browser is never really launched: main's shell.openExternal is replaced by a recorder.
    await app.evaluate(({ shell }) => { (globalThis as { __opened?: string[] }).__opened = []; shell.openExternal = async (url: string) => { (globalThis as { __opened?: string[] }).__opened!.push(url) } })
    const externalOpened = (): Promise<string[]> => app!.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

    await createShell(page, dir)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    const previews = (): Promise<Preview[]> => page.evaluate(() => window.__tether.previews())
    const previewText = (id: string, needle: string): Promise<unknown> => page.waitForFunction(([id, needle]) => window.__tether.preview(id!)?.text.includes(needle!) === true, [id, needle] as const)

    // 1. A shell has no preview command, and Ctrl+Shift+V in its terminal opens none (it stays the terminal's paste).
    let cmds = await page.evaluate(() => window.__tether.commands())
    assert.equal(cmds.find(c => c.id === 'markdown.preview')?.available, false, 'not on a terminal')
    await page.locator(`.panel[data-slot-id="${shell}"] .panel-term`).click()
    await page.keyboard.press('Control+Shift+V')
    await sleep(400)
    assert.equal((await previews()).length, 0, 'Ctrl+Shift+V in a terminal opens no preview')

    // Open the markdown as a note and ask for the preview with the chord, from inside the editor.
    await page.evaluate(path => window.__tether.openNote(path), mdPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1 && window.__tether.notes()[0]!.text.length > 0)
    const note = (await page.evaluate(() => window.__tether.notes()))[0]!
    await page.locator(`.note-panel[data-note-id="${note.id}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, note.id)
    cmds = await page.evaluate(() => window.__tether.commands())
    const open = cmds.find(c => c.id === 'markdown.preview')!
    assert.equal(open.title, 'Markdown: abrir prévia')
    assert.equal(open.hint, 'Ctrl+Shift+V')
    assert.equal(open.available, true)
    assert.equal(cmds.find(c => c.id === 'markdown.preview.side')?.title, 'Markdown: abrir prévia ao lado')
    assert.equal(cmds.find(c => c.id === 'markdown.preview.side')?.hint, '', 'Ctrl+K V comes with delivery 5')
    assert.ok(await page.locator('.tab-act[data-action="md-preview-side"]:visible').count() >= 1, 'the strip has the preview button for a markdown note')
    await page.keyboard.press('Control+Shift+V')
    await page.waitForFunction(() => window.__tether.previews().length === 1)
    let [pv] = await previews()
    const previewId = pv!.id
    assert.equal(await page.evaluate(id => window.__tether.groupOf(id), previewId), await page.evaluate(id => window.__tether.groupOf(id), note.id), 'the preview is a tab of the note\'s group')
    assert.equal(await page.locator(`.tether-tab.preview .text`).innerText(), 'Prévia: leia-me.md')
    assert.equal(await page.evaluate(() => window.__tether.activeId()), previewId, 'and it is the front tab')
    await previewText(previewId, 'Título da prévia')
    await page.keyboard.press('Control+Shift+V')
    await sleep(200)
    assert.equal((await previews()).length, 1, 'asking again does not open a second preview of the file')

    // 2. The document is drawn.
    pv = (await previews())[0]!
    assert.equal(pv.sandbox, 'allow-same-origin', 'sandboxed, scripts off')
    for (const re of [/<h1[^>]*id="título-da-prévia"/, /<table/, /<s>tachado<\/s>/, /<input class="task-list-item-checkbox" type="checkbox" disabled="" checked="">/, /class="language-ts"/, /<span class="mtk\d+"/, /href="outro.md"/, /id="seção-final"/]) {
      assert.match(pv.html, re)
    }
    assert.ok(pv.blocks > 80, `blocks carry their source lines (${pv.blocks})`)
    const frame = page.frames().find(f => f.parentFrame() !== null && f.url() === 'about:srcdoc')
    assert.ok(frame, 'the preview frame')
    const images = await frame.evaluate(() => ({
      loaded: Array.from(document.querySelectorAll('img')).map((i: any) => ({ src: String(i.src), ok: i.naturalWidth > 0 })),
      blocked: document.querySelectorAll('.img-blocked').length,
    })) as { loaded: { src: string; ok: boolean }[]; blocked: number }
    assert.equal(images.loaded.length, 2, 'only the two images inside the note folder became an <img> (the markdown one and the HTML one, rebuilt without its onerror)')
    assert.ok(images.loaded.every(i => i.ok && /\/notas\/img\/pic\.png$/.test(i.src)), `they loaded from disk: ${JSON.stringify(images.loaded)}`)
    assert.equal(images.blocked, 2, 'the image outside the folder and the remote one are placeholders')

    // 3. Nothing hostile runs.
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'no script of the document ran in the app')
    assert.equal(await frame.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined, 'nor in the frame')
    assert.equal(await frame.evaluate(() => document.querySelectorAll('script, iframe, object, embed, [onerror], [onclick], [onload]').length), 0, 'no script-capable element in the document')
    assert.ok(pv.text.includes('<script>'), 'the script is shown as text')
    assert.equal(await frame.evaluate(() => document.querySelector('a[href^="javascript"]') === null), true, 'the javascript: link has no href')
    // Even DOM forced in from outside the sanitizer executes nothing: the frame itself has scripts switched off.
    await frame.evaluate(() => {
      const s = document.createElement('script'); s.textContent = 'parent.__pwned = 10'; document.body.append(s)
      const holder = document.createElement('div'); holder.innerHTML = '<img src="x" onerror="parent.__pwned = 11"><a id="evil" href="javascript:parent.__pwned = 12">x</a>'; document.body.append(holder)
      document.getElementById('evil').click()
    })
    await sleep(500)
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'the sandbox stops injected script, handlers and javascript: URLs')
    await frame.evaluate(() => { for (const el of Array.from(document.body.children) as any[]) if (el.id !== 'root') el.remove() })

    // 4. Typing updates the preview; so does a change from outside (editor open, then closed).
    await page.evaluate(id => window.__tether.activate(id), note.id)
    await page.locator(`.note-panel[data-note-id="${note.id}"] .monaco-editor`).click()
    await page.waitForFunction(id => window.__tether.note(id)?.focused === true, note.id)
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nDigitado agora')
    await page.evaluate(id => window.__tether.activate(id), previewId)
    await previewText(previewId, 'Digitado agora')
    await page.waitForFunction(id => { const n = window.__tether.note(id); return !!n && !n.dirty && n.text.includes('Digitado agora') }, note.id) // written: a change from outside is then a plain reload, not a conflict
    writeFileSync(mdPath, (await page.evaluate(id => window.__tether.note(id)!.text, note.id)).replace(/\r\n/g, '\n').replace('Digitado agora', 'Mudou por fora'))
    await previewText(previewId, 'Mudou por fora')
    // Close the editor: the preview reads the file itself and still follows the disk.
    await page.evaluate(id => window.__tether.activate(id), note.id)
    await page.locator(`.tether-tab.note[data-slot="${note.id}"] .close`).click()
    await page.waitForFunction(() => window.__tether.notes().length === 0)
    writeFileSync(mdPath, readText(mdPath).replace('Mudou por fora', 'Só o arquivo'))
    await previewText(previewId, 'Só o arquivo')

    // 5. "Abrir prévia ao lado": scroll sync both ways, double click to the line.
    await page.locator(`.tether-tab.preview .close`).click()
    await page.waitForFunction(() => window.__tether.previews().length === 0)
    await page.evaluate(path => window.__tether.openNote(path), mdPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1 && window.__tether.notes()[0]!.text.length > 0)
    const note2 = (await page.evaluate(() => window.__tether.notes()))[0]!
    await page.evaluate(id => window.__tether.activate(id), note2.id)
    assert.equal(await page.evaluate(() => window.__tether.runCommand('markdown.preview.side')), 'ran')
    await page.waitForFunction(() => window.__tether.previews().length === 1)
    const side = (await previews())[0]!
    assert.notEqual(await page.evaluate(id => window.__tether.groupOf(id), side.id), await page.evaluate(id => window.__tether.groupOf(id), note2.id), 'beside, in its own group')
    await page.waitForFunction(id => (window.__tether.preview(id)?.blocks ?? 0) > 80, side.id)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), note2.id, 'the keyboard stays in the editor')
    // The wheel, as the person turns it: smooth scrolling needs a visible window, so the E2E scrolls the editor and the document directly.
    await page.evaluate(id => window.__tether.scrollNote(id, 1500), note2.id)
    await page.waitForFunction(id => window.__tether.note(id)!.topLine > 40, note2.id)
    await page.waitForFunction(id => window.__tether.preview(id)!.scrollTop > 100, side.id)
    await sleep(400)
    const e1 = (await page.evaluate(id => window.__tether.note(id), note2.id))!
    const p1 = (await page.evaluate(id => window.__tether.preview(id), side.id))!
    assert.ok(Math.abs(p1.topLine - e1.topLine) < 3, `the preview follows the editor: preview line ${p1.topLine.toFixed(1)}, editor line ${e1.topLine.toFixed(1)}`)
    const sideFrame = (): Frame => page.frames().filter(f => f.parentFrame() !== null && f.url() === 'about:srcdoc' && !f.isDetached()).at(-1)!
    await sideFrame().evaluate(() => window.scrollTo(0, window.scrollY - 800))
    await page.waitForFunction(([nid, before]) => window.__tether.note(nid!)!.topLine < before!, [note2.id, e1.topLine] as const)
    await sleep(400)
    const e2 = (await page.evaluate(id => window.__tether.note(id), note2.id))!
    const p2 = (await page.evaluate(id => window.__tether.preview(id), side.id))!
    assert.ok(e2.topLine < e1.topLine, 'scrolling the preview scrolled the editor')
    assert.ok(Math.abs(p2.topLine - e2.topLine) < 3, `and they agree: preview ${p2.topLine.toFixed(1)}, editor ${e2.topLine.toFixed(1)}`)
    // Double click a paragraph in the preview: the editor's cursor goes to that source line.
    const target = await page.evaluate(async id => {
      const all = Array.from({ length: 200 }, (_, i) => i)
      for (const n of all) { const r = window.__tether.previewRect(id, `p[data-line="${n}"]`); if (r && r.y > 150 && r.y < 700 && r.x > 0) return { n, r } }
      return undefined
    }, side.id)
    assert.ok(target, 'a paragraph on screen')
    await page.mouse.dblclick(target.r.x + 40, target.r.y + 6)
    await page.waitForFunction(([id, n]) => { const c = window.__tether.note(id!)?.cursor; return !!c && c.lineNumber >= n! + 1 && c.lineNumber <= n! + 2 }, [note2.id, target.n] as const)
    assert.equal(await page.evaluate(() => window.__tether.activeId()), note2.id)

    // 6. Links.
    const linkRect = async (sel: string) => page.evaluate(([id, sel]) => window.__tether.previewRect(id!, sel!), [side.id, sel] as const)
    await page.evaluate(id => window.__tether.activate(id), side.id)
    await sleep(500) // the pane's frame loads again when its group is activated; its document is drawn back at once
    await page.waitForFunction(id => (window.__tether.preview(id)?.blocks ?? 0) > 80, side.id)
    // Back to the top: the intro paragraph holds the three links.
    await sideFrame().evaluate(() => window.scrollTo(0, 0))
    await page.waitForFunction(id => window.__tether.preview(id)!.scrollTop === 0, side.id)
    const web = (await linkRect('a[href^="https://example.com"]'))!
    await page.mouse.click(web.x + web.width / 2, web.y + web.height / 2)
    await waitUntil(async () => (await externalOpened()).length === 1)
    assert.deepEqual(await externalOpened(), ['https://example.com/pagina'], 'the web link went to the system browser')
    opened.push(...(await externalOpened()))
    const rel = (await linkRect('a[href="outro.md"]'))!
    await page.mouse.click(rel.x + rel.width / 2, rel.y + rel.height / 2)
    await page.waitForFunction(() => window.__tether.notes().some(n => /outro\.md$/.test(n.path)))
    // The file opened as a note tab in the preview's group: back to the preview, at the top, for the anchor.
    await page.evaluate(id => window.__tether.activate(id), side.id)
    await sleep(500)
    await page.waitForFunction(id => (window.__tether.preview(id)?.blocks ?? 0) > 80, side.id)
    await sideFrame().evaluate(() => window.scrollTo(0, 0))
    await page.waitForFunction(id => window.__tether.preview(id)!.scrollTop === 0, side.id)
    const anchor = (await linkRect('a[href^="#"]'))!
    await page.mouse.click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
    await page.waitForFunction(id => window.__tether.preview(id)!.scrollTop > 500, side.id)
    const heading = (await linkRect('#seção-final'))!
    const frameBox = (await page.locator(`.preview-panel[data-preview-id="${side.id}"] .preview-frame`).boundingBox())!
    assert.ok(heading.y >= frameBox.y && heading.y + heading.height <= frameBox.y + frameBox.height, `the anchor target is on screen in the preview (y ${heading.y}, frame ${frameBox.y}..${frameBox.y + frameBox.height})`)
    assert.equal((await externalOpened()).length, 1, 'no other link went to the browser')
    assert.equal(await page.evaluate(() => window.__pwned), undefined)

    // 7. Kill the main process: the preview comes back, tied to the file.
    await sleep(900) // the params (path, scroll) and the layout land
    assert.ok(JSON.stringify(await page.evaluate(() => window.__tether.layout())).includes('md-preview'), 'the layout carries the preview pane')
    const beforeKill = { frame: await page.evaluate(id => window.__tether.frameOf(id), side.id), group: await page.evaluate(id => window.__tether.groupOf(id), side.id), line: (await page.evaluate(id => window.__tether.preview(id), side.id))!.topLine }
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.previews().length === 1)
    const back = (await previews())[0]!
    assert.equal(back.id, side.id, 'same pane')
    assert.equal(back.path, mdPath, 'same file')
    await previewText(back.id, 'Título da prévia')
    assert.equal(await page.locator(`.tether-tab.preview .text`).innerText(), 'Prévia: leia-me.md')
    assert.equal(await page.evaluate(id => window.__tether.frameOf(id), back.id), beforeKill.frame, 'same frame')
    await sleep(1500) // the editor beside it settles on its saved view, the preview follows it
    const afterLine = (await page.evaluate(id => window.__tether.preview(id), back.id))!.topLine
    // The editor owns the position when it is open (it is, and clamps at the end of its own document a few lines away from the preview's).
    assert.ok(Math.abs(afterLine - beforeKill.line) < 15 && afterLine > 150, `the scroll came back too (line ${beforeKill.line.toFixed(1)} -> ${afterLine.toFixed(1)})`)

    // 8. Screenshots, dark and light: the document and the editor beside it.
    for (const scheme of ['dark', 'light'] as const) {
      await page.evaluate(s => window.__tether.runCommand(`theme.${s}`), scheme)
      await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await sleep(900)
      await page.frames().filter(f => f.parentFrame() !== null && f.url() === 'about:srcdoc' && !f.isDetached()).at(-1)!.evaluate(() => window.scrollTo(0, 0))
      await sleep(500)
      await shot(app, `md-preview-${scheme}`)
    }
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const d of [home, base]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(d, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})

async function waitUntil(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await check()) return; await sleep(100) }
  throw new Error('condition not met in time')
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}
