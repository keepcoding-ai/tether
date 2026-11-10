// E2E of the notes manager (extension pad-notes), the panel pad's second state, over the panel pad's notes: real tetherd
// on a private home/pipe, hidden window, CLAUDE* stripped. The manager never opens on the desk: it shows inside the pad.
//   1. a note in panel A's pad; a panel C whose pad stayed empty;
//   2. closing C leaves nothing behind (its empty note is cleaned on its own, no toast);
//   3. closing A: the toast "A nota da prancheta ficou solta · Ver"; Ver switches the panel pad to the manager on Soltas,
//      with A's note selected and its text in the read-only preview;
//   4. Mover… to B's panel pad: the note's tab lands in B's pad, nothing is loose any more;
//   5. Fechar (asked inline) → toast "Nota fechada · Desfazer" → Desfazer: the note is back in B's pad, same pane;
//   6. layout.json keeps the note's record (owner label, desk, when).
// Screenshots in <atrium>/.tmp/pad-notes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { key: string; title: string; owner: string; loose: boolean; empty: boolean }
type Manager = { filter: string; rows: Row[]; selected?: string; preview: string; confirming: boolean }
type Tree = { loose: { key: string; empty: boolean }[] }
type LayoutJSON = { sidebars?: { pads: Record<string, unknown>; meta?: Record<string, { ownerLabel: string; deskId?: string; updatedAt: number }> } }
type Hooks = {
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  openSlot(id: string): void
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
  focusablePanel(): string | undefined
  activatePanel(id: string): void
  panelIds(): string[]
  openNote(path: string): Promise<void>
  notesManager(): Manager[]
  notesManagerSelect(key: string): void
  notesTree(): Tree
  notesToast(): { text: string; action?: string } | undefined
  openNotesManager(filter?: string, key?: string): void
  notesManagerOn(): boolean
  layout(): LayoutJSON
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-padnotes-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = join(existsSync(atriumTmp) ? atriumTmp : tmpdir(), 'pad-notes')
const shots = tmpBase
const electronPath = require('electron') as string

const PANEL = 'frame-pads.panel'
const key = (panelId: string): string => `${PANEL}@${panelId}`
const shown = `#pads .pad.shown[data-pad="${PANEL}"]`
/** The manager as the e2e sees it: inside the pad on screen, never a tab on the desk. */
const inPad = `${shown} .pad-manager.pn-pane:not([hidden])`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function shell(page: Page): Promise<string> {
  const reply = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), root)
  assert.equal(reply.t, 'ok')
  const id = reply.slot!.slotId
  await page.waitForFunction(id => typeof window.__tether.slots().find(s => s.slotId === id)?.pid === 'number', id, { timeout: 20_000 })
  await page.evaluate(id => window.__tether.openSlot(id), id)
  await page.waitForFunction(id => window.__tether.focusablePanel() === id, id)
  return id
}

