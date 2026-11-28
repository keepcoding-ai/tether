// tetherd launching panes in the terminal-pane host (E1.6), here a host running in this process: input through tetherd
// echoes, stop kills the tree, an exit by itself becomes `exited`, the state says `ptyHost`, a double start launches once,
// a host that drops ends its panes and the next start brings a host back. The switch decides only new launches.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { denyPermissionPromptsEnabled, panelHostEnabled, startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { readUserSettings } from '../../src/core/user-settings-sync.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { pidAlive, Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

describe('panelHostEnabled', () => {
  test('TETHER_PANEL_HOST wins; otherwise daemon.panelHost in settings.json; default on', async () => {
    const { writeFile } = await import('node:fs/promises')
    const home = tempHome()
    try {
      assert.equal(panelHostEnabled(readUserSettings(home, {}), {}), true)
      await writeFile(join(home, 'settings.json'), '{ "daemon": { "panelHost": true } }')
      assert.equal(panelHostEnabled(readUserSettings(home, {}), {}), true)
      assert.equal(panelHostEnabled(readUserSettings(home, {}), { TETHER_PANEL_HOST: '0' }), false)
      await writeFile(join(home, 'settings.json'), '{ "daemon.panelHost": false }')
      assert.equal(panelHostEnabled(readUserSettings(home, {}), {}), false)
      assert.equal(panelHostEnabled(readUserSettings(home, {}), { TETHER_PANEL_HOST: '1' }), true)
    } finally {
      await removeHome(home)
    }
  })
})

