// E2.7: what a ProcHost launches runs BELOW_NORMAL; the switch (TETHER_PRIORITIES=0) leaves it alone.
import assert from 'node:assert/strict'
import { getPriority } from 'node:os'
import { after, before, describe, test } from 'node:test'
import { connect } from 'node:net'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { makePrioritySetter, prioritiesEnabled, PRIORITY_BELOW_NORMAL } from '../../src/procd/priority.ts'
import { PROCD_PROTOCOL_VERSION } from '../../src/procd/protocol.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const SLEEP = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env as Record<string, string> }

async function spawnOne(host: ProcHost, pipe: string, home: string): Promise<number> {
  const socket = connect(pipe)
  await new Promise<void>((res, rej) => { socket.once('connect', () => res()); socket.once('error', rej) })
  socket.setEncoding('utf8')
  const msgs: Record<string, unknown>[] = []
  const parser = new LineParser()
  socket.on('data', (c: string) => { for (const l of parser.push(c)) if (l.value) msgs.push(l.value as Record<string, unknown>) })
  socket.write(encode({ t: 'hello', v: PROCD_PROTOCOL_VERSION, id: 1 }))
  await waitUntil(() => msgs.some((m) => m.id === 1), 10_000, 'hello')
  socket.write(encode({ t: 'spawn', id: 2, name: 'p1', run: 1, home, plan: SLEEP, cols: 80, rows: 24 }))
  await waitUntil(() => msgs.some((m) => m.id === 2), 10_000, 'spawn')
  const r = msgs.find((m) => m.id === 2) as { t: string; message?: string; pid?: number }
  assert.equal(r.t, 'ok', r.message)
  socket.destroy()
  return r.pid!
}

describe('host priorities', () => {
  const home = tempHome()
  const calls: [number, number][] = []
  before(() => { delete process.env.TETHER_PRIORITIES })
  after(async () => { await removeHome(home) })

  test('the child is set BELOW_NORMAL (injected setter)', async () => {
    const pipe = uniquePipe(home)
    const host = new ProcHost({ home, pipe, persist: false, setPriority: (p, v) => calls.push([p, v]) })
    await host.listen()
    try {
      const pid = await spawnOne(host, pipe, home)
      assert.deepEqual(calls, [[pid, PRIORITY_BELOW_NORMAL]])
    } finally { await host.close() }
  })

  test('real OS: the child reads back BELOW_NORMAL', { skip: process.platform !== 'win32' }, async () => {
    const pipe = uniquePipe(home)
    const host = new ProcHost({ home, pipe, persist: false })
    await host.listen()
    try {
      const pid = await spawnOne(host, pipe, home)
      assert.equal(getPriority(pid), PRIORITY_BELOW_NORMAL)
    } finally { await host.close() }
  })

  test('the switch: TETHER_PRIORITIES=0 disables', () => {
    assert.equal(prioritiesEnabled({}), true)
    assert.equal(prioritiesEnabled({ TETHER_PRIORITIES: '0' }), false)
    let n = 0
    makePrioritySetter({ enabled: false, set: () => { n++ } })(1, 1)
    assert.equal(n, 0)
  })

  test('a failing setter is reported once', () => {
    const logs: string[] = []
    const set = makePrioritySetter({ set: () => { throw new Error('x') }, log: (m) => logs.push(m) })
    set(1, 1); set(2, 1)
    assert.equal(logs.length, 1)
  })
})
