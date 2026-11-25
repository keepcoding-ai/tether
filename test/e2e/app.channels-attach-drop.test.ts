// E2E of the image viewer and of dropping files on the channel's pane (slice A3): a tetherd in this process on a private home and
// pipe, with the channels extension on its door and one fake `claude` agent; the real app on the same pipe, hidden window.
//   1. the viewer: a click on a thumbnail opens the picture big over the pane (still inside the channel), the arrows walk to the
//      other image and stop at the ends, Esc closes and the focus is back on the thumbnail; the picture is let go of on closing;
//   2. the viewer by the keyboard (Enter on the thumbnail), "Ver imagem" in the attachment's menu, ✕, a click on the margin, and
//      "Abrir no app" (the preview tab, as the click did before);
//   3. dropping: files of the system dragged over the pane light the zone (screen 4) and dropped they become chips; the same
//      validation as the clip (a secret's name is refused with the reason, 10 per speech); the speech goes with the file;
//   4. a tab of the app being dragged does NOT light the zone (the types dockview's own handler sets carry no `Files`);
//   5. pasting copied files (the paste event with files that have a path on disk) becomes chips;
//   6. a pane of 360 px: no sideways scroll, the chips in a column, the viewer fills the pane;
//   7. a closed channel refuses the drop with the notice.
// The events are synthesized: the files come from a real <input type=file> (so they have a path on disk, as a drop from the
// explorer has) into a DataTransfer. What the system delivers on a real drop from the explorer is not tried here.
// Run alone: node --test test/e2e/app.channels-attach-drop.test.ts   (one E2E at a time: the build is remade)
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
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
import { registerVerbs } from '../../extensions/channels/daemon/verbs.ts'
import { USER, type Line } from '../../extensions/channels/rules.ts'
import type { PaneSnapshot } from '../../extensions/channels/renderer/channel-pane.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = { ext: { channels: { open(channelId: string, name?: string): void; view(channelId: string): PaneSnapshot | undefined } } }
interface Win { __tether: Hooks; __dt?: DataTransfer; __hv?: ReturnType<typeof setInterval> }
declare const window: Win

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = fileURLToPath(new URL('../fixtures/channels/agent.cjs', import.meta.url))
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/anexos/a3'

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