describe('daemon: panes in an in-process terminal-pane host', () => {
  const home = tempHome()
  const cwd = join(home, 'work')
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const connects = { n: 0 }
  const startHost = async (): Promise<void> => {
    host = new ProcHost({ home: join(home, 'host'), pipe: hostPipe, persist: false })
    await host.listen()
  }

  before(async () => {
    mkdirSync(cwd)
    mkdirSync(join(home, 'host'))
    await startHost()
    daemon = await startDaemon({
      home,
      pipe: uniquePipe(home),
      memoryIntervalMs: 0,
      panelHost: true,
      connectPanelHost: async (launch) => { connects.n++; return launch ? HostClient.open(hostPipe) : HostClient.tryOpen(hostPipe) },
    })
    rec = await Recorder.connect(daemon.pipe)
  })
  after(async () => {
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  let slotId: string
  let shellPid: number
  let childPid: number

  test('create+start: running in the host, pid alive, ptyHost in the state', async () => {
    const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd, start: true })
    slotId = slot!.slotId
    assert.equal(slot!.status, 'running')
    assert.equal(slot!.ptyHost, true)
    shellPid = slot!.pid!
    assert.ok(shellPid > 0 && shellPid !== process.pid && pidAlive(shellPid))
    assert.ok(!rec.states.some((s) => s.slotId === slotId && s.status === 'starting'), 'the seat taken during the host spawn is not announced')
    const { slots } = await rec.client.request({ t: 'list' })
    assert.equal(slots!.find((s) => s.slotId === slotId)!.ptyHost, true)
    const attached = await rec.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
    assert.equal(typeof attached.scrollback, 'string')
  })

  test('input through tetherd reaches the hosted pane and its output comes back', async () => {
    rec.client.input(slotId, "Write-Output ('tether-' + 'hospedado')\r")
    await rec.see(slotId, /tether-hospedado/)
    await rec.client.request({ t: 'resize', slotId, cols: 120, rows: 40 })
    rec.client.input(slotId, 'node -e "console.log(\'child=\'+process.pid);setInterval(()=>{},1000)"\r')
    childPid = Number((await rec.see(slotId, /child=(\d+)/))[1])
    assert.ok(pidAlive(childPid))
  })

  test('a second client attaching later gets the scrollback', async () => {
    const other = await Recorder.connect(daemon.pipe)
    try {
      const attached = await other.client.request({ t: 'attach', slotId, cols: 100, rows: 30 })
      assert.match(attached.scrollback!, /tether-hospedado/)
      assert.match(attached.scrollback!, /child=\d+/)
    } finally {
      other.close()
    }
  })

  test('stop kills the whole tree (shell and child, by pid): exited, no pid, no ptyHost', async () => {
    const stopped = await rec.client.request({ t: 'stop', slotId })
    assert.equal(stopped.slot!.status, 'exited')
    assert.equal(stopped.slot!.pid, undefined)
    assert.equal(stopped.slot!.ptyHost, undefined)
    await waitUntil(() => !pidAlive(shellPid) && !pidAlive(childPid), 10_000, 'shell and child gone')
  })

  test('a pane that ends by itself becomes exited', async () => {
    const { slot } = await rec.client.request({ t: 'start', slotId })
    assert.equal(slot!.status, 'running')
    const pid = slot!.pid!
    assert.ok(pid !== shellPid)
    rec.client.input(slotId, 'exit\r')
    await rec.state(slotId, (s) => s.status === 'exited' && s.pid === undefined && (s.endedAt ?? '') !== '' && rec.states.indexOf(s) > rec.states.findIndex((x) => x.slotId === slotId && x.pid === pid), 15_000, 'exited after exit')
    await waitUntil(() => !pidAlive(pid), 10_000, 'shell gone')
  })

  test('two starts at once launch one process', async () => {
    const [a, b] = await Promise.all([rec.client.request({ t: 'start', slotId }), rec.client.request({ t: 'start', slotId })])
    assert.equal(a.slot!.status, 'running')
    assert.ok(a.slot!.pid)
    assert.equal(b.slot!.pid, a.slot!.pid)
    const probe = await HostClient.open(hostPipe)
    try {
      const { runs } = await probe.request({ t: 'list' })
      assert.equal(runs!.filter((r) => r.name === slotId && !r.exit).length, 1)
    } finally {
      probe.close()
    }
  })

  test('the host drops: the pane exits; the next start reconnects to a host and runs again', async () => {
    const pid = (await rec.client.request({ t: 'list' })).slots!.find((s) => s.slotId === slotId)!.pid!
    const n = rec.states.length
    await host.close()
    await waitUntil(() => rec.states.slice(n).some((s) => s.slotId === slotId && s.status === 'exited'), 10_000, 'exited after the drop')
    await waitUntil(() => !pidAlive(pid), 10_000, 'the hosted shell died with its host')
    await startHost()
    const before = connects.n
    const { slot } = await rec.client.request({ t: 'start', slotId })
    assert.equal(slot!.status, 'running')
    assert.equal(slot!.ptyHost, true)
    assert.ok(connects.n > before, 'a new connection was made')
    await rec.client.request({ t: 'stop', slotId })
  })

  test('no host at all: the start fails with a clear message', async () => {
    await host.close()
    await assert.rejects(rec.client.request({ t: 'start', slotId }), (e: Error) => /anfitrião de terminais/.test(e.message))
    const s = await rec.state(slotId, (x) => x.status === 'error')
    assert.equal(s.error?.code, 'spawn-failed')
    await startHost()
  })
})

describe('daemon: switch off', () => {
  test('panes launch in process: no ptyHost, and the host is never asked', async () => {
    const home = tempHome()
    const cwd = join(home, 'work')
    mkdirSync(cwd)
    let asked = 0
    const daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, panelHost: false, connectPanelHost: async () => { asked++; return undefined } })
    const rec = await Recorder.connect(daemon.pipe)
    try {
      const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd, start: true })
      assert.equal(slot!.status, 'running')
      assert.equal(slot!.ptyHost, undefined)
      assert.ok(!rec.states.some((s) => s.slotId === slot!.slotId && s.status === 'starting'), 'a shell in process never shows starting')
      assert.equal(asked, 0)
    } finally {
      rec.close()
      await daemon.close()
      await removeHome(home)
    }
  })

  test('agents.claude.denyPermissionPrompts: default on, off only when false', () => {
    assert.equal(denyPermissionPromptsEnabled({}), true)
    assert.equal(denyPermissionPromptsEnabled({ agents: { claude: { denyPermissionPrompts: true } } }), true)
    assert.equal(denyPermissionPromptsEnabled({ agents: { claude: { denyPermissionPrompts: false } } }), false)
    assert.equal(denyPermissionPromptsEnabled({ 'agents.claude.denyPermissionPrompts': false }), false)
  })
})
