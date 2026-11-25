// E2E of the attachments in the conversation (slice A2): a tetherd in this process on a private home and pipe, with the channels
// extension's record, requests and verbs on its door and one fake `claude` agent; the real app on the same pipe, hidden window.
//   1. the clip brings two images, a PDF and a code file: the images' chips have a thumbnail (A1's gap), the speech goes;
//   2. the conversation shows the images as thumbnails in a grid (a small data: picture, never the file) and the others as
//      cards with icon, name and size; a click opens the file as a file link does (the system's program, spied);
//   3. the right button on a file opens the app's menu of a file link;
//   4. the agent attaches by the CLI's road (the pipe's `verb` request, the same exit `tether channels say --files` uses): the
//      speech shows the same way; a secret's name is refused by that road with the reason;
//   5. files deleted by hand from the channel's folder: after a reload their cards are dimmed and say so, open nothing, and the
//      others keep working;
//   6. the channel closed: the files stay visible and open; no box, no clip.
// Run alone: node --test test/e2e/app.channels-attach-view.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { VerbResult } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { registerVerbs } from '../../extensions/channels/daemon/verbs.ts'
import { GONE_TEXT } from '../../extensions/channels/attachments.ts'
import { USER, type Line } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = { ext: { channels: { open(channelId: string, name?: string): void; view(channelId: string): PaneSnapshot | undefined } } }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/anexos/a2'