test('channel pane: image viewer and dropping files (viewer, arrows, keyboard, drop, refusals, tab drag, paste, narrow, closed)', { timeout: 480_000 }, async () => {
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
  const lote = join(src, 'lote')
  mkdirSync(lote, { recursive: true })
  writeFileSync(join(src, 'grafico.png'), png(160, 100, [0x2b, 0x93, 0xf0]))
  writeFileSync(join(src, 'outro.png'), png(40, 90, [0xe0, 0x6c, 0x4f]))
  writeFileSync(join(src, 'contrato-v3.pdf'), '%PDF-1.4 falso')
  writeFileSync(join(src, '.env'), 'NAO_E_SEGREDO=teste')
  const many = Array.from({ length: 11 }, (_, i) => join(lote, `f${String(i + 1).padStart(2, '0')}.txt`))
  many.forEach((p, i) => writeFileSync(p, `arquivo ${i + 1}\n`))

  let app: ElectronApplication | undefined
  try {
    const agent = (await doorApi.slots.create({ kind: 'claude', cwd: src, name: 'conferente' })).slotId
    await waitUntil(() => doorApi.slots.get(agent)?.status === 'running' && doorApi.slots.readScreen(agent).data.includes('READY'), 30_000, 'agent running')
    const made = await ch.create(USER, { name: 'horizontes', title: 'Horizontes' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, agent)).ok)
    const lastLine = async (): Promise<Line> => (await ch.store.history(id, undefined, 1))[0]!

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
    const row = (seq: number): ReturnType<Page['locator']> => pane.locator(`.ch-msg[data-seq="${seq}"]`)
    const menuRows = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('#ctx-menu > li')].map(li => (li.textContent ?? '').trim()))
    const active = (): Promise<{ cls: string; name: string }> => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null
      return { cls: e?.className ?? '', name: e?.dataset?.name ?? '' }
    })
    const resize = async (w: number, h: number): Promise<void> => {
      await app!.evaluate(({ BrowserWindow }, [ww, hh]) => { BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!) }, [w, h])
    }

    // ---- the drag helpers: real files (with a path on disk) in a DataTransfer, events fired on the pane ----
    const takeFiles = async (paths: string[]): Promise<void> => {
      await page.evaluate(() => {
        document.getElementById('__drop_in')?.remove()
        const i = document.createElement('input')
        i.type = 'file'
        i.multiple = true
        i.id = '__drop_in'
        document.body.append(i)
      })
      await page.setInputFiles('#__drop_in', paths)
      await page.evaluate(() => {
        const i = document.getElementById('__drop_in') as HTMLInputElement
        const dt = new DataTransfer()
        for (const f of Array.from(i.files!)) dt.items.add(f)
        window.__dt = dt
      })
    }
    /** Fires a drag event of `type` on the pane with what `takeFiles` took; resolves to whether it was left alone (not prevented). */
    const fire = (type: 'dragenter' | 'dragover' | 'dragleave' | 'drop'): Promise<boolean> => page.evaluate(([t, i]) => {
      const p = document.querySelector(`.ch-pane[data-channel="${i}"]`) as HTMLElement
      const r = p.getBoundingClientRect()
      const ev = new DragEvent(t!, { bubbles: true, cancelable: true, dataTransfer: window.__dt!, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
      return p.dispatchEvent(ev)
    }, [type, id] as const)
    /** Keeps `dragover` coming, as a real drag does, so the zone stays for a picture. */
    const hold = (): Promise<void> => page.evaluate(i => {
      const p = document.querySelector(`.ch-pane[data-channel="${i}"]`) as HTMLElement
      const r = p.getBoundingClientRect()
      const go = (): void => { p.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt!, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })) }
      go()
      window.__hv = setInterval(go, 100)
    }, id)
    const release = (): Promise<void> => page.evaluate(() => { if (window.__hv) clearInterval(window.__hv); window.__hv = undefined })

    await openPane()
    await waitView('pane with the box', x => x.loaded && x.composer?.enabled === true)

    // ---- the conversation: two images and a PDF, sent through the clip ----
    console.log('step 0: two images in the conversation')
    await spyPicker([join(src, 'grafico.png'), join(src, 'outro.png'), join(src, 'contrato-v3.pdf')])
    await pane.locator('.ch-clip').click()
    await waitView('three chips', x => x.composer!.attach.chips.length === 3)
    await field.fill('Nic, veja os gráficos e compare com o contrato.')
    await field.press('Enter')
    await waitView('sent', x => x.composer!.attach.chips.length === 0)
    const mine = await lastLine()
    assert.equal(mine.files?.length, 3)
    const shots = row(mine.seq).locator('.ch-shot')
    await until(async () => (await row(mine.seq).locator('.ch-shot img').count()) === 2, 15_000, 'both thumbnails loaded')

    // ---- 1. the viewer by the mouse ----
    console.log('step 1: viewer, arrows, Esc')
    assert.equal(await pane.locator('.ch-viewer').count(), 0)
    await shots.first().click()
    await pane.locator('.ch-viewer').waitFor()
    let v = await waitView('picture ready', x => x.viewer?.state === 'ready')
    assert.equal(v.viewer!.name, 'grafico.png')
    assert.equal(v.viewer!.position, '1 de 2')
    assert.equal(v.viewer!.hasPrev, false)
    assert.equal(v.viewer!.hasNext, true)
    assert.match(v.viewer!.subtitle, /^Imagem · .+ · 160 x 100$/)
    assert.equal(v.viewer!.holding, true)
    const big = await pane.locator('.ch-vimg').evaluate(i => ({ src: (i as HTMLImageElement).src.slice(0, 22), w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight }))
    assert.equal(big.src, 'data:image/png;base64,')
    assert.deepEqual([big.w, big.h], [160, 100], 'the picture at its own size (the thumbnail is smaller or equal)')
    assert.equal(await pane.locator('.ch-viewer .ch-vh').isVisible(), true)
    const box = (await pane.boundingBox())!
    const vb = (await pane.locator('.ch-vbox').boundingBox())!
    assert.ok(vb.width > box.width - 20 && vb.height > box.height - 20, 'the viewer covers the pane (a margin of a few pixels)')
    assert.equal(await pane.locator('.ch-head').evaluate(e => (e as HTMLElement).inert), true, 'what is behind is out of reach while it is open')
    await pane.screenshot({ path: join(SHOTS, '6-visualizador.png') })
    await page.keyboard.press('ArrowRight')
    v = await waitView('the second image', x => x.viewer?.name === 'outro.png' && x.viewer.state === 'ready')
    assert.equal(v.viewer!.position, '2 de 2')
    assert.equal(v.viewer!.hasNext, false)
    assert.equal(await pane.locator('.ch-vimg').count(), 1, 'one picture held at a time')
    await page.keyboard.press('ArrowRight')
    assert.equal((await view())!.viewer!.name, 'outro.png', 'the arrow stops at the end')
    await page.keyboard.press('ArrowLeft')
    await waitView('back to the first', x => x.viewer?.name === 'grafico.png' && x.viewer.state === 'ready')
    await page.keyboard.press('ArrowRight')
    await waitView('the second again', x => x.viewer?.name === 'outro.png' && x.viewer.state === 'ready')
    await page.keyboard.press('Escape')
    await pane.locator('.ch-viewer').waitFor({ state: 'detached' })
    assert.equal((await view())!.viewer, undefined)
    assert.equal(await pane.locator('.ch-vimg').count(), 0, 'the picture is let go of on closing')
    assert.equal(await pane.locator('.ch-head').evaluate(e => (e as HTMLElement).inert), false)
    assert.deepEqual(await active(), { cls: 'ch-shot', name: 'outro.png' }, 'the focus is back on the thumbnail that was last shown')

    // ---- 2. keyboard, menu, ✕, margin, "Abrir no app" ----
    console.log('step 2: keyboard, menu, close, margin, open in the app')
    await shots.first().focus()
    await page.keyboard.press('Enter')
    await waitView('opened by Enter', x => x.viewer?.name === 'grafico.png' && x.viewer.state === 'ready')
    assert.equal((await view())!.viewer!.focus, 'ch-act ch-vclose', 'the focus goes into the viewer, on the close button')
    await page.keyboard.press('Escape')
    await pane.locator('.ch-viewer').waitFor({ state: 'detached' })
    assert.deepEqual(await active(), { cls: 'ch-shot', name: 'grafico.png' })
    await shots.first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const rows = await menuRows()
    assert.ok(rows[0]!.startsWith('Ver imagem'), `"Ver imagem" is first in ${JSON.stringify(rows)}`)
    for (const label of ['Abrir', 'Abrir ao lado', 'Copiar caminho']) assert.ok(rows.some(r => r.startsWith(label)), `${label} in ${JSON.stringify(rows)}`)
    await page.screenshot({ path: join(SHOTS, '7-menu-do-anexo.png') })
    await page.locator('#ctx-menu > li', { hasText: 'Ver imagem' }).click()
    await waitView('opened by the menu', x => x.viewer?.name === 'grafico.png' && x.viewer.state === 'ready')
    await pane.locator('.ch-vmenu').click()
    await page.waitForSelector('#ctx-menu')
    assert.ok((await menuRows()).some(r => r.startsWith('Abrir')), 'the "⋯" is the file menu')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu', { state: 'detached' })
    await pane.locator('.ch-vclose').click()
    await pane.locator('.ch-viewer').waitFor({ state: 'detached' })
    await shots.first().click()
    await pane.locator('.ch-viewer').waitFor()
    await pane.locator('.ch-viewer').click({ position: { x: 2, y: 2 } })
    await pane.locator('.ch-viewer').waitFor({ state: 'detached' })
    await shots.first().click()
    await pane.locator('.ch-viewer').waitFor()
    await pane.locator('.ch-vapp').click()
    await until(async () => (await page.locator('.dv-tab, .tab').allInnerTexts()).some(t => t.includes('Prévia: grafico.png')), 10_000, 'the app opened the image in a preview')
    assert.equal(await pane.locator('.ch-viewer').count(), 0, 'opening in the app closes the viewer')
    await openPane()
    await pane.waitFor({ state: 'visible' })

    // ---- 3. dropping files ----
    console.log('step 3: dropping')
    await waitView('box on', x => x.composer?.enabled === true)
    await takeFiles([join(src, 'grafico.png')])
    assert.equal(await fire('dragenter'), false, 'the pane takes a drag of files (the drop is allowed)')
    assert.equal((await view())!.drop.shown, true)
    await hold()
    const z = (await view())!.drop
    assert.deepEqual([z.shown, z.refuse, z.title, z.sub], [true, false, 'Solte para anexar ao #horizontes', 'Até 10 arquivos, 20 MB cada. Todos os membros poderão ler.'])
    await pane.screenshot({ path: join(SHOTS, '4-zona-de-soltar.png') })
    await release()
    assert.equal(await fire('drop'), false)
    assert.equal((await view())!.drop.shown, false, 'dropping puts the zone away')
    let s = await waitView('a chip from the drop', x => x.composer!.attach.chips.length === 1)
    assert.deepEqual(s.composer!.attach.chips.map(c => [c.name, c.thumb, c.bad]), [['grafico.png', true, false]])
    assert.match(s.composer!.attach.room, /Todos os membros/)
    await takeFiles([join(src, '.env')])
    await fire('dragover')
    await fire('drop')
    s = await waitView('the secret refused', x => x.composer!.attach.chips.length === 2)
    assert.deepEqual(s.composer!.attach.chips.map(c => [c.name, c.bad]), [['grafico.png', false], ['.env', true]])
    assert.ok(s.composer!.attach.notes.some(n => n.includes('.env não entrou')), JSON.stringify(s.composer!.attach.notes))
    await pane.locator('.ch-fchip.bad .ch-fchip-rm').click()
    await field.fill('Segue o gráfico (solto na guia).')
    await field.press('Enter')
    await waitView('sent with the dropped file', x => x.composer!.attach.chips.length === 0)
    const dropped = await lastLine()
    assert.deepEqual(dropped.files!.map(f => f.name), ['grafico (2).png'])
    await row(dropped.seq).locator('.ch-shot img').waitFor()
    // Eleven files: ten go in, the count says how many were left out.
    await takeFiles(many)
    await fire('dragover')
    await fire('drop')
    s = await waitView('ten chips', x => x.composer!.attach.chips.length === 10)
    assert.ok(s.composer!.attach.notes.some(n => n.includes('Entraram 10 de 11 arquivos')), JSON.stringify(s.composer!.attach.notes))
    await pane.screenshot({ path: join(SHOTS, '10-onze-soltos.png') })
    while ((await view())!.composer!.attach.chips.length > 0) await pane.locator('.ch-fchip-rm').first().click()

    // ---- 4. a tab of the app being dragged does not light the zone ----
    console.log('step 4: a tab drag')
    const types = await page.evaluate(i => {
      const dt = new DataTransfer()
      const tab = document.querySelector('.dv-tab') as HTMLElement
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const kinds = Array.from(dt.types)
      const p = document.querySelector(`.ch-pane[data-channel="${i}"]`) as HTMLElement
      const r = p.getBoundingClientRect()
      p.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 80, clientY: r.top + 80 }))
      const shown = !(p.querySelector('.ch-drop') as HTMLElement).hidden
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return { kinds, shown }
    }, id)
    console.log(`  the tab's drag carries: ${JSON.stringify(types.kinds)}`)
    assert.equal(types.kinds.includes('Files'), false)
    assert.equal(types.shown, false, 'no zone for a tab')

    // ---- 5. pasting copied files ----
    console.log('step 5: pasting files')
    await takeFiles([join(src, 'outro.png'), join(src, 'contrato-v3.pdf')])
    await field.focus()
    const handled = await page.evaluate(() => {
      const f = document.querySelector('.ch-field') as HTMLTextAreaElement
      return !f.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: window.__dt! }))
    })
    assert.equal(handled, true, 'the paste of files is the box\'s (the default is stopped)')
    s = await waitView('chips from the paste', x => x.composer!.attach.chips.length === 2)
    assert.deepEqual(s.composer!.attach.chips.map(c => c.name), ['outro.png', 'contrato-v3.pdf'])

    // ---- 6. a narrow pane ----
    console.log('step 6: narrow pane')
    await resize(360, 800)
    await page.waitForFunction(i => document.querySelector(`.ch-pane[data-channel="${i}"]`)?.classList.contains('narrow') === true, id)
    const wpx = await pane.evaluate(e => e.clientWidth)
    console.log(`  the pane is ${wpx}px wide`)
    assert.ok(wpx <= 400, `a narrow pane (${wpx}px)`)
    const chips = pane.locator('.ch-fchip')
    const a = (await chips.nth(0).boundingBox())!
    const b = (await chips.nth(1).boundingBox())!
    assert.ok(b.y > a.y + a.height - 2 && Math.abs(a.x - b.x) < 2, 'the chips are in a column')
    const overflow = await pane.evaluate(e => ({
      pane: e.scrollWidth - e.clientWidth, msgs: (e.querySelector('.ch-msgs') as HTMLElement).scrollWidth - (e.querySelector('.ch-msgs') as HTMLElement).clientWidth,
      say: (e.querySelector('.ch-say') as HTMLElement).scrollWidth - (e.querySelector('.ch-say') as HTMLElement).clientWidth,
    }))
    assert.deepEqual([overflow.pane <= 0, overflow.msgs <= 0, overflow.say <= 0], [true, true, true], `no sideways scroll ${JSON.stringify(overflow)}`)
    await row(mine.seq).scrollIntoViewIfNeeded()
    await pane.screenshot({ path: join(SHOTS, '11-guia-estreita.png') })
    await shots.first().click()
    await waitView('viewer in the narrow pane', x => x.viewer?.state === 'ready')
    const nb = (await pane.boundingBox())!
    const nvb = (await pane.locator('.ch-vbox').boundingBox())!
    assert.ok(nvb.width >= nb.width - 14 && nvb.x + nvb.width <= nb.x + nb.width + 1, 'the viewer fills the narrow pane')
    await pane.screenshot({ path: join(SHOTS, '11-visualizador-estreito.png') })
    await page.keyboard.press('Escape')
    await pane.locator('.ch-viewer').waitFor({ state: 'detached' })
    await resize(1280, 800)
    while ((await view())!.composer!.attach.chips.length > 0) await pane.locator('.ch-fchip-rm').first().click()

    // ---- 7. a closed channel refuses the drop ----
    console.log('step 7: closed channel')
    assert.ok((await ch.close(USER, id)).ok)
    await waitView('closed: no box', x => x.composer === undefined)
    await takeFiles([join(src, 'grafico.png')])
    await fire('dragenter')
    await hold()
    const zc = (await view())!.drop
    assert.deepEqual([zc.shown, zc.refuse, zc.title], [true, true, 'Canal encerrado'])
    await pane.screenshot({ path: join(SHOTS, '12-soltar-em-encerrado.png') })
    await release()
    await fire('drop')
    s = await waitView('the notice', x => x.toast !== '')
    assert.equal(s.toast, 'Canal encerrado: não dá para anexar arquivos.')
    assert.equal(s.composer, undefined)
    assert.equal(s.drop.shown, false)
    // The viewer still works in a closed channel.
    await shots.first().click()
    await waitView('viewer in the closed channel', x => x.viewer?.state === 'ready')
    await page.keyboard.press('Escape')
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
