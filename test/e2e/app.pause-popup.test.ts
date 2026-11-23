// E2E of the "Sessões" popup (what is running + the polite pause), no Claude needed (powershell panes stand in for the agents;
// their turn, attention and idleness are fed with window.__tether.applyState). Opens it with the palette command (the old id
// pause.manage still works as an alias) in these situations, in the four tiers (500/900/1250/1280/2600 px wide), light and dark:
//   empty (no session) · live (1 pede atenção + 2 em andamento + 3 ociosas, with and without a tab, no pause: the preview of who
//   gets the request) · pause (3 sessions in the batch with the pause glyph + the others "Fora da pausa") · ready (everyone
//   stopped: the preview of who goes back) · many (20 live sessions: the list scrolls, the footer stays).
// Asserts the header is a direct child of the dialog on top, no horizontal scroll, a dignified height, the footer inside the
// dialog, the groups and the footer texts of each situation, and that opening/selecting/Enter never send a request.
// Captures go to SESSIONS_POPUP_DIR (default C:/atrium/.tmp/sessions-popup-proof, outside the repo).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { cmdPause } from '../../src/cli/pause.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  applyState(slot: SlotState): void
  connection(): { pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; pause?: { entries: { slotId: string; state: string }[] } | null }> } }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelectorAll(s: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.SESSIONS_POPUP_DIR ?? 'C:/atrium/.tmp/sessions-popup-proof'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-pausepop-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

/** A PowerShell in the visible desk through the chooser; returns its slot id once it runs. */
async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await page.evaluate(() => window.__tether.panelIds())).find(x => !before.includes(x))!
  await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.status === 'running', id, { timeout: 20_000 })
  return id
}

/** Closes the pane through its tab and keeps the process running ("só fechar"): the session is left without a tab. */
async function detachPane(page: Page, slotId: string): Promise<void> {
  const tab = page.locator(`.tether-tab[data-slot="${slotId}"]`)
  await tab.hover()
  await tab.locator('.close').click()
  await page.locator('dialog[open] button.choice[data-choice="detach"]').click()
  await page.waitForFunction(id => !window.__tether.panelIds().includes(id), slotId)
}

interface Feed { name?: string; turn?: 'busy'; attention?: 'done' | 'waiting'; idleSince?: string }
/** Feeds the renderer the slot as the daemon would report it: working, asking attention, or idle since a while. */
async function feed(page: Page, slotId: string, f: Feed): Promise<void> {
  await page.evaluate(([id, p]) => {
    const s = window.__tether.slots().find(x => x.slotId === id)!
    const next = { ...s } as Record<string, unknown>
    delete next.idleSince; delete next.turn; delete next.attention
    window.__tether.applyState({ ...next, ...(p as object) } as unknown as SlotState)
  }, [slotId, f] as const)
}

interface Box { x: number; y: number; w: number; h: number }
interface Geo {
  dlg: Box; head: Box | null; headParentIsDialog: boolean; xBtn: Box | null; scrollW: number; clientW: number; footDisplay: string | null
  foot: Box | null; bodyScrollW: number; bodyClientW: number; body: Box; left: { scrollH: number; clientH: number; overflowY: string }
  right: { overflowY: string }
}
async function geometry(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const g = globalThis as any
    const d = g.document.querySelector('dialog[data-dialog="sessions"]')
    const r = (e: any): Box => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    const head = d.querySelector('header'), x = d.querySelector('.pd-close'), foot = d.querySelector('.pd-foot'), body = d.querySelector('.pd-body')
    const left = d.querySelector('.pd-left'), right = d.querySelector('.pd-right')
    return {
      dlg: r(d), head: head ? r(head) : null, headParentIsDialog: head?.parentElement === d, xBtn: x ? r(x) : null,
      scrollW: d.scrollWidth, clientW: d.clientWidth, footDisplay: foot ? g.getComputedStyle(foot).display : null, foot: foot ? r(foot) : null,
      bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth, body: r(body),
      left: { scrollH: left.scrollHeight, clientH: left.clientHeight, overflowY: g.getComputedStyle(left).overflowY },
      right: { overflowY: g.getComputedStyle(right).overflowY },
    }
  })
}

