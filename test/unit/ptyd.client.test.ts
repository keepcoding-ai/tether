// HostClient as tether-ptyd's client: open/tryOpen/ensure against a host in this process (persist:false), `write`
// answered by `data` with `off`, `lag` emitted, caps exposed; and the detached launch of the real tether-ptyd.exe
// (isolated home and pipe): hello with caps, leaves on `shutdown`, nothing left behind (checked by pid).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { exePath } from '../../src/core/exe.ts'
import { encode, LineParser } from '../../src/daemon/ndjson.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { ptydLogPath, ptydPipePath, PTYD_TARGET } from '../../src/ptyd/paths.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const ECHO = 'process.stdin.on("data", (d) => process.stdout.write("got:" + String(d).trim() + "\\n")); setInterval(() => {}, 1000)'

describe('HostClient against an in-process persist:false host', () => {
  const home = tempHome()
  const pipe = uniquePipe(home)
  let host: ProcHost
  before(async () => {
    host = new ProcHost({ home, pipe, persist: false })
    await host.listen()
  })
  after(async () => { await host.close(); await removeHome(home) })

  test('open exposes caps; tryOpen returns undefined (never throws) when nothing listens', async () => {
    const c = await HostClient.open(pipe)
    assert.ok(c.caps.includes('write') && c.caps.includes('offsets') && c.caps.includes('lag'))
    c.close()
    assert.equal(await HostClient.tryOpen(uniquePipe(home), 500), undefined)
  })

  test('ensure connects to a host already there without launching anything', async () => {
    const c = await HostClient.ensure({ home, pipe, node: process.execPath, env: process.env }, 5_000, PTYD_TARGET)
    assert.equal(c.hello.pid, process.pid)
    assert.ok(!existsSync(exePath(home, 'tether-ptyd')), 'no executable was made')
    c.close()
  })

  test('write (no reply) comes back as data events carrying off, growing', async () => {
    const c = await HostClient.open(pipe)
    const seen: { name: string; data: string; off?: number }[] = []
    c.on('data', (name, data, off) => seen.push({ name, data, ...(off === undefined ? {} : { off }) }))
    await c.request({ t: 'spawn', name: 'echo', run: 1, plan: { command: process.execPath, args: ['-e', ECHO], cwd: home, env: { ...process.env } as Record<string, string> }, cols: 80, rows: 24, home })
    const at = await c.request({ t: 'attach', name: 'echo' })
    assert.equal(typeof at.off, 'number')
    c.write('echo', 'hi\r')
    await waitUntil(() => seen.some((e) => e.data.includes('got:hi')), 10_000, 'echoed data')
    assert.ok(seen.every((e) => e.name === 'echo' && typeof e.off === 'number'), 'every chunk has its offset')
    const offs = seen.map((e) => e.off!)
    assert.deepEqual(offs, [...offs].sort((a, b) => a - b))
    assert.ok(offs[offs.length - 1]! > 0)
    await c.request({ t: 'stop', name: 'echo', graceMs: 500 })
    c.close()
    c.write('echo', 'x') // closed: silently ignored
  })
})

describe('lag', () => {
  test('is emitted when the host says it', async () => {
    const home = tempHome()
    const pipe = uniquePipe(home)
    const server: Server = createServer((s) => {
      const parser = new LineParser()
      s.setEncoding('utf8')
      s.on('data', (chunk: string) => {
        for (const l of parser.push(chunk)) {
          const m = l.value as { t: string; id: number }
          if (m.t === 'hello') s.write(encode({ t: 'ok', id: m.id, hello: { v: 1, caps: ['lag'], pid: 1, version: 'x', startedAt: 'now' } }))
          else if (m.t === 'list') {
            s.write(encode({ t: 'lag', name: 'pane' }))
            s.write(encode({ t: 'ok', id: m.id, runs: [] }))
          }
        }
      })
    })
    await new Promise<void>((r) => server.listen(pipe, r))
    try {
      const c = await HostClient.open(pipe)
      const lagged: string[] = []
      c.on('lag', (n) => lagged.push(n))
      await c.request({ t: 'list' })
      assert.deepEqual(lagged, ['pane'])
      c.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await removeHome(home)
    }
  })
})

describe('tether-ptyd launched detached', { skip: process.platform !== 'win32' && 'detached launch is exercised on Windows' }, () => {
  test('starts under its own name with isolated home and pipe, answers hello with caps, leaves on shutdown', async () => {
    const home = tempHome()
    const pipe = uniquePipe(home)
    try {
      assert.equal(ptydPipePath('\\\\.\\pipe\\tether-x', home, {}, 'win32'), '\\\\.\\pipe\\tether-x-procd-ptyd')
      const c = await HostClient.ensure({ home, pipe, node: process.execPath, env: { ...process.env, TETHER_PTYD_IDLE_MS: '60000' } }, 30_000, PTYD_TARGET)
      const pid = c.hello.pid
      assert.notEqual(pid, process.pid)
      assert.deepEqual([...c.caps].sort(), ['lag', 'offsets', 'write'])
      assert.ok(existsSync(exePath(home, 'tether-ptyd')), 'runs as <home>/bin/tether-ptyd.exe')
      const owned = await claim(pid, { cmdIncludes: join('src', 'ptyd', 'main.ts'), what: 'tether-ptyd' })
      try {
        await c.request({ t: 'shutdown' })
        c.close()
        await waitUntil(() => !pidAlive(pid), 15_000, 'tether-ptyd gone')
      } finally {
        await killOwned(owned, { tree: true })
      }
      assert.ok(!pidAlive(pid))
      assert.equal(await HostClient.tryOpen(pipe, 500), undefined, 'the pipe is free')
      assert.ok(existsSync(ptydLogPath(home)))
    } finally {
      await removeHome(home)
    }
  })
})
