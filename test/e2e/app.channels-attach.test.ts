// E2E of attaching files to a speech (slice A1): a tetherd in this process on a private home and pipe, with the channels
// extension's record and requests on its door and one fake `claude` agent that hears inside (no LLM); the real app on the same
// pipe, hidden window.
//   1. a print put on the clipboard by the test and pasted in the box becomes a chip (thumbnail, generated name, room warning);
//      Enter with no text sends it: the file is in <home>/channels/<id>/files/, the staged copy is gone, and the agent gets
//      `anexos:` and the absolute path; the conversation shows the file's name;
//   2. the clip opens the system picker (spied: no window of the system opens), two files become chips, ✕ takes one out, the
//      speech goes with text and the one left;
//   3. refusals: a `.env` (red chip, its reason) and a 21 MB file (its reason) do not go in, a plain file next to them does;
//   4. eleven files: ten go in and the box says how many of how many; the speech carries ten;
//   5. the channel closed: no box, no clip.
// Run alone: node --test test/e2e/app.channels-attach.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { USER, type Line } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = { ext: { channels: { open(channelId: string, name?: string): void; view(channelId: string): PaneSnapshot | undefined } } }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/anexos/a1'

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

test('channel pane: attaching files (paste a print, the clip, ✕, refusals, ten of eleven, closed channel)', { timeout: 480_000 }, async () => {
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
      env.OPEN_STREAM = '1'
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
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  // Files outside the channel, as the person has them.
  const src = join(home, 'meus-arquivos')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'contrato-v3.pdf'), '%PDF-1.4 falso')
  writeFileSync(join(src, 'pagamentos-api.ts'), 'export const x = 1\n')
  writeFileSync(join(src, '.env'), 'NAO_E_SEGREDO=teste')
  writeFileSync(join(src, 'notas.txt'), 'notas')
  const big = join(src, 'video-reuniao.mp4')
  const fd = openSync(big, 'w')
  ftruncateSync(fd, 21 * 1024 * 1024)
  closeSync(fd)
  const eleven = Array.from({ length: 11 }, (_, i) => { const p = join(src, `parte-${String(i + 1).padStart(2, '0')}.txt`); writeFileSync(p, `parte ${i + 1}`); return p })

  let app: ElectronApplication | undefined
  try {
    const agent = (await doorApi.slots.create({ kind: 'claude', cwd: home, name: 'conferente' })).slotId
    await waitUntil(() => doorApi.slots.get(agent)?.status === 'running' && doorApi.slots.readScreen(agent).data.includes('READY'), 30_000, 'agent running')
    await waitUntil(() => doorApi.delivery.pathOf(agent) === 'inside', 30_000, 'agent opened its stream')
    const made = await ch.create(USER, { name: 'horizontes', title: 'Horizontes' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, agent)).ok)
    const filesDir = resolve(home, 'channels', id, 'files')

    /** What the fake agent got of the channel (the stream's notifications). */
    const heard = (): string[] => {
      const f = join(home, `chan-${agent}.log`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { method?: string; params?: { content: string; meta: Record<string, string> } })
        .filter(n => n.method === 'notifications/claude/channel' && n.params?.meta.kind === 'message').map(n => n.params!.content)
    }
    const lastLine = async (): Promise<Line> => (await ch.store.history(id, undefined, 1))[0]!

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof window.__tether.ext?.channels?.open === 'function')
    const view = (): Promise<PaneSnapshot | undefined> => page.evaluate(i => window.__tether.ext.channels.view(i), id)
    const waitView = async (what: string, fn: (v: PaneSnapshot) => boolean, ms = 15_000): Promise<PaneSnapshot> => {
      const end = Date.now() + ms
      for (;;) {
        const s = await view()
        if (s !== undefined && fn(s)) return s
        if (Date.now() > end) throw new Error(`timeout: ${what}\n${JSON.stringify(s?.composer?.attach)} error=${s?.composer?.error ?? ''}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const pane = page.locator(`.ch-pane[data-channel="${id}"]`)
    const field = pane.locator('.ch-field')
    const focused = (): Promise<string> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')
    /** The system picker, spied: it answers `paths` and remembers what it was asked. No window of the system opens. */
    const spyPicker = (paths: string[]): Promise<void> => app!.evaluate(({ dialog }, ps) => {
      const g = globalThis as unknown as { __pickAsked: unknown[] }
      g.__pickAsked = []
      ;(dialog as unknown as { showOpenDialog: (...a: unknown[]) => Promise<unknown> }).showOpenDialog = async (...a: unknown[]) => {
        g.__pickAsked.push(a[a.length - 1])
        return { canceled: false, filePaths: ps }
      }
    }, paths)
    const pickAsked = (): Promise<Array<{ title?: string; properties?: string[] }>> => app!.evaluate(() => (globalThis as unknown as { __pickAsked: Array<{ title?: string; properties?: string[] }> }).__pickAsked)

    await page.evaluate(([i, n]) => window.__tether.ext.channels.open(i!, n), [id, 'horizontes'] as const)
    let v = await waitView('pane with the box', x => x.loaded && x.composer?.enabled === true)
    assert.equal(v.composer!.attach.clip, true, 'the clip is in the box')
    assert.deepEqual([v.composer!.attach.chips, v.composer!.attach.room], [[], ''])
    assert.equal(await pane.locator('.ch-clip').getAttribute('title'), 'Anexar arquivo · também: cole com Ctrl+V')
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '1-caixa-com-clipe.png') })

    // ---- 1. a print pasted from the clipboard ----
    console.log('step 1: paste a print')
    await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
      const px = Buffer.alloc(64 * 40 * 4)
      for (let i = 0; i < px.length; i += 4) { px[i] = 0x2b; px[i + 1] = 0x93; px[i + 2] = 0xf0; px[i + 3] = 0xff } // BGRA
      const png = nativeImage.createFromBitmap(px, { width: 64, height: 40 }).toPNG()
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    })
    await field.click()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.paste() })
    v = await waitView('the print became a chip', x => x.composer!.attach.chips.length === 1)
    const chip = v.composer!.attach.chips[0]!
    assert.match(chip.name, /^Captura de tela \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/)
    assert.equal(chip.thumb, true, 'an image chip has its thumbnail')
    assert.match(chip.label, /^Imagem · \d+ (bytes|KB)$/)
    assert.equal(v.composer!.attach.room, 'Todos os membros do canal poderão ler este arquivo.')
    assert.equal(v.composer!.text, '', 'the paste wrote nothing in the field')
    assert.match(await focused(), /ch-field/, 'the focus stays in the field')
    assert.equal(v.composer!.placeholder, 'Escreva para o canal… (opcional com anexo)')
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '2-print-colado-ficha.png') })
    const staged = readdirSync(join(home, 'channels', '.staging'))
    assert.equal(staged.length, 1, 'main staged the print')
    // Enter with no text sends the file alone.
    await page.keyboard.press('Enter')
    await waitView('the chip went', x => x.composer!.attach.chips.length === 0)
    const shot = await lastLine()
    assert.equal(shot.body, '')
    assert.equal(shot.files?.length, 1)
    assert.equal(shot.files![0]!.name, chip.name)
    assert.equal(shot.files![0]!.path, join(filesDir, chip.name))
    assert.ok(existsSync(shot.files![0]!.path), 'the print is in the channel folder')
    await waitUntil(() => readdirSync(join(home, 'channels', '.staging')).length === 0, 10_000, 'the staged print was deleted')
    await waitUntil(() => heard().some(c => c === `anexos:\n${shot.files![0]!.path}`), 15_000, 'the agent heard the print as anexos: and its path')
    await pane.locator(`.ch-msg[data-seq="${shot.seq}"] .ch-msg-files`, { hasText: chip.name }).waitFor()

    // ---- 2. the clip: the picker (spied), two chips, ✕ takes one out ----
    console.log('step 2: the clip')
    await spyPicker([join(src, 'contrato-v3.pdf'), join(src, 'pagamentos-api.ts')])
    await pane.locator('.ch-clip').click()
    v = await waitView('two chips', x => x.composer!.attach.chips.length === 2)
    assert.deepEqual(v.composer!.attach.chips.map(c => [c.name, c.label]), [['contrato-v3.pdf', 'PDF · 14 bytes'], ['pagamentos-api.ts', 'Código · 19 bytes']])
    assert.equal(v.composer!.attach.room, 'Todos os membros do canal poderão ler estes arquivos. · 2 de 10')
    const asked = await pickAsked()
    assert.equal(asked.length, 1)
    assert.equal(asked[0]!.title, 'Anexar arquivo')
    assert.deepEqual([...asked[0]!.properties!].sort(), ['multiSelections', 'openFile'])
    await field.fill('Nic, compare com o contrato.')
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '3-varios-anexos-aviso.png') })
    await pane.locator('.ch-fchip[data-name="pagamentos-api.ts"] .ch-fchip-rm').click()
    v = await waitView('one chip left', x => x.composer!.attach.chips.length === 1)
    assert.equal(v.composer!.attach.chips[0]!.name, 'contrato-v3.pdf')
    assert.equal(v.composer!.attach.room, 'Todos os membros do canal poderão ler este arquivo.')
    await field.press('Enter')
    await waitView('sent', x => x.composer!.attach.chips.length === 0 && x.composer!.text === '')
    const pdf = await lastLine()
    assert.equal(pdf.body, 'Nic, compare com o contrato.')
    assert.deepEqual(pdf.files!.map(f => f.path), [join(filesDir, 'contrato-v3.pdf')])
    await waitUntil(() => heard().some(c => c.startsWith(`Nic, compare com o contrato.\nanexos:\n${join(filesDir, 'contrato-v3.pdf')}`)), 15_000, 'the agent heard the text, then anexos:')

    // ---- 3. refusals: a secret's name and a file too large; the plain one goes in ----
    console.log('step 3: refusals')
    await spyPicker([join(src, '.env'), big, join(src, 'notas.txt')])
    await pane.locator('.ch-clip').click()
    v = await waitView('refusals shown', x => x.composer!.attach.notes.length === 2)
    assert.deepEqual(v.composer!.attach.chips.map(c => [c.name, c.bad]), [['notas.txt', false], ['.env', true]])
    assert.equal(v.composer!.attach.chips[1]!.label, 'Recusado: parece conter segredos')
    assert.deepEqual(v.composer!.attach.notes, [
      '.env não entrou. Arquivos de variáveis, chaves e certificados não são anexados, porque todos os membros do canal poderiam lê-los. Se for um arquivo comum com outro nome, renomeie e anexe de novo.',
      'video-reuniao.mp4 não entrou. Tem 21 MB e o limite é 20 MB por arquivo. Envie um trecho menor ou comprima o arquivo.',
    ])
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '10-recusas.png') })
    await pane.locator('.ch-fchip.bad .ch-fchip-rm').click()
    v = await waitView('the red chip went', x => x.composer!.attach.chips.every(c => !c.bad))
    assert.equal(v.composer!.attach.notes.length, 1, 'its reason went with it')
    await pane.locator('.ch-fchip[data-name="notas.txt"] .ch-fchip-rm').click()
    await waitView('no chip', x => x.composer!.attach.chips.length === 0)

    // ---- 4. eleven files: ten go in ----
    console.log('step 4: ten of eleven')
    await spyPicker(eleven)
    await pane.locator('.ch-clip').click()
    v = await waitView('ten chips', x => x.composer!.attach.chips.length === 10)
    assert.deepEqual(v.composer!.attach.notes, ['Entraram 10 de 11 arquivos. O limite é 10 por fala. Envie estes e anexe o resto na fala seguinte.'])
    assert.deepEqual(v.composer!.attach.chips.map(c => c.name), eleven.slice(0, 10).map(p => p.split(/[\\/]/).pop()))
    assert.equal(v.composer!.attach.room, 'Todos os membros do canal poderão ler estes arquivos. · 10 de 10')
    await pane.locator('.ch-say').screenshot({ path: join(SHOTS, '10-dez-de-onze.png') })
    await field.fill('As dez partes.')
    await field.press('Enter')
    await waitView('sent ten', x => x.composer!.attach.chips.length === 0)
    const ten = await lastLine()
    assert.equal(ten.files?.length, 10)
    assert.ok(ten.files!.every(f => existsSync(f.path)))
    await pane.screenshot({ path: join(SHOTS, 'conversa-com-anexos.png') })

    // ---- 5. the channel closed: no box, no clip ----
    console.log('step 5: closed channel')
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed: no box', x => x.composer === undefined)
    assert.equal(await pane.locator('.ch-clip').count(), 0, 'no clip in a closed channel')
    await pane.screenshot({ path: join(SHOTS, '12-canal-encerrado.png') })
  } finally {
    contribution.channels = savedChannels
    if (app) await killElectron(app, root).catch(() => {})
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
