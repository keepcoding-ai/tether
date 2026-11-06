// E2E of F9 slice 0b against the real tetherd on a private home/pipe, hidden window:
//   1. the ≡ menu, now generated from the menu registry, shows the same rows the static list had (labels, order,
//      separators, the "Tema" heading, radio/checkbox checks, shortcut hints, greyed items with no pane), plus "Extensões";
//   2. "Extensões" from the menu opens the screen (a tab listing the note extension); from the palette it brings the same tab forward;
//   3. the preload's extension bus and settings channels are live: `ext:<id>:<channel>` reaches main (no handler →
//      rejected, a bad id refused), settings.json `extensions` is read at start and a set is persisted and echoed.
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  palette(): { open: boolean; shown: string[] }
}
type Row = { role: string | null; command: string | null; text: string; kbd: string | null; checked: string | null; disabled: string | null; cls: string }
declare const window: {
  __tether: Hooks
  tether: {
    ext: { invoke(id: string, ch: string, ...a: unknown[]): Promise<unknown> }
    extSettingsSync(): unknown
    setExtSetting(id: string, key: string, value: unknown): void
    onExtSetting(l: (c: unknown) => void): () => void
  }
  __seen?: unknown[]
}
declare const document: {
  querySelectorAll(sel: string): ArrayLike<{ getAttribute(n: string): string | null; className: string; textContent: string | null; querySelector(s: string): { textContent: string | null } | null; childNodes: ArrayLike<{ nodeType: number; textContent: string | null }> }> & { length: number }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-extensions-${process.pid}`
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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** The ≡ rows as the person sees them: role, command, own text (no hint), hint, check, greyed, class. */
const menuRows = (page: Page): Promise<Row[]> => page.evaluate(() => Array.from(document.querySelectorAll('#app-menu > li')).map(li => ({
  role: li.getAttribute('role'),
  command: li.getAttribute('data-command'),
  text: Array.from(li.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
  kbd: li.querySelector('kbd')?.textContent ?? null,
  checked: li.getAttribute('aria-checked'),
  disabled: li.getAttribute('aria-disabled'),
  cls: li.className,
})))

// [command | 'sep' | 'label', text, hint, checked, disabled] with no pane open, default settings (theme auto).
const EXPECTED: Array<[string, string, string | null, string | null, string | null]> = [
  ['palette.show', 'Paleta de comandos…', 'Ctrl+Shift+P', null, 'false'],
  ['sep', '', null, null, null],
  ['pane.new', 'Novo painel…', 'Ctrl+K Ctrl+O', null, 'false'],
  ['pane.new-tab', 'Nova aba neste grupo', 'Ctrl+N', null, 'false'],
  ['pane.duplicate.pane.right', 'Duplicar painel à direita', 'Ctrl+Alt+→', null, 'true'],
  ['pane.duplicate.pane.below', 'Duplicar painel abaixo', 'Ctrl+Alt+↓', null, 'true'],
  ['pane.new-at-frame-edge', 'Novo painel na borda do quadro…', null, null, 'false'],
  ['frame.new', 'Novo quadro…', null, null, 'false'],
  ['sep', '', null, null, null],
  ['note.new', 'Nova nota', null, null, 'false'],
  ['note.open', 'Abrir nota…', 'Ctrl+O', null, 'false'],
  ['note.save-as', 'Salvar nota como…', 'Ctrl+Shift+S', null, 'true'],
  ['sep', '', null, null, null],
  ['desk.new', 'Nova mesa', 'Ctrl+Shift+N', null, 'false'],
  ['pane.move', 'Mover…', null, null, 'true'],
  ['desk.actions', 'Mesa atual: renomear, cor, mover…', null, null, 'false'],
  ['desk.close', 'Fechar mesa…', 'Ctrl+K F', null, 'true'],
  ['sep', '', null, null, null],
  ['drawer.toggle', 'Abrir gaveta', 'Ctrl+`', null, 'false'],
  ['sep', '', null, null, null],
  ['profiles.manage', 'Perfis de lançamento…', null, null, 'false'],
  ['pane.switch-profile', 'Trocar perfil do painel…', null, null, 'true'],
  ['sep', '', null, null, null],
  ['label', 'Tema', null, null, null],
  ['theme.light', 'Claro', null, 'false', 'false'],
  ['theme.auto', 'Automático', null, 'true', 'false'],
  ['theme.dark', 'Escuro', null, 'false', 'false'],
  ['ui.desk-line', 'Linha da cor da mesa', null, 'true', 'false'],
  ['ui.tab-border', 'Borda na guia do painel com foco', null, 'false', 'false'],
  ['ui.dim-unfocused', 'Esmaecer quadros sem foco', null, 'false', 'false'],
  ['ui.dim-weak', 'Esmaecer: fraco', null, 'false', 'false'],
  ['ui.dim-medium', 'Esmaecer: médio', null, 'false', 'false'],
  ['ui.dim-strong', 'Esmaecer: forte', null, 'false', 'false'],
  ['ui.word-wrap', 'Quebra de linha no editor', null, 'true', 'false'],
  ['terminal.theme', 'Tema do terminal…', null, null, 'false'],
  ['sep', '', null, null, null],
  ['keybindings.show', 'Atalhos de teclado', 'Ctrl+K Ctrl+S', null, 'false'],
  ['extensions.show', 'Extensões', null, null, 'false'],
  ['confirmations.restore', 'Voltar a perguntar antes de fechar painéis', null, null, 'false'],
  ['sep', '', null, null, null],
  ['window.close', 'Fechar a janela', 'Ctrl+Shift+W', null, 'false'],
  ['app.quit-all', 'Sair e encerrar tudo…', 'Ctrl+Shift+Q', null, 'false'],
]

