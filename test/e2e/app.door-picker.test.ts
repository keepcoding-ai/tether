// E2E of the list picker (agent door, slice R4) with the door-probe extension (TETHER_TEST_EXTENSIONS=1): a tetherd in this process
// on a private home and pipe, the real app on the same pipe, hidden window. No agent process, no LLM.
//   1. the featured row is on top, apart, selected when the box opens; the field has the focus;
//   2. typing filters, the arrows wrap, Enter chooses; Esc in the first step closes and resolves nothing; a click outside closes;
//      the focus goes back to what had it;
//   3. two steps: Esc in the second goes back to the first (query and choice kept), Enter in the second resolves both;
//   4. a list that loads late shows "Carregando…", one that fails says so; a newer picker takes the place of an open one;
//   5. a command called with an argument skips the picker, one called without opens it.
//   6. (K1.6) rows with a group go under its heading, groups in the order they first appear; 1 to 9 choose a row while the
//      filter is empty and type otherwise. With TETHER_K1_PRINTS set to a folder, a print of the grouped picker (light theme).
// With TETHER_PICKER_PRINTS set to a folder, two prints (light and dark theme, first step open) go there.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  openSlot(id: string): Promise<void>
  ext: Record<string, Record<string, unknown>>
}
declare const window: { __tether: Hooks; __opener?: Element | null; tether: { request(r: unknown): Promise<{ slot?: { slotId: string } }> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')

before(() => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
})

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

/** Runs `body` with the app on a private daemon; everything is closed after, by identity. */
async function withApp(body: (page: Page, home: string) => Promise<void>): Promise<void> {
  const home = tempHome()
  const pipe = uniquePipe(home)
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, log: () => {} })
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await body(page, home)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await daemon.close()
    await removeHome(home)
  }
}

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ name, args }) => (window.__tether.ext['door-probe']![name] as unknown as (...a: unknown[]) => unknown)(...args) as never, { name, args })

const box = (page: Page) => page.locator('dialog.picker')
const rows = (page: Page) => page.locator('dialog.picker li.pk-item')
const rowTexts = (page: Page): Promise<string[]> => rows(page).locator('.pk-label').allInnerTexts()
const selectedText = (page: Page): Promise<string> => page.locator('dialog.picker li.pk-item.selected .pk-label').innerText()
const results = (page: Page): Promise<unknown[]> => probe(page, 'pickResults')
const waitResults = (page: Page, n: number): Promise<unknown> => page.waitForFunction(n => (window.__tether.ext['door-probe']!.pickResults as () => unknown[])().length >= n, n)
const opened = (page: Page): Promise<unknown> => box(page).locator('input').waitFor({ state: 'visible' })
const closed = (page: Page): Promise<unknown> => page.waitForFunction(() => !document.querySelector('dialog.picker[open]'))
const titleIs = (page: Page, title: string): Promise<unknown> => page.waitForFunction(t => document.querySelector('dialog.picker .pk-title')?.textContent === t, title)
const stepIs = (page: Page, step: string): Promise<unknown> => page.waitForFunction(s => document.querySelector('dialog.picker .pk-step')?.textContent?.startsWith(s), step)