/** Closes a pane through its tab's close button, keeping its process ("detach"). */
async function closePane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`#dock .tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

const manager = async (page: Page): Promise<Manager | undefined> => (await page.evaluate(() => window.__tether.notesManager()))[0]
/** The panes saved in a panel's pad (layout.json's state of `frame-pads.panel@<panel>`). */
const padHas = async (page: Page, panelId: string, paneId: string): Promise<boolean> =>
  page.evaluate(([k, id]) => JSON.stringify(window.__tether.layout().sidebars?.pads[k!] ?? null).includes(`"${id}"`), [key(panelId), paneId])

test('notes manager: a note left loose by a closed panel is found, moved, closed and brought back', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(tmpBase, { recursive: true })
  const home = mkdtempSync(join(tmpBase, 'home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['explorer'] } }))
  const notePath = join(home, 'lembrete.md')
  writeFileSync(notePath, 'lembrar do bug do cwd\nsegunda linha da nota\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. a note in A's panel pad; C's pad shown once, left empty ----
    const a = await shell(page)
    await page.click(`.sb-icon[data-pad="${PANEL}"]`)
    await page.waitForSelector(`${shown}[data-panel="${a}"] .empty-panel`)
    await page.click(`${shown} .frame-dock`) // the keyboard into the pad: the note opens there
    await page.evaluate(p => window.__tether.openNote(p), notePath)
    await page.waitForFunction(() => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.shown && f.panes.some(p => p.startsWith('note:'))))
    const noteId = (await page.evaluate(() => window.__tether.padFrames())).filter(f => f.pad === 'frame-pads.panel' && f.shown).flatMap(f => f.panes).find(p => p.startsWith('note:'))!
    assert.ok(await padHas(page, a, noteId), "the note is in A's pad")
    const b = await shell(page)
    const c = await shell(page)
    await page.waitForSelector(`${shown}[data-panel="${c}"] .empty-panel`)
    await page.waitForFunction(k => k in (window.__tether.layout().sidebars?.pads ?? {}), key(c))

    // ---- 2. closing C: its empty note goes on its own, without a toast ----
    await closePane(page, c)
    await page.waitForFunction(k => !(k in (window.__tether.layout().sidebars?.pads ?? {})), key(c), { timeout: 5_000 })
    assert.equal(await page.evaluate(() => window.__tether.notesToast()), undefined, 'an empty note leaves no toast')

    // ---- 3. closing A: the toast, then Ver opens the manager on the loose note ----
    await page.evaluate(id => window.__tether.activatePanel(id), a)
    await closePane(page, a)
    await page.waitForFunction(() => window.__tether.notesToast()?.text === 'A nota da prancheta ficou solta', undefined, { timeout: 5_000 })
    assert.equal((await page.evaluate(() => window.__tether.notesToast()))!.action, 'Ver')
    await page.screenshot({ path: join(shots, '1-toast-solta.png') })
    assert.deepEqual((await page.evaluate(() => window.__tether.notesTree())).loose.map(r => r.key), [key(a)])
    await page.click('.pn-toast .pn-toast-action')
    await page.waitForSelector(`${inPad} .pn-row`)
    assert.ok(await page.evaluate(() => window.__tether.notesManagerOn()), 'the pad is in its manager state')
    assert.equal(await page.locator('#dock .tether-tab.notes-manager').count(), 0, 'nothing opened on the desk')
    let m = (await manager(page))!
    assert.equal(m.filter, 'loose')
    assert.equal(m.selected, key(a))
    assert.equal(m.rows.length, 1)
    assert.ok(m.rows[0]!.owner.startsWith('antes em '), `owner says where it was: ${m.rows[0]!.owner}`)
    await page.waitForFunction(() => window.__tether.notesManager()[0]?.preview.includes('lembrar do bug do cwd'))
    await page.screenshot({ path: join(shots, '2-gerenciador-soltas.png') })
    // The frame's tab bar stays above the manager, its switch lit; it takes the pad back to the frame. Then the panel pad's
    // "⋯" offers the manager, on Soltas while a note is loose.
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await page.waitForSelector(`${shown}[data-panel="${b}"] .tab-act[data-action="notes-manager"][aria-pressed="true"]`, { state: 'visible' })
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="notes-manager"]`)
    await page.waitForFunction(() => !window.__tether.notesManagerOn())
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="pane-menu"]`)
    await page.waitForSelector('#ctx-menu')
    await page.screenshot({ path: join(shots, '3-menu-com-solta.png') })
    await page.locator('#ctx-menu li[role="menuitem"]', { hasText: 'Notas das pranchetas' }).first().click()
    await page.waitForSelector(`${inPad} .pn-bar button[data-action="move"]`, { state: 'visible' })
    assert.equal((await manager(page))!.filter, 'loose')

    // ---- 4. Mover… to B's panel pad ----
    await page.click(`${inPad} .pn-bar button[data-action="move"]`)
    await page.waitForSelector('#ctx-menu')
    const bTitle = await page.locator(`#dock .tether-tab[data-slot="${b}"] .text`).first().innerText()
    await page.locator('#ctx-menu li[role="menuitem"]', { hasText: bTitle }).first().click()
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.panes.includes(id)), noteId)
    await page.waitForFunction(() => window.__tether.notesTree().loose.length === 0)
    assert.ok(await padHas(page, b, noteId), "the note's tab is in B's pad")
    await page.waitForFunction(() => window.__tether.notesManager()[0]?.rows.length === 0, undefined, { timeout: 5_000 }) // Soltas is empty now
    await page.screenshot({ path: join(shots, '4-movida-para-b.png') })

    // ---- 5. Fechar with Desfazer ----
    await page.evaluate(k => window.__tether.openNotesManager('all', k), key(b))
    await page.waitForFunction(k => window.__tether.notesManager()[0]?.selected === k, key(b))
    await page.click(`${inPad} .pn-bar button[data-action="close"]`)
    await page.waitForSelector(`${inPad} .pn-bar button[data-action="confirm-close"]`)
    await page.screenshot({ path: join(shots, '5-confirmar-fechar.png') })
    await page.click(`${inPad} .pn-bar button[data-action="confirm-close"]`)
    await page.waitForFunction(() => window.__tether.notesToast()?.text === 'Nota fechada')
    await page.waitForFunction(id => !window.__tether.padFrames().some(f => f.panes.includes(id)), noteId)
    await page.screenshot({ path: join(shots, '6-toast-desfazer.png') })
    await page.click('.pn-toast .pn-toast-action')
    await page.waitForFunction(id => window.__tether.padFrames().some(f => f.pad === 'frame-pads.panel' && f.panes.includes(id)), noteId)
    assert.ok(await padHas(page, b, noteId), 'Desfazer brought the same note back to B')
    // B's pad on screen, with the note back in it.
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await page.waitForSelector(`${shown}[data-panel="${b}"]`)
    await page.screenshot({ path: join(shots, '7-desfeito.png') })

    // ---- 6. the record in layout.json ----
    let saved: LayoutJSON | undefined
    for (let i = 0; i < 40; i++) {
      saved = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as LayoutJSON
      if (saved.sidebars?.meta?.[key(b)]) break
      await sleep(100)
    }
    const rec = saved?.sidebars?.meta?.[key(b)]
    assert.ok(rec, "B's note has its record")
    assert.equal(rec.ownerLabel, bTitle)
    assert.ok(rec.deskId && rec.updatedAt > 0)
    assert.equal(saved!.sidebars!.meta![key(a)], undefined, "A's record went with its note")

    // ---- 7. the keyboard: Ctrl+Shift+M switches the pad from inside a terminal (Ctrl+K chords pass to the shell there)
    //         and back; Ctrl+K N outside; Escape in the manager goes back to the frame ----
    await page.click(`${shown} .tab-act[data-action="notes-manager"]`)
    await page.waitForFunction(() => !window.__tether.notesManagerOn())
    assert.equal((await page.evaluate(() => window.__tether.notesManager())).length, 0, 'no manager on screen in the frame state')
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await page.locator(`.panel[data-slot-id="${b}"] .xterm-screen`).click()
    await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
    await page.keyboard.press('Control+Shift+M')
    await page.waitForFunction(() => window.__tether.notesManagerOn() && window.__tether.notesManager().length === 1, undefined, { timeout: 5_000 })
    await page.waitForFunction(() => !!document.activeElement?.closest('.pn-pane'), undefined, { timeout: 5_000 }) // the keyboard followed
    await page.keyboard.press('Control+Shift+M')
    await page.waitForFunction(() => !window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+K')
    await page.keyboard.press('N')
    await page.waitForFunction(() => window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })
    await page.locator(`${inPad} .pn-list`).focus()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })

    // ---- 8. the pinned switch in the panel pad's header: the manager shows in the pad, in place of the frame; nothing on the desk ----
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await page.click(`${shown}[data-panel="${b}"] .frame-dock`) // the keyboard into the pad
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="notes-manager"]`)
    await page.waitForSelector(`${shown}[data-panel="${b}"] .pad-manager.pn-pane:not([hidden])`, { state: 'visible' })
    assert.ok(await page.evaluate(() => window.__tether.notesManagerOn()))
    assert.equal(await page.locator('#dock .tether-tab.notes-manager').count(), 0, 'the manager is not a tab on the desk')
    assert.ok(!(await page.evaluate(() => window.__tether.panelIds())).some(id => id.startsWith('notes-manager:')), 'no manager pane exists')
    await page.screenshot({ path: join(shots, '8-botao-fixo.png') })
    // The manager starts under the tab bar, which is still on screen with the switch lit; a tab clicked goes back to the frame.
    const barBox = (await page.locator(`${shown}[data-panel="${b}"] .dv-tabs-and-actions-container`).first().boundingBox())!
    const mgrBox = (await page.locator(inPad).boundingBox())!
    assert.ok(barBox.height > 0 && Math.abs(mgrBox.y - (barBox.y + barBox.height)) <= 1, `the manager starts where the tab bar ends (${mgrBox.y} vs ${barBox.y + barBox.height})`)
    await page.click(`${shown}[data-panel="${b}"] .dv-tabs-container .dv-tab`)
    await page.waitForFunction(() => !window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })
    await page.click(`${shown}[data-panel="${b}"] .tab-act[data-action="notes-manager"]`)
    await page.waitForFunction(() => window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })
    // Enter on a live note takes the pad back to that note's frame.
    await page.evaluate(k => window.__tether.notesManagerSelect(k), key(b))
    await page.locator(`${inPad} .pn-list`).focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !window.__tether.notesManagerOn(), undefined, { timeout: 5_000 })
    assert.ok(await padHas(page, b, noteId), "B's note frame is what the pad shows again")

    // ---- 9. affinity: the settings (a desk-only screen) opened with the pad in focus land on the desk, never in the pad ----
    await page.evaluate(id => window.__tether.activatePanel(id), b)
    await page.click(`${shown}[data-panel="${b}"] .frame-dock`) // the keyboard into the pad again
    await page.keyboard.press('Control+,')
    await page.waitForFunction(() => window.__tether.panelIds().some(id => id.startsWith('settings:')), undefined, { timeout: 5_000 })
    const pads9 = await page.evaluate(() => window.__tether.padFrames())
    assert.ok(!pads9.some(f => f.panes.some(p => p.startsWith('settings:'))), 'the settings are not inside a pad')
    await page.screenshot({ path: join(shots, '9-afinidade-config.png') })
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const p of daemons) await killOwned(p, { tree: true })
    for (let i = 0; i < 20 && daemons.some(p => pidAlive(p.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