test('app extensions (F9 0b): generated ≡ menu equals the old one + "Extensões"; the screen; the preload bus and settings', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-extensions-'))
  // A settings.json with an `extensions` object: read at start, kept as is beside the core keys.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: 'auto', extensions: { disabled: ['nada'], demo: { flag: true } } }))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. The menu, as the person sees it.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    const rows = await menuRows(page)
    const got = rows.map(r => [r.role === 'separator' ? 'sep' : r.cls === 'label' ? 'label' : r.command, r.text, r.kbd, r.checked, r.disabled])
    assert.deepEqual(got, EXPECTED)
    assert.equal(rows.find(r => r.command === 'app.quit-all')?.cls, 'danger')
    assert.ok(rows.filter(r => r.role?.startsWith('menuitem')).every(r => r.command), 'every item names a command')
    assert.equal(await page.locator('#app-menu li[data-command="theme.auto"] svg').count(), 1, 'icons are painted')

    // 2. "Extensões" from the menu: the screen opens as a tab, listing the note (F9 slice 1), on, with its switch.
    await page.click('#app-menu li[data-command="extensions.show"]')
    await page.waitForSelector('#app-menu', { state: 'hidden' })
    await page.waitForSelector('.ext-pane .ext-row[data-ext="note"]')
    assert.equal(await page.locator('.tether-tab.extensions .text').innerText(), 'Extensões')
    assert.equal(await page.locator('.ext-pane .ext-row[data-ext="note"]').getAttribute('data-state'), 'enabled')
    assert.equal(await page.locator('.ext-pane .ext-row[data-ext="note"] .ext-toggle').getAttribute('aria-checked'), 'true')
    // From the palette: the same screen comes forward (one at a time).
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => window.__tether.palette().open)
    await page.keyboard.type('extensões')
    await page.waitForFunction(() => window.__tether.palette().shown[0] === 'extensions.show')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !window.__tether.palette().open)
    await sleep(300)
    assert.equal(await page.locator('.ext-pane').count(), 1, 'one screen')
    assert.equal(await page.locator('.tether-tab.extensions').count(), 1)
    // With a pane active, the pane items are no longer greyed.
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.locator('#app-menu li[data-command="pane.move"]').getAttribute('aria-disabled'), 'false')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu', { state: 'hidden' })

    // 3. The bus and the settings channels through the real preload and main.
    const bus = await page.evaluate(async () => {
      const out: string[] = []
      try { await window.tether.ext.invoke('demo', 'ping'); out.push('resolved') } catch (e) { out.push(/No handler registered for 'ext:demo:ping'/.test(String(e)) ? 'no-handler' : String(e)) }
      try { await window.tether.ext.invoke('Bad:id', 'ping'); out.push('resolved') } catch (e) { out.push(/id de extensão inválido/.test(String(e)) ? 'refused' : String(e)) }
      return out
    })
    assert.deepEqual(bus, ['no-handler', 'refused'])
    assert.deepEqual(await page.evaluate(() => window.tether.extSettingsSync()), { disabled: ['nada'], values: { demo: { flag: true } } })
    await page.evaluate(() => { window.__seen = []; window.tether.onExtSetting(c => window.__seen!.push(c)); window.tether.setExtSetting('demo', 'flag', false) })
    await page.waitForFunction(() => (window.__seen ?? []).length === 1)
    assert.deepEqual(await page.evaluate(() => window.__seen), [{ id: 'demo', key: 'flag', value: false }])
    const saved = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    assert.equal(saved.theme, 'auto', 'core keys kept')
    assert.deepEqual(saved.extensions, { disabled: ['nada'], demo: { flag: false } })
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