test('door picker: featured row, filter, keys, back and close, focus, argument command', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    assert.ok(await page.evaluate(() => [...document.styleSheets].some(sheet => (sheet.href ?? '').endsWith('door/picker.css'))), 'index.html links picker.css')
    assert.equal(await box(page).count(), 0, 'nothing is drawn before a command asks')

    // A terminal pane holds the focus: it is the "who opened" that must get it back.
    const shellId = await page.evaluate(async cwd => (await window.tether.request({ t: 'create', kind: 'shell', cwd, name: 'SondaSeletor', start: false })).slot!.slotId, home)
    await page.waitForTimeout(500)
    await page.evaluate(id => window.__tether.openSlot(id), shellId)
    await page.locator('.tether-tab', { hasText: 'SondaSeletor' }).first().click()
    await page.locator(`.panel[data-slot-id="${shellId}"] .panel-term`).click()
    const holdFocus = (): Promise<string> => page.evaluate(() => { window.__opener = document.activeElement; return document.activeElement?.tagName ?? '' })
    const focusBack = (): Promise<boolean> => page.evaluate(() => document.activeElement === window.__opener)
    assert.notEqual(await holdFocus(), 'BODY', 'something real has the focus before the picker opens')

    // ---- 1. the featured row: on top, apart, selected; the field has the focus ----
    await probe(page, 'pickStart', 'list')
    await opened(page)
    assert.equal(await box(page).locator('.pk-title').innerText(), 'Juntar ao canal')
    assert.deepEqual(await rowTexts(page), ['Canal da mesa', 'Canal geral', 'Obras da casa', 'Cozinha'])
    assert.equal(await rows(page).first().evaluate(el => el.classList.contains('featured')), true)
    assert.equal(await page.locator('dialog.picker li.pk-sep').count(), 1, 'a rule sets the featured row apart')
    assert.equal(await rows(page).first().getAttribute('aria-selected'), 'true', 'the featured row is selected on opening')
    assert.equal(await selectedText(page), 'Canal da mesa')
    assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog.picker') !== null && document.activeElement?.tagName === 'INPUT'), true, 'the field has the focus')
    assert.equal(await page.locator('dialog.picker li.pk-item.hued').count(), 3, 'the rows with a hue wear it (the featured one and two channels)')

    const dir = process.env.TETHER_PICKER_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme)
        await page.waitForTimeout(300)
        const b = (await box(page).boundingBox())!
        await page.screenshot({ path: join(dir, `r4-seletor-${scheme}.png`), clip: { x: Math.max(0, b.x - 40), y: Math.max(0, b.y - 24), width: b.width + 80, height: b.height + 48 } })
      }
    }

    // ---- 2. keys: the arrows wrap, typing filters, Enter chooses ----
    await page.keyboard.press('ArrowUp')
    assert.equal(await selectedText(page), 'Cozinha', 'ArrowUp from the top wraps to the last')
    await page.keyboard.press('ArrowDown')
    assert.equal(await selectedText(page), 'Canal da mesa', 'ArrowDown from the last wraps to the featured')
    await page.keyboard.type('obr')
    assert.deepEqual(await rowTexts(page), ['Obras da casa'])
    assert.equal(await selectedText(page), 'Obras da casa')
    await page.keyboard.press('Control+A'); await page.keyboard.type('zzzz')
    assert.equal(await rows(page).count(), 0)
    assert.match(await box(page).locator('.pk-empty').innerText(), /Nada para “zzzz”/)
    await page.keyboard.press('Control+A'); await page.keyboard.type('coz')
    await page.keyboard.press('Enter')
    await closed(page)
    await waitResults(page, 1)
    assert.deepEqual(await results(page), ['cozinha'])
    assert.ok(await focusBack(), 'the focus went back to what had it')

    // Esc in the first step closes and resolves nothing.
    await probe(page, 'pickStart', 'list')
    await opened(page)
    await page.keyboard.press('Escape')
    await closed(page)
    await waitResults(page, 2)
    assert.deepEqual(await results(page), ['cozinha', null])
    assert.ok(await focusBack(), 'the focus went back after Esc')

    // A click outside closes too.
    await probe(page, 'pickStart', 'list')
    await opened(page)
    await page.mouse.click(4, 4)
    await closed(page)
    await waitResults(page, 3)
    assert.equal((await results(page))[2], null)
    assert.ok(await focusBack(), 'the focus went back after a click outside')

    // A click on a row chooses it.
    await probe(page, 'pickStart', 'list')
    await opened(page)
    await rows(page).filter({ hasText: 'Canal geral' }).click()
    await closed(page)
    await waitResults(page, 4)
    assert.equal((await results(page))[3], 'geral')

    // ---- 3. two steps ----
    await probe(page, 'pickStart', 'steps')
    await opened(page)
    assert.equal(await box(page).locator('.pk-title').innerText(), 'Dar a guia a um agente')
    assert.equal(await box(page).locator('.pk-step').innerText(), '1 de 2')
    await page.keyboard.type('dois')
    assert.equal(await selectedText(page), 'Agente Dois')
    await page.keyboard.press('Enter')
    await titleIs(page, 'Canal de claude-2')
    assert.equal(await box(page).locator('.pk-step').innerText(), '2 de 2 · Agente Dois')
    assert.equal(await page.locator('dialog.picker input').inputValue(), '', 'the second step starts with an empty field')
    assert.equal(await selectedText(page), 'Canal da mesa', 'the featured row of the second step is selected')
    assert.equal(await page.locator('dialog.picker[open]').count(), 1, 'one box for both steps')
    // Esc in the second step goes back to the first, query and choice kept; nothing resolved.
    await page.keyboard.press('Escape')
    await titleIs(page, 'Dar a guia a um agente')
    assert.equal(await page.locator('dialog.picker input').inputValue(), 'dois', 'the first step comes back with what was typed')
    assert.equal(await selectedText(page), 'Agente Dois')
    assert.equal((await results(page)).length, 4, 'going back resolves nothing')
    await page.keyboard.press('Enter')
    await titleIs(page, 'Canal de claude-2')
    await page.keyboard.press('ArrowDown')
    assert.equal(await selectedText(page), 'Canal geral')
    await page.keyboard.press('Enter')
    await closed(page)
    await waitResults(page, 5)
    assert.deepEqual((await results(page))[4], { first: 'claude-2', second: 'geral' })
    assert.deepEqual(await probe(page, 'pickBuilt'), ['claude-2', 'claude-2'])
    assert.ok(await focusBack(), 'the focus went back after two steps')

    // Esc twice (second, then first) closes everything with nothing resolved.
    await probe(page, 'pickStart', 'steps')
    await opened(page)
    await page.keyboard.press('Enter')
    await stepIs(page, '2 de 2')
    await page.keyboard.press('Escape')
    await stepIs(page, '1 de 2')
    await page.keyboard.press('Escape')
    await closed(page)
    await waitResults(page, 6)
    assert.equal((await results(page))[5], null)
    // A click outside in the second step closes everything at once.
    await probe(page, 'pickStart', 'steps')
    await opened(page)
    await page.keyboard.press('Enter')
    await stepIs(page, '2 de 2')
    await page.mouse.click(4, 4)
    await closed(page)
    await waitResults(page, 7)
    assert.equal((await results(page))[6], null)

    // ---- 4. a list that loads late, one that fails, a newer picker over an open one ----
    await probe(page, 'pickStart', 'slow')
    await opened(page)
    assert.equal(await box(page).locator('.pk-empty').innerText(), 'Carregando…')
    await rows(page).first().waitFor()
    assert.equal(await rows(page).count(), 3)
    await page.keyboard.press('Enter')
    await closed(page)
    await waitResults(page, 8)
    assert.equal((await results(page))[7], 'geral')
    await probe(page, 'pickStart', 'failing')
    await opened(page)
    await page.waitForFunction(() => document.querySelector('dialog.picker .pk-empty')?.textContent === 'Não foi possível montar a lista.')
    await page.keyboard.press('Escape')
    await closed(page)
    await waitResults(page, 9)
    assert.equal((await results(page))[8], null)
    await probe(page, 'pickStart', 'list')
    await opened(page)
    await probe(page, 'pickStart', 'steps')
    await waitResults(page, 10)
    assert.equal((await results(page))[9], null, 'the picker that was open resolves as closed when a newer one takes the place')
    await titleIs(page, 'Dar a guia a um agente')
    assert.equal(await page.locator('dialog.picker[open]').count(), 1)
    await page.keyboard.press('Escape')
    await closed(page)
    await waitResults(page, 11)
    assert.ok(await focusBack(), 'the focus went back after the replaced picker closed')

    // ---- 5. a command with an argument skips the picker; without one it opens ----
    await probe(page, 'runJoin', 'cozinha')
    await waitResults(page, 13)
    assert.deepEqual((await results(page)).slice(11), ['direct:cozinha', 'command:ran'])
    assert.equal(await page.locator('dialog.picker[open]').count(), 0, 'the argument skipped the picker')
    await probe(page, 'runJoin')
    await opened(page)
    assert.equal(await box(page).locator('.pk-title').innerText(), 'Juntar ao canal')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await closed(page)
    await waitResults(page, 15)
    assert.deepEqual((await results(page)).slice(13), ['picked:obras', 'command:ran'])
    assert.ok(await focusBack(), 'the focus went back after the command')
  })
})

