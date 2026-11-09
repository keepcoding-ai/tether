// E2E of the "Acompanhar a pausa" popup layout, no Claude needed (powershell panes stand in for the agents): opens it with
// pause.manage WITHOUT a batch and WITH one, in the four tiers (500/900/1250/1280/2600 px wide), light and dark. Asserts the
// header is a direct child of the dialog on top (never inside the grid), no horizontal scroll, a dignified height, and the
// empty state has no footer. Captures go to PAUSE_POPUP_DIR (default D:/atrium/.tmp/popup-proof, outside the repo).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

declare const window: { __tether: { panelIds(): string[]; connection(): { pid?: number } | undefined; runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'> }; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelectorAll(s: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PAUSE_POPUP_DIR ?? 'D:/atrium/.tmp/popup-proof'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-pausepop-${process.pid}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

interface Box { x: number; y: number; w: number; h: number }
interface Geo { dlg: Box; head: Box | null; headParentIsDialog: boolean; xBtn: Box | null; scrollW: number; clientW: number; footDisplay: string | null; bodyScrollW: number; bodyClientW: number }
async function geometry(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const g = globalThis as any
    const d = g.document.querySelector('dialog[data-dialog="pause"]')
    const r = (e: any): Box => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    const head = d.querySelector('header'), x = d.querySelector('.pd-close'), foot = d.querySelector('.pd-foot'), body = d.querySelector('.pd-body')
    return {
      dlg: r(d), head: head ? r(head) : null, headParentIsDialog: head?.parentElement === d, xBtn: x ? r(x) : null,
      scrollW: d.scrollWidth, clientW: d.clientWidth, footDisplay: foot ? g.getComputedStyle(foot).display : null,
      bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth,
    }
  })
}

test('pause popup: empty and batch layouts in 4 tiers, light/dark', { timeout: 300_000 }, async () => {
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
    async function round(mode: 'empty' | 'batch'): Promise<void> {
      for (const [width, tier] of widths) {
        await resize(width)
        for (const scheme of ['light', 'dark'] as const) {
          await setTheme(page, scheme)
          assert.equal(await page.evaluate(() => window.__tether.runCommand('pause.manage')), 'ran')
          await page.waitForSelector('dialog[data-dialog="pause"][open]')
          await sleep(350)
          assert.equal(await page.locator('dialog[data-dialog="pause"]').getAttribute('data-tier'), tier)
          const g = await geometry(page)
          const tag = `${mode} ${width}px ${scheme}`
          assert.ok(g.headParentIsDialog, `${tag}: header is a direct child of the dialog`)
          assert.ok(g.head && Math.abs(g.head.y - g.dlg.y) < 3 && g.head.w >= g.dlg.w - 4, `${tag}: header spans the top ${JSON.stringify(g.head)} in ${JSON.stringify(g.dlg)}`)
          assert.ok(g.xBtn && g.xBtn.x + g.xBtn.w >= g.dlg.x + g.dlg.w - 40, `${tag}: X at the right edge`)
          assert.ok(g.scrollW <= g.clientW + 1 && g.bodyScrollW <= g.bodyClientW + 1, `${tag}: no horizontal scroll (${g.scrollW}/${g.clientW}, ${g.bodyScrollW}/${g.bodyClientW})`)
          console.log('#', tag, JSON.stringify(g.dlg))
          assert.ok(g.dlg.h >= 360 || tier === 'phone', `${tag}: dignified height (${g.dlg.h})`)
          if (mode === 'empty') {
            assert.equal(g.footDisplay, 'none', `${tag}: no footer`)
            assert.match((await page.locator('dialog[data-dialog="pause"] .pd-empty').textContent())!, /Nenhuma pausa em andamento/)
          } else assert.notEqual(g.footDisplay, 'none', `${tag}: footer present`)
          await page.screenshot({ path: join(shots, `popup-${mode}-${width}-${scheme}.png`) })
          await page.locator('dialog[data-dialog="pause"] .pd-close').click()
          await page.waitForFunction(() => document.querySelectorAll('dialog[data-dialog="pause"][open]').length === 0)
        }
      }
    }
    await round('empty')

    // two shell panes stand in for the agents of a batch
    for (let i = 0; i < 2; i++) {
      await resize(1280)
      await page.click('#btn-new')
      await page.waitForSelector('#dlg-new[open]')
      await page.fill('#dlg-new .ch-path-input', home)
      await page.click('#dlg-new .ch-item[data-id="powershell"]')
      await page.click('#dlg-new .btn.primary.go')
      await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
      await page.waitForFunction(n => window.__tether.panelIds().length === n, i + 1)
    }
    const ids = await page.evaluate(() => window.__tether.panelIds())
    await page.evaluate(ids => window.tether.request({ t: 'pause-start', slotIds: ids }), ids)
    await sleep(500)
    await round('batch')
    await page.evaluate(() => window.tether.request({ t: 'pause-cancel' }))
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