/** A real PNG of one colour (the test writes its own pictures: no file of the user's). */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])) >>> 0)
    return Buffer.concat([head, Buffer.from(type), body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** `waitUntil` for a condition that asks the page. */
async function until(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout (${ms} ms) waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer ${m.type()}: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

test('channel pane: attachments in the conversation (thumbnails, cards, open, menu, agent, gone, closed)', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()

  const fake: AgentAdapter = {
    name: 'claude',
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
  }
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  contribution.channels = () => []

  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door,
    log: m => logs.push(m),
  })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, verbs: doorApi.verbs, settings: { get: () => undefined }, log: (m: string) => logs.push(m) } as ChannelsApi & Pick<typeof doorApi, 'verbs'>
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)
  for (const d of registerVerbs(api, Promise.resolve(ch))) own.add(d)
  const rec = await Recorder.connect(daemon.pipe)

  // Files outside the channel, as the person has them.
  const src = join(home, 'meus-arquivos')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'grafico.png'), png(160, 100, [0x2b, 0x93, 0xf0]))
  writeFileSync(join(src, 'outro.png'), png(40, 90, [0xe0, 0x6c, 0x4f]))
  writeFileSync(join(src, 'contrato-v3.pdf'), '%PDF-1.4 falso')
  writeFileSync(join(src, 'pagamentos-api.ts'), 'export const x = 1\n')
  writeFileSync(join(src, 'relatorio.pdf'), '%PDF-1.4 do agente')
  writeFileSync(join(src, '.env'), 'NAO_E_SEGREDO=teste')

  let app: ElectronApplication | undefined
  try {
    const agent = (await doorApi.slots.create({ kind: 'claude', cwd: src, name: 'conferente' })).slotId
    await waitUntil(() => doorApi.slots.get(agent)?.status === 'running' && doorApi.slots.readScreen(agent).data.includes('READY'), 30_000, 'agent running')
    const made = await ch.create(USER, { name: 'horizontes', title: 'Horizontes' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, agent)).ok)
    const filesDir = resolve(home, 'channels', id, 'files')
    const lastLine = async (): Promise<Line> => (await ch.store.history(id, undefined, 1))[0]!
    /** The agent's `channels say` by the CLI's road (the pipe's verb request, without the slot key). */
    const cliSay = async (args: Record<string, unknown>): Promise<VerbResult> =>
      ((await rec.client.request({ t: 'verb', ns: 'channels', name: 'say', slotId: agent, args: { canal: id, ...args } })) as unknown as { verb: VerbResult }).verb

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const openPane = async (): Promise<void> => {
      await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'horizontes'] as const)
    }
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<PaneSnapshot> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return s
        if (Date.now() > end) throw new Error(`timeout: ${what}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const field = pane.locator('.ch-field')
    const spyPicker = (paths: string[]): Promise<void> => app!.evaluate(({ dialog }, ps) => {
      ;(dialog as unknown as { showOpenDialog: (...a: unknown[]) => Promise<unknown> }).showOpenDialog = async () => ({ canceled: false, filePaths: ps })
    }, paths)
    /** The system's program, spied: what the app asked it to open (no window of the system opens). */
    const spyOpen = (): Promise<void> => app!.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] }
      g.__opened = []
      ;(shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p: string) => { g.__opened.push(p); return '' }
    })
    const opened = (): Promise<string[]> => app!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    const row = (seq: number): ReturnType<Page['locator']> => pane.locator(`.ch-msg[data-seq="${seq}"]`)
    const menuRows = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('#ctx-menu > li')].map(li => (li.textContent ?? '').trim()))

    await openPane()
    await waitView('pane with the box', x => x.loaded && x.composer?.enabled === true)
    await spyOpen()

    // ---- 1. the clip: two images, a PDF and a code file; the images' chips have their thumbnail ----
    console.log('step 1: the clip')
    await spyPicker([join(src, 'grafico.png'), join(src, 'outro.png'), join(src, 'contrato-v3.pdf'), join(src, 'pagamentos-api.ts')])
    await pane.locator('.ch-clip').click()
    const v = await waitView('four chips', x => x.composer!.attach.chips.length === 4)
    assert.deepEqual(v.composer!.attach.chips.map(c => [c.name, c.thumb]), [['grafico.png', true], ['outro.png', true], ['contrato-v3.pdf', false], ['pagamentos-api.ts', false]])
    assert.equal(await pane.locator('.ch-fchip[data-name="grafico.png"] img').count(), 1, 'the chip of an image chosen by the clip shows its thumbnail')
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '1-fichas-do-clipe.png') })
    await field.fill('Nic, veja os gráficos e compare com o contrato.')
    await field.press('Enter')
    await waitView('sent', x => x.composer!.attach.chips.length === 0)
    const mine = await lastLine()
    assert.equal(mine.files?.length, 4)

    // ---- 2. thumbnails in a grid, cards with icon, name and size; a click opens ----
    console.log('step 2: thumbnails and cards')
    const shots = row(mine.seq).locator('.ch-shot')
    await shots.first().waitFor()
    assert.equal(await shots.count(), 2)
    await until(async () => (await row(mine.seq).locator('.ch-shot img').count()) === 2, 15_000, 'both thumbnails loaded')
    const imgs = await row(mine.seq).locator('.ch-shot img').evaluateAll(l => (l as HTMLImageElement[]).map(i => ({ src: i.src.slice(0, 22), len: i.src.length, w: i.naturalWidth, h: i.naturalHeight })))
    for (const i of imgs) {
      assert.equal(i.src, 'data:image/png;base64,', 'a small picture made by main, never a file URL')
      assert.ok(i.w > 0 && i.h > 0, 'the picture decodes')
      assert.ok(i.len < 120_000, `the thumbnail is small (${i.len} chars)`)
    }
    assert.deepEqual(await row(mine.seq).locator('.ch-shot-nm').allInnerTexts(), ['grafico.png', 'outro.png'])
    for (const s of await row(mine.seq).locator('.ch-shot-cp > span:last-child').allInnerTexts()) assert.match(s, /^\d+ (bytes|KB)$/)
    const cards = row(mine.seq).locator('.ch-fcard')
    assert.equal(await cards.count(), 2)
    assert.deepEqual(await cards.allInnerTexts(), ['contrato-v3.pdf\nPDF · 14 bytes', 'pagamentos-api.ts\nCódigo · 19 bytes'])
    assert.equal(await cards.first().locator('svg').count(), 1, 'a card has its icon')
    await pane.screenshot({ path: join(SHOTS, '5-fala-com-anexos.png') })
    await cards.first().click()
    await until(async () => (await opened()).length === 1, 10_000, 'the PDF card opened the file')
    assert.deepEqual(await opened(), [join(filesDir, 'contrato-v3.pdf')])
    await shots.first().click()
    // A3: a click on a thumbnail opens the viewer over the pane; "Abrir no app" is what the click did in A2 (the app's own preview tab).
    await pane.locator('.ch-viewer').waitFor()
    await pane.locator('.ch-vapp').click()
    await until(async () => (await page.locator('.dv-tab, .tab').allInnerTexts()).some(t => t.includes('Prévia: grafico.png')), 10_000, 'the thumbnail opened the image in a preview')
    assert.equal((await opened()).length, 1, 'an image does not go to the system')
    await openPane()
    await pane.waitFor({ state: 'visible' })

    // ---- 3. the right button: the menu of a file link ----
    console.log('step 3: the menu')
    await cards.first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const rows = await menuRows()
    for (const label of ['Abrir', 'Abrir ao lado', 'Mostrar na pasta do sistema', 'Copiar caminho']) assert.ok(rows.some(r => r.startsWith(label)), `${label} in ${JSON.stringify(rows)}`)
    await page.screenshot({ path: join(SHOTS, '7-botao-direito.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    await shots.first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    assert.ok((await menuRows()).some(r => r.startsWith('Abrir')), 'the thumbnail has the same menu')
    await page.keyboard.press('Escape')

    // ---- 4. the agent attaches by the CLI's road ----
    console.log('step 4: the agent attaches')
    const refused = await cliSay({ text: 'segredo', files: [join(src, '.env')] })
    assert.equal(refused.isError, true)
    assert.equal((refused.data as { error: string }).error, 'secret-file')
    assert.match(refused.text, /\.env/)
    const said = await cliSay({ text: 'Conferi o contrato, segue o relatório.', files: [join(src, 'relatorio.pdf'), 'grafico.png'] })
    assert.equal(said.isError, undefined, said.text)
    const theirs = await lastLine()
    assert.equal(theirs.from.id, agent)
    assert.deepEqual(theirs.files!.map(f => f.name), ['relatorio.pdf', 'grafico (2).png'])
    assert.ok(theirs.files!.every(f => existsSync(f.path)))
    await row(theirs.seq).locator('.ch-fcard[data-name="relatorio.pdf"]').waitFor()
    await row(theirs.seq).locator('.ch-shot[data-name="grafico (2).png"] img').waitFor()
    assert.equal(await row(theirs.seq).locator('.ch-fcard').first().innerText(), 'relatorio.pdf\nPDF · 18 bytes')
    await pane.screenshot({ path: join(SHOTS, '8-fala-de-agente.png') })

    // ---- 5. files deleted by hand: dimmed cards that say so, after a reload ----
    console.log('step 5: gone files')
    unlinkSync(join(filesDir, 'relatorio.pdf'))
    unlinkSync(join(filesDir, 'outro.png'))
    await page.reload()
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    await spyOpen()
    await openPane()
    await waitView('pane again', x => x.loaded)
    await row(theirs.seq).locator('.ch-fcard.gone[data-name="relatorio.pdf"]').waitFor()
    await row(mine.seq).locator('.ch-fcard.gone[data-name="outro.png"]').waitFor()
    assert.equal(await row(theirs.seq).locator('.ch-fcard.gone').first().innerText(), `relatorio.pdf\n${GONE_TEXT}`)
    assert.equal(await row(mine.seq).locator('.ch-shot').count(), 1, 'the image that is still there keeps its thumbnail')
    await row(mine.seq).locator('.ch-shot img').waitFor()
    await row(theirs.seq).locator('.ch-fcard.gone').first().click()
    await row(mine.seq).locator('.ch-fcard[data-name="contrato-v3.pdf"]').click()
    await until(async () => (await opened()).length === 1, 10_000, 'only the file that is there opened')
    assert.deepEqual(await opened(), [join(filesDir, 'contrato-v3.pdf')], 'a gone card opens nothing')
    await pane.screenshot({ path: join(SHOTS, '9-arquivo-apagado.png') })

    // ---- 6. the channel closed: the files stay and open; no box ----
    console.log('step 6: closed channel')
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed: no box', x => x.composer === undefined)
    assert.equal(await pane.locator('.ch-clip').count(), 0)
    await row(mine.seq).locator('.ch-shot img').waitFor()
    await row(mine.seq).locator('.ch-fcard[data-name="pagamentos-api.ts"]').waitFor()
    await row(mine.seq).locator('.ch-fcard[data-name="contrato-v3.pdf"]').click()
    await until(async () => (await opened()).length === 2, 10_000, 'a closed channel still opens its files')
    assert.equal((await opened())[1], join(filesDir, 'contrato-v3.pdf'))
    await pane.screenshot({ path: join(SHOTS, '12-canal-encerrado.png') })
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    rec.close()
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