test('door picker: the person\'s tab emblem at the right end of a row, and panes.personEmblem', { timeout: 300_000 }, async () => {
  await withApp(async (page, home) => {
    const shell = async (name: string): Promise<string> => {
      const id = await page.evaluate(async ([cwd, n]) => (await window.tether.request({ t: 'create', kind: 'shell', cwd: cwd!, name: n!, start: false })).slot!.slotId, [home, name] as const)
      await page.waitForTimeout(300)
      await page.evaluate(i => window.__tether.openSlot(i), id)
      return id
    }
    const worn = await shell('GuiaComEmblema')
    const bare = await shell('GuiaSemEmblema')
    assert.equal(await probe(page, 'personEmblem', worn), null, 'no emblem before the person puts one')
    await probe(page, 'wearEmblem', worn, 'b-deploy')
    assert.deepEqual(await probe(page, 'personEmblem', worn), { name: 'Deploy', color: 'teal', icon: 'rocket-launch' })
    assert.equal(await probe(page, 'personEmblem', bare), null)
    assert.equal(await probe(page, 'personEmblem', 'no-such-pane'), null)

    await probe(page, 'pickEmblems', [bare, worn])
    await opened(page)
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 2)
    assert.deepEqual(await rowTexts(page), ['atrium', 'atrium'], 'two rows share the name')
    const chips = rows(page).nth(1).locator('.pk-emblem')
    assert.equal(await rows(page).nth(0).locator('.pk-emblem').count(), 0, 'a row without an emblem has no chip')
    assert.equal(await chips.count(), 1)
    assert.equal(await chips.getAttribute('title'), 'Deploy')
    assert.equal(await chips.getAttribute('aria-label'), 'Deploy')
    assert.equal(await rows(page).nth(1).evaluate(li => li.lastElementChild?.classList.contains('pk-emblem')), true, 'the chip is the last thing in the row')
    assert.equal(await chips.locator('use').getAttribute('href'), '#emb-rocket-launch')

    // The filter finds the row by the emblem's name.
    await page.keyboard.type('deploy')
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 1)
    assert.equal(await rows(page).first().locator('.pk-emblem').count(), 1)
    await page.keyboard.press('Enter')
    await closed(page)
    await page.waitForFunction(() => (window.__tether.ext['door-probe']!.pickEmblemResults as () => unknown[])().length >= 1)
    assert.deepEqual(await probe(page, 'pickEmblemResults'), [worn])
  })
})