const dlgSel = 'dialog[data-dialog="sessions"]'
const texts = (page: Page, sel: string): Promise<string[]> => page.locator(`${dlgSel} ${sel}`).allTextContents().then(a => a.map(t => t.replace(/\s+/g, ' ').trim()))
const batchOf = (page: Page) => page.evaluate(async () => { const r = await window.tether.request({ t: 'pause-get' }); return r.pause ?? null })

test('sessions popup: live, pause, ready and many layouts in 4 tiers, light/dark', { timeout: 900_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-pausepop-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const resize = (w: number) => app!.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 800), w)

    const widths: [number, string][] = [[500, 'phone'], [900, 'narrow'], [1250, 'narrow'], [1280, 'desktop'], [2600, 'wide']]
    const SHOT_WIDTHS = new Set([500, 900, 1250])
    let alias = true

    /** Opens the popup at every width and scheme, checks the common layout, runs `check`, captures, closes. */
    async function round(mode: string, check: (tag: string, g: Geo, width: number) => Promise<void>, before?: () => Promise<void>): Promise<void> {
      for (const [width, tier] of widths) {
        await resize(width)
        for (const scheme of ['light', 'dark'] as const) {
          await setTheme(page, scheme)
          if (before) await before()
          const id = alias ? 'pause.manage' : 'sessions.manage'
          alias = false
          assert.equal(await page.evaluate(i => window.__tether.runCommand(i), id), 'ran')
          await page.waitForSelector(`${dlgSel}[open]`)
          await sleep(350)
          assert.equal(await page.locator(dlgSel).getAttribute('data-tier'), tier)
          const g = await geometry(page)
          const tag = `${mode} ${width}px ${scheme}`
          assert.equal(await page.locator(`${dlgSel} h2`).textContent(), 'Sessões em andamento')
          assert.ok(g.headParentIsDialog, `${tag}: header is a direct child of the dialog`)
          assert.ok(g.head && Math.abs(g.head.y - g.dlg.y) < 3 && g.head.w >= g.dlg.w - 4, `${tag}: header spans the top ${JSON.stringify(g.head)} in ${JSON.stringify(g.dlg)}`)
          assert.ok(g.xBtn && g.xBtn.x + g.xBtn.w >= g.dlg.x + g.dlg.w - 40, `${tag}: X at the right edge`)
          assert.ok(g.scrollW <= g.clientW + 1 && g.bodyScrollW <= g.bodyClientW + 1, `${tag}: no horizontal scroll (${g.scrollW}/${g.clientW}, ${g.bodyScrollW}/${g.bodyClientW})`)
          assert.ok(g.dlg.h >= 360 || tier === 'phone', `${tag}: dignified height (${g.dlg.h})`)
          assert.ok(g.dlg.y >= -1 && g.dlg.y + g.dlg.h <= 800 + 1 || tier === 'wide', `${tag}: inside the window (${JSON.stringify(g.dlg)})`)
          if (mode !== 'empty') {
            assert.ok(g.foot && g.foot.y + g.foot.h <= g.dlg.y + g.dlg.h + 1 && g.foot.h > 20, `${tag}: footer inside the dialog ${JSON.stringify(g.foot)}`)
            assert.ok(g.body.h >= 120, `${tag}: body keeps a usable height (${g.body.h})`)
            assert.equal(g.left.overflowY, 'auto', `${tag}: the list scrolls by itself`)
            assert.equal(g.right.overflowY, 'auto', `${tag}: the detail scrolls by itself`)
          }
          await check(tag, g, width)
          console.log('#', tag, JSON.stringify(g.dlg))
          if (SHOT_WIDTHS.has(width)) await page.screenshot({ path: join(shots, `sessions-${mode}-${width}-${scheme}.png`) })
          await page.locator(`${dlgSel} .pd-close`).click()
          await page.waitForFunction(() => document.querySelectorAll('dialog[data-dialog="sessions"][open]').length === 0)
        }
      }
    }

    // ---------- empty: no session at all ----------
    await round('empty', async (tag, g) => {
      assert.equal(g.footDisplay, 'none', `${tag}: no footer`)
      assert.match((await page.locator(`${dlgSel} .pd-empty`).textContent())!, /Nenhuma sessão em andamento/)
    })

    // ---------- six shells: 1 atenção · 2 em andamento · 3 ociosas, with and without a tab ----------
    await resize(1280)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await createShell(page, home))
    const [s0, s1, s2, s3, s4, s5] = ids as [string, string, string, string, string, string]
    await detachPane(page, s2); await detachPane(page, s4); await detachPane(page, s5)
    const names = ['api de pedidos', 'relatório mensal', 'migração do banco', 'documentação', 'site institucional', 'testes do app']
    for (const [i, id] of ids.entries()) await feed(page, id, { name: names[i]! })
    const live = async (): Promise<void> => {
      await feed(page, s0, { attention: 'waiting' })
      await feed(page, s1, { turn: 'busy' })
      await feed(page, s2, { turn: 'busy' })
      await feed(page, s3, { idleSince: ago(30 * MIN) })
      await feed(page, s4, { idleSince: ago(130 * MIN) })
      await feed(page, s5, { idleSince: ago(3 * MIN) })
    }

    // The daemon's first memory sample (a few seconds after the slots start) broadcasts every slot and would wipe what
    // feed() injects: let it land before injecting.
    await page.waitForFunction(ids => ids.every(id => (window.__tether.slots().find(s => s.slotId === id) as { memoryMB?: number } | undefined)?.memoryMB !== undefined), ids, { timeout: 30_000 })
    await sleep(1_000)

    // ---------- live: no pause, the preview of who would get the request ----------
    let invariantDone = false
    await round('live', async (tag, _g, width) => {
      assert.deepEqual(await texts(page, '.pd-gt span:first-child'), ['Pedem atenção', 'Em andamento', 'Ociosas'], `${tag}: groups`)
      assert.deepEqual(await texts(page, '.pd-gt .n'), ['1', '2', '3'], `${tag}: group counts`)
      assert.equal(await page.locator(`${dlgSel} .pd-row`).count(), 6, `${tag}: six sessions`)
      assert.equal(await page.locator(`${dlgSel} .pd-row.attention`).count(), 1)
      assert.equal(await page.locator(`${dlgSel} .pd-row.busy`).count(), 2)
      assert.equal(await page.locator(`${dlgSel} .pd-row.idle`).count(), 3)
      assert.equal(await page.locator(`${dlgSel} .pd-row .pg`).count(), 0, `${tag}: no pause glyph without a pause`)
      assert.equal((await texts(page, '.pd-line b'))[0]?.replace(/ · Memória das sessões vivas: .*$/, ''), 'Vão receber o pedido: 2 em andamento · 3 ociosas e 1 pedindo atenção não são afetadas', `${tag}: preview`)
      assert.equal((await texts(page, '.pd-start'))[0], 'Pedir pausa aos 2 em andamento')
      assert.equal(await page.locator(`${dlgSel} .pd-start`).isDisabled(), false)
      assert.equal(await page.locator(`${dlgSel} .pd-start`).isVisible(), true)
      assert.equal(await page.locator(`${dlgSel} .pd-resume`).isVisible(), false)
      assert.equal(await page.locator(`${dlgSel} .pd-cancel`).isVisible(), false)
      const noTab = await page.locator(`${dlgSel} .pd-row[data-slot="${s2}"] .cw`).textContent()
      assert.match(noTab!, /trabalhando agora(?: · [0-9,]+ [MG]B)? · sem guia · /, `${tag}: row of a session without a tab`)
      const withTab = await page.locator(`${dlgSel} .pd-row[data-slot="${s3}"] .cw`).textContent()
      assert.match(withTab!, /ocioso há 30 min · /, `${tag}: idle since`)
      assert.doesNotMatch(withTab!, /sem guia/, `${tag}: a session with a tab says where it is`)
      assert.match((await page.locator(`${dlgSel} .pd-row[data-slot="${s4}"] .cw`).textContent())!, /ocioso há 2 h(?: · [0-9,]+ [MG]B)? · sem guia/)
      // the first row is selected: its detail names the type, place, folder, session and state
      assert.match((await page.locator(`${dlgSel} .pd-facts`).textContent())!, /TipoShellOnde.*Pasta.*SessãoAinda sem sessão registradaEstadoPede atenção: espera uma resposta sua/)
      if (width === 1250 && !invariantDone) {
        invariantDone = true
        // Opening, selecting and Enter never act: no request leaves, no pause appears.
        for (const id of ids) {
          await page.locator(`${dlgSel} .pd-row[data-slot="${id}"]`).click()
          assert.equal(await page.locator(`${dlgSel} .pd-row.sel`).getAttribute('data-slot'), id)
        }
        assert.equal(await page.locator(`${dlgSel} .pd-row[data-slot="${s4}"]`).getAttribute('aria-selected'), 'false')
        await page.locator(`${dlgSel} .pd-row[data-slot="${s2}"]`).focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await page.keyboard.press('ArrowUp')
        await sleep(300)
        assert.equal(await batchOf(page), null, 'nothing was requested by looking around')
        for (const id of [s2, s4]) assert.equal((await page.evaluate(i => window.__tether.slots().find(x => x.slotId === i)!.status, id)), 'running', 'nothing was stopped')
        // select one without a tab and capture its detail (Abrir, Encerrar)
        await page.locator(`${dlgSel} .pd-row[data-slot="${s2}"]`).click()
        assert.deepEqual(await texts(page, '.pd-acts button'), ['Abrir', 'Encerrar'])
        assert.match((await page.locator(`${dlgSel} .pd-facts`).textContent())!, /OndeSem guia/)
        await page.screenshot({ path: join(shots, `sessions-live-detail-${width}-${await page.evaluate(() => document.documentElement.dataset.theme)}.png`) })
        await page.locator(`${dlgSel} .pd-row[data-slot="${s0}"]`).click()
      }
    }, live)

    // ---------- pause: three of the working sessions are in the batch ----------
    await feed(page, s3, { turn: 'busy' })
    await page.evaluate(ids => window.tether.request({ t: 'pause-start', slotIds: ids }), [s1, s2, s3])
    const say = async (slot: string, kind: 'ack' | 'done', text: string): Promise<void> => {
      let err = ''
      await cmdPause([kind, text], { out: () => {}, err: t => { err += t }, env: { TETHER_HOME: home, TETHER_SLOT_ID: slot } })
      assert.equal(err, '')
    }
    const stateOf = async (slot: string): Promise<string | undefined> => (await batchOf(page))?.entries.find(e => e.slotId === slot)?.state
    const waitState = async (slot: string, want: (st: string | undefined) => boolean): Promise<void> => {
      for (let i = 0; i < 60 && !want(await stateOf(slot)); i++) await sleep(250)
      assert.ok(want(await stateOf(slot)), `pause state of ${slot}: ${await stateOf(slot)}`)
    }
    await waitState(s1, st => st !== undefined)
    await say(s1, 'done', 'parei no passo 3 do relatório')
    await say(s2, 'ack', 'fechando a migração do banco')
    await waitState(s1, st => st === 'stopped')
    const paused = async (): Promise<void> => {
      await feed(page, s0, { attention: 'waiting' })
      await feed(page, s1, { turn: 'busy' }); await feed(page, s2, { turn: 'busy' }); await feed(page, s3, { turn: 'busy' })
      await feed(page, s4, { idleSince: ago(130 * MIN) })
      await feed(page, s5, { idleSince: ago(3 * MIN) })
    }
    await round('pause', async (tag) => {
      assert.deepEqual(await texts(page, '.pd-gt span:first-child'), ['Na pausa', 'Fora da pausa'], `${tag}: groups`)
      assert.equal(await page.locator(`${dlgSel} .pd-row.pz`).count(), 3, `${tag}: three in the pause`)
      assert.equal(await page.locator(`${dlgSel} .pd-row.pz .pg`).count(), 3, `${tag}: the pause glyph marks them`)
      assert.equal(await page.locator(`${dlgSel} .pd-group.g-outside .pd-row`).count(), 3, `${tag}: three outside`)
      assert.equal(await page.locator(`${dlgSel} .pd-group.g-outside .pg`).count(), 0)
      assert.match((await texts(page, '.pd-line b'))[0]!, /^1 de 3 já pararam$/, `${tag}: progress`)
      assert.equal(await page.locator(`${dlgSel} .pd-start`).isVisible(), false)
      assert.equal(await page.locator(`${dlgSel} .pd-resume`).isDisabled(), true, `${tag}: Retomar waits for everyone`)
      assert.equal(await page.locator(`${dlgSel} .pd-cancel`).isVisible(), true)
      assert.equal(await page.locator(`${dlgSel} .pd-prev`).isVisible(), false, `${tag}: no resume preview yet`)
      assert.match((await page.locator(`${dlgSel} .pd-row[data-slot="${s1}"] .cw`).textContent())!, /parei no passo 3/)
    }, paused)

    // ---------- ready: everyone stopped, the preview of who goes back ----------
    await say(s2, 'done', 'migração fechada, falta rodar os testes')
    await say(s3, 'done', 'escrevendo a documentação')
    await waitState(s2, st => st === 'stopped')
    await waitState(s3, st => st === 'stopped')
    const ready = async (): Promise<void> => {
      await feed(page, s0, { attention: 'waiting' })
      for (const id of [s1, s2, s3]) await feed(page, id, { idleSince: ago(MIN) })
      await feed(page, s4, { idleSince: ago(130 * MIN) })
      await feed(page, s5, { idleSince: ago(3 * MIN) })
    }
    await round('ready', async (tag) => {
      assert.match((await texts(page, '.pd-line b'))[0]!, /^3 de 3 já pararam$/, `${tag}: all stopped`)
      assert.equal((await texts(page, '.pd-prev'))[0], 'Vão voltar: 3, cada uma com sua nota', `${tag}: resume preview`)
      assert.equal(await page.locator(`${dlgSel} .pd-resume`).isDisabled(), false)
      assert.match(await page.locator(`${dlgSel} .pd-resume`).getAttribute('class') ?? '', /ready/)
      assert.equal(await page.locator(`${dlgSel} .pd-row.pz.stopped`).count(), 3)
    }, ready)

    // one of them became busy and another waits for the user meanwhile: they will not go back, and the preview says why
    await resize(1250)
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      await ready()
      await feed(page, s2, { turn: 'busy' })
      await feed(page, s3, { attention: 'waiting' })
      await page.evaluate(() => window.__tether.runCommand('sessions.manage'))
      await page.waitForSelector(`${dlgSel}[open]`)
      await sleep(300)
      assert.equal((await texts(page, '.pd-prev'))[0], 'Vai voltar: 1, com a sua nota · 2 não voltam: 1 ocupada, 1 esperando você')
      await page.screenshot({ path: join(shots, `sessions-ready-skip-1250-${scheme}.png`) })
      await page.locator(`${dlgSel} .pd-close`).click()
      await page.waitForFunction(() => document.querySelectorAll('dialog[data-dialog="sessions"][open]').length === 0)
    }

    // ---------- many: 20 live sessions, no pause ----------
    await page.evaluate(() => window.tether.request({ t: 'pause-cancel' }))
    await sleep(400)
    assert.equal(await batchOf(page), null)
    await page.evaluate(({ at, base }) => {
      for (let i = 0; i < 14; i++) {
        const state = i % 5 === 0 ? { turn: 'busy' } : i % 7 === 0 ? { attention: 'done' } : { idleSince: new Date(at - (5 + i * 11) * 60_000).toISOString() }
        window.__tether.applyState({ slotId: `fake-${i}`, kind: 'shell', cwd: `${base}\\projetos\\cliente-${i}\\servico-${i % 3}`, status: 'running', name: `sessão de exemplo ${i + 1}`, ...state } as unknown as SlotState)
      }
    }, { at: Date.now(), base: home })
    await round('many', async (tag, g) => {
      assert.equal(await page.locator(`${dlgSel} .pd-row`).count(), 20, `${tag}: twenty live sessions`)
      assert.ok(g.left.scrollH > g.left.clientH + 20, `${tag}: the list overflows and scrolls (${g.left.scrollH}/${g.left.clientH})`)
      const last = page.locator(`${dlgSel} .pd-row`).last()
      await last.scrollIntoViewIfNeeded()
      await last.click()
      const geo = await geometry(page)
      assert.ok(geo.foot && geo.foot.y + geo.foot.h <= geo.dlg.y + geo.dlg.h + 1, `${tag}: footer stays in view after scrolling`)
      assert.equal(await page.locator(`${dlgSel} .pd-row.sel`).getAttribute('data-slot'), await last.getAttribute('data-slot'))
      assert.match((await texts(page, '.pd-line b'))[0]!, /^Vão receber o pedido: \d+ em andamento · /)
      await page.locator(`${dlgSel} .pd-left`).evaluate((e: any) => { e.scrollTop = 0 })
    }, live)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
