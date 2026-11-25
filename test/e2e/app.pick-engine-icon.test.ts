// E2E of the engine icon in the lists that choose an agent: a tetherd in this process on a private home and pipe, four fake agents
// (two "kai", two "leida": a claude and a soul each, no LLM), the real app on the same pipe, hidden window. Nothing touches the
// person's tether.
//   1. "Dar esta guia a um agente…": every row has the engine's icon (title and aria-label "Claude" / "soul") in a fixed column,
//      and the icon, the avatar and the name sit at the same x in a row with an emblem and in one without; the emblem's slot is
//      the same x too; typing the engine's name filters by it;
//   2. the channel's member list shows each member's engine in the place the generic robot was;
//   3. "Juntar agente…" (the many box) has the same column; the "@" list of the speaking box too.
// Pictures go to C:/atrium/.tmp/tether-agents/onda-3/espiar/. Run alone: node --test test/e2e/app.pick-engine-icon.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  ext: { channels: { run(id: string, arg?: unknown): void; wearEmblem(paneId: string, emblemId: string | undefined): void } }
}
declare const window: { __tether: Hooks; innerWidth: number }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/espiar'

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

test('engine icon: the agent lists show it in a fixed column, the members and the "@" list too', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()

  const fakeOf = (name: 'claude' | 'soul'): AgentAdapter => ({
    name,
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = join(home, `echo-${input.slot.slotId}.log`)
      env.CHAN_LOG = join(home, `chan-${input.slot.slotId}.log`)
      env.OPEN_STREAM = '0'
      return { command: process.execPath, args: [AGENT], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async b => b.title,
  })
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  contribution.channels = () => []

  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fakeOf('claude'), soul: fakeOf('soul') }, channelOf: () => undefined, door,
    log: m => logs.push(m),
  })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  let app: ElectronApplication | undefined
  try {
    const running = async (kind: 'claude' | 'soul', name: string): Promise<string> => {
      const id = (await doorApi.slots.create({ kind, cwd: home, name, desk: 'desk-1' })).slotId
      await waitUntil(() => doorApi.slots.get(id)?.status === 'running' && doorApi.slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
      return id
    }
    const kaiClaude = await running('claude', 'kai')
    const kaiSoul = await running('soul', 'kai')
    const leidaClaude = await running('claude', 'leida')
    const leidaSoul = await running('soul', 'leida')

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1600, 900) })
    await page.waitForFunction(() => window.innerWidth >= 1500)
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.run === 'function')
    for (const id of [kaiClaude, kaiSoul, leidaClaude, leidaSoul]) await page.waitForFunction(p => window.__tether.panelIds().includes(p), id)
    const picker = page.locator('dialog.picker[open]')
    const rows = picker.locator('li.pk-item')
    const rect = (loc: ReturnType<Page['locator']>, sel: string): Promise<number[]> => loc.evaluateAll((lis, s) => lis.map(li => {
      const e = li.querySelector(s); return e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : -1
    }), sel)
    const allSame = (xs: number[], what: string): void => { assert.ok(xs.length > 0 && xs.every(x => x >= 0), `${what}: every row has it (${xs.join(', ')})`); assert.equal(new Set(xs).size, 1, `${what}: the same x in every row (${xs.join(', ')})`) }

    // ---- 1. "Dar esta guia a um agente…" on the tab of leida (claude) ----
    await page.evaluate(p => window.__tether.ext.channels.wearEmblem(p, 'b-deploy'), kaiSoul) // an emblem on one row only
    await page.waitForTimeout(300) // the picker reads the emblem when it opens: its chip is what is asserted below
    await page.locator(`.tether-tab[data-slot="${leidaClaude}"]`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu li')
    await page.locator('#ctx-menu li', { hasText: 'Dar esta guia a um agente…' }).click()
    await picker.waitFor()
    await rows.first().waitFor()
    assert.equal(await rows.count(), 4, 'the four agents (the pane itself is offered: "ela mesma")')
    const titles = await rows.evaluateAll(lis => lis.map(li => li.querySelector('.pk-engine')?.getAttribute('title') ?? ''))
    assert.deepEqual(titles.slice().sort(), ['Claude', 'Claude', 'soul', 'soul'], `each row names its engine (${titles.join(', ')})`)
    assert.deepEqual(await rows.evaluateAll(lis => lis.map(li => li.querySelector('.pk-engine')?.getAttribute('aria-label') ?? '')), titles, 'aria-label = title')
    assert.ok((await rows.evaluateAll(lis => lis.map(li => li.querySelectorAll('.pk-engine svg').length))).every(n => n === 1), 'an icon drawn in each engine cell')
    allSame(await rect(rows, '.pk-engine'), 'engine icon')
    assert.equal(await picker.locator('.pk-emblem').count(), 1, 'one row wears an emblem')
    // The emblem stands in the avatar's place (the letter's, in the rows without one): nothing moves when it comes or goes.
    const avatars = await rows.evaluateAll(lis => lis.map(li => { const e = li.querySelector('.pk-emblem, .pk-icon'); return e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : -1 }))
    allSame(avatars, 'avatar or emblem')
    allSame(await rect(rows, '.pk-label'), 'name')
    await page.screenshot({ path: join(SHOTS, 'icone-motor-seletor.png'), clip: await picker.evaluate(d => { const r = d.getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 } }) })
    // The filter finds agents by the engine's name.
    await page.keyboard.type('soul')
    await page.waitForFunction(() => document.querySelectorAll('dialog.picker li.pk-item').length === 2)
    assert.deepEqual(await rows.evaluateAll(lis => lis.map(li => li.querySelector('.pk-engine')?.getAttribute('title'))), ['soul', 'soul'])
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // ---- 2. the channel: members with their engines ----
    const made = await ch.create(USER, { name: 'horizontes' })
    assert.ok(made.ok)
    const hz = made.channel.id
    assert.ok((await ch.join(USER, hz, kaiClaude)).ok)
    assert.ok((await ch.join(USER, hz, leidaSoul)).ok)
    await page.evaluate(i => window.__tether.ext.channels.run('channels.open', { channel: i }), hz)
    const pane = page.locator(`.ch-pane[data-channel="${hz}"]`)
    await pane.waitFor()
    if (!(await pane.locator('.ch-members').isVisible())) await pane.locator('.ch-bar button[aria-label="Membros"]').click()
    const em = (id: string) => pane.locator(`.ch-mrow[data-member="${id}"] .ch-em`)
    await em(kaiClaude).waitFor()
    assert.equal(await em(kaiClaude).getAttribute('title'), 'Claude')
    assert.equal(await em(leidaSoul).getAttribute('title'), 'soul')
    assert.equal(await em(kaiClaude).getAttribute('aria-label'), 'Claude')
    const mx = await pane.locator('.ch-mrow[data-member] .ch-em').evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().left * 10) / 10))
    assert.equal(new Set(mx).size, 1, `the engine icon sits at the same x in every member row (${mx.join(', ')})`)
    assert.notEqual(await em(kaiClaude).innerHTML(), await em(leidaSoul).innerHTML(), 'the two engines draw two different icons')
    await pane.screenshot({ path: join(SHOTS, 'icone-motor-membros.png') })

    // ---- 3. "Juntar agente…": the many box, with the same column ----
    await pane.locator('.ch-bar .ch-join').click()
    await picker.waitFor()
    await rows.first().waitFor()
    assert.equal(await rows.count(), 2)
    assert.deepEqual((await rows.evaluateAll(lis => lis.map(li => li.querySelector('.pk-engine')?.getAttribute('title') ?? ''))).sort(), ['Claude', 'soul'])
    allSame(await rect(rows, '.pk-engine'), 'join: engine icon')
    allSame(await rect(rows, '.pk-label'), 'join: name')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })

    // ---- 4. the "@" list of the speaking box ----
    const field = pane.locator('.ch-composer-slot textarea')
    await field.click()
    await page.keyboard.type('@')
    const opts = pane.locator('.ch-mention-list:not([hidden]) .ch-mention-opt')
    await opts.first().waitFor()
    assert.equal(await opts.count(), 3, 'todos and the two members')
    const mt = await opts.evaluateAll(lis => lis.map(li => li.querySelector('.ch-mention-eng')?.getAttribute('title') ?? ''))
    assert.deepEqual(mt.slice().sort(), ['', 'Claude', 'soul'], `the members name their engines, "todos" has an empty cell (${mt.join(', ')})`)
    const names = await opts.evaluateAll(lis => lis.map(li => Math.round(li.querySelector('.ch-mention-name')!.getBoundingClientRect().left * 10) / 10))
    assert.equal(new Set(names).size, 1, `names are aligned in the "@" list (${names.join(', ')})`)
    await page.screenshot({ path: join(SHOTS, 'icone-motor-arroba.png') })
    await page.keyboard.press('Escape')
  } catch (e) {
    console.error(`daemon log:\n${logs.slice(-25).join('\n')}`)
    throw e
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