test('door picker: pick.many marks several (Space, click, Enter, button, Esc)', { timeout: 300_000 }, async () => {
  await withApp(async page => {
    const manyResults = (): Promise<unknown[]> => probe(page, 'pickManyResults')
    const waitMany = (n: number): Promise<unknown> => page.waitForFunction(n => (window.__tether.ext['door-probe']!.pickManyResults as () => unknown[])().length >= n, n)
    const marked = (): Promise<string[]> => rows(page).evaluateAll(els => els.filter(e => e.getAttribute('aria-selected') === 'true').map(e => e.querySelector('.pk-label')!.textContent!))
    const start = async (): Promise<void> => { await probe(page, 'pickManyStart'); await opened(page); await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 3) }
    const confirm = box(page).locator('.pk-confirm')

    // Enter with no mark answers with the row under the cursor alone; the box says the keys and counts.
    await start()
    assert.equal(await box(page).locator('ul.pk-list').getAttribute('aria-multiselectable'), 'true')
    assert.equal(await box(page).locator('.pk-hint').innerText(), 'Espaço marca vários · Enter junta · Esc fecha')
    assert.equal(await confirm.innerText(), 'Juntar 1')
    assert.equal(await box(page).locator('li.pk-item kbd.pk-num').count(), 0, 'no number keys in a many box')
    assert.deepEqual(await box(page).locator('li.pk-group').allInnerTexts().then(t => t.map(x => x.toLowerCase())), ['nesta mesa · obra', 'mesa · pesquisa'])
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await closed(page)
    await waitMany(1)
    assert.deepEqual((await manyResults())[0], ['dois'])

    // Space marks (the cursor stays), two marks come back in the list's order, the button counts.
    await start()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    assert.deepEqual(await marked(), ['codex · conferência'])
    assert.equal(await confirm.innerText(), 'Juntar 1')
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Space')
    assert.deepEqual(await marked(), ['claude · conferente', 'codex · conferência'])
    assert.equal(await confirm.innerText(), 'Juntar 2')
    assert.equal(await box(page).locator('input').inputValue(), '', 'Space marked, it did not type')
    const dir = process.env.TETHER_G6_PRINTS
    if (dir) { mkdirSync(dir, { recursive: true }); await page.waitForTimeout(300); await box(page).screenshot({ path: join(dir, 'g6-marcar.png') }) }
    // A filter hides a marked row without dropping the mark; Enter answers with both marks.
    await page.keyboard.type('soul')
    assert.deepEqual(await rowTexts(page), ['soul · bancada'])
    assert.equal(await confirm.innerText(), 'Juntar 2')
    await page.keyboard.press('Enter')
    await closed(page)
    await waitMany(2)
    assert.deepEqual((await manyResults())[1], ['um', 'tres'])

    // A click marks; the button confirms; a click away from the keys keeps the field's focus.
    await start()
    await rows(page).filter({ hasText: 'soul' }).click()
    await rows(page).filter({ hasText: 'codex' }).click()
    assert.deepEqual(await marked(), ['soul · bancada', 'codex · conferência'])
    await rows(page).filter({ hasText: 'soul' }).click()
    assert.deepEqual(await marked(), ['codex · conferência'])
    await rows(page).filter({ hasText: 'soul' }).click()
    await confirm.click()
    await closed(page)
    await waitMany(3)
    assert.deepEqual((await manyResults())[2], ['dois', 'tres'])

    // A double click confirms with that row marked.
    await start()
    await rows(page).filter({ hasText: 'claude' }).dblclick()
    await closed(page)
    await waitMany(4)
    assert.deepEqual((await manyResults())[3], ['um'])

    // Esc and a click outside resolve undefined.
    await start()
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
    await closed(page)
    await waitMany(5)
    assert.equal((await manyResults())[4], null)
    await start()
    await page.mouse.click(4, 4)
    await closed(page)
    await waitMany(6)
    assert.equal((await manyResults())[5], null)

    // The list picker is as before: no footer, no marks.
    await probe(page, 'pickStart', 'list')
    await opened(page)
    assert.equal(await box(page).locator('.pk-foot').isVisible(), false)
    assert.equal(await box(page).locator('ul.pk-list').getAttribute('aria-multiselectable'), null)
    assert.equal(await box(page).locator('.pk-check').count(), 0)
    await page.keyboard.press('Escape')
    await closed(page)
  })
})

test('door picker K1.6: group headings and the number keys',{ timeout: 300_000 }, async () => {
  await withApp(async page => {
    const groupResults = (): Promise<unknown[]> => probe(page, 'pickGroupResults')
    const numbers = (): Promise<string[]> => rows(page).locator('kbd.pk-num').allInnerTexts()

    // A picker without groups (the probe's R4 one) draws no heading.
    await probe(page, 'pickStart', 'list')
    await opened(page)
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length > 0)
    assert.equal(await box(page).locator('li.pk-group').count(), 0, 'no group, no heading')
    await page.keyboard.press('Escape')
    await closed(page)

    // ---- the groups: headings in the order they first appear, the rows under them ----
    await probe(page, 'pickGroups')
    await opened(page)
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 4)
    assert.deepEqual(await box(page).locator('li.pk-group').evaluateAll(els => els.map(e => e.textContent)), ['Recentes', 'Nesta mesa', 'Outras mesas'])
    assert.deepEqual(await rowTexts(page), ['Atrium · Claude', 'kai · Claude', 'soul · bancada', 'codex · revisão'])
    assert.deepEqual(await box(page).locator('ul.pk-list > li').evaluateAll(els => els.map(e => e.classList.contains('pk-group') ? `# ${e.textContent}` : e.querySelector('.pk-label')?.textContent)),
      ['# Recentes', 'Atrium · Claude', '# Nesta mesa', 'kai · Claude', 'soul · bancada', '# Outras mesas', 'codex · revisão'])
    assert.deepEqual(await numbers(), ['1', '2', '3', '4'], 'each row shows its number key')
    assert.equal(await selectedText(page), 'Atrium · Claude', 'the first row is selected')
    const dir = process.env.TETHER_K1_PRINTS
    if (dir) {
      mkdirSync(dir, { recursive: true })
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
      await page.waitForTimeout(300)
      await box(page).screenshot({ path: join(dir, 'k1.6-seletor-em-grupos-light.png') })
    }
    // A query ranks inside each group; the headings stay; the numbers go (a digit types).
    await page.keyboard.type('c')
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker kbd.pk-num').length === 0)
    await page.keyboard.press('2')
    assert.equal(await box(page).locator('input').inputValue(), 'c2', 'with text in the filter a digit types')
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker kbd.pk-num').length === 4)
    // 3 chooses the third row at once.
    await page.keyboard.press('3')
    await closed(page)
    await page.waitForFunction(() => (window.__tether.ext['door-probe']!.pickGroupResults as () => unknown[])().length >= 1)
    assert.deepEqual(await groupResults(), ['soul'], 'the key 3 chose the third row')

    // A key past the last row chooses nothing and types.
    await probe(page, 'pickGroups')
    await opened(page)
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 4)
    await page.keyboard.press('7')
    assert.equal(await box(page).locator('input').inputValue(), '7')
    await page.keyboard.press('Escape')
    await closed(page)
    await page.waitForFunction(() => (window.__tether.ext['door-probe']!.pickGroupResults as () => unknown[])().length >= 2)
    assert.deepEqual(await groupResults(), ['soul', null])
  })
})
