// `tether attach <slot>` proven in a real terminal: a tetherd on a private home, a shell slot, then the CLI
// inside a node-pty (ConPTY). Keys typed in that terminal reach the slot and its output comes back; a resize
// of the terminal is forwarded without harm; Ctrl+] detaches with exit code 0 and the slot keeps running
// (same pid). Run: npm run test:e2e
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { LocalPtyTransport, Screen, type ExitInfo } from './harness.ts'

const root = resolve(import.meta.dirname, '..', '..')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const base = mkdtempSync(join(tmpdir(), 'tether-attach-'))
const home = join(base, 'home')
const work = join(base, 'work')
mkdirSync(home); mkdirSync(work)
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-attach-${randomBytes(4).toString('hex')}` : join(home, 'd.sock')

/** The CLI running in a pseudo-terminal, with a virtual screen to read what it prints. */
class CliTerminal {
  readonly screen = new Screen(100, 30)
  readonly transport: LocalPtyTransport
  exit: ExitInfo | undefined
  private readonly exited: Promise<ExitInfo>
  constructor(args: string[], env: Record<string, string>) {
    this.transport = new LocalPtyTransport({ command: process.execPath, args: [join(root, 'bin', 'tether.mjs'), ...args], cwd: root, env }, this.screen.cols, this.screen.rows)
    this.transport.onData(d => this.screen.write(d))
    this.exited = new Promise(res => this.transport.onExit(e => { this.exit = e; res(e) }))
  }
  get pid(): number { return this.transport.pid }
  text(): string { return this.screen.text() }
  write(data: string): void { this.transport.write(data) }
  async waitFor(re: RegExp, timeout = 20_000): Promise<string> {
    const deadline = Date.now() + timeout
    while (!re.test(this.text())) {
      if (this.exit) throw new Error(`cli exited (code ${this.exit.exitCode}) while waiting for ${re}\n--- screen ---\n${this.text()}`)
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${re}\n--- screen ---\n${this.text()}`)
      await sleep(100)
    }
    return this.text()
  }
  async waitExit(timeout = 15_000): Promise<ExitInfo> {
    const r = await Promise.race([this.exited, sleep(timeout).then(() => undefined)])
    if (!r) throw new Error(`cli did not exit in ${timeout} ms\n--- screen ---\n${this.text()}`)
    return r
  }
  dispose(): void { this.transport.dispose() }
}

test('tether attach: keys in, output out, resize survives, Ctrl+] detaches with code 0 and the slot keeps running', async t => {
  const suite = new SuiteDaemon(home, pipe)
  let cli: CliTerminal | undefined
  try {
    const client = await suite.connect()
    const created = await client.request({ t: 'create', kind: 'shell', cwd: work, start: true })
    const slotId = created.slot!.slotId
    const state = async (): Promise<SlotState> => (await client.request({ t: 'list' })).slots!.find(s => s.slotId === slotId)!
    const deadline = Date.now() + 20_000
    while ((await state()).status !== 'running' && Date.now() < deadline) await sleep(200)
    const before = await state()
    assert.equal(before.status, 'running')
    const shellPid = before.pid!
    assert.ok(shellPid > 0)

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env.TETHER_HOME = home
    env.TETHER_PIPE = pipe
    cli = new CliTerminal(['attach', slotId], env)
    // The shell prompt comes from the slot's scrollback; the replay also carries PowerShell's startup screen
    // clear, so the "[tether] anexado" banner printed before it may be gone by then.
    await cli.waitFor(/PS .*>/)
    t.diagnostic(`banner visible after the scrollback replay: ${new RegExp(`anexado ao slot ${slotId}`).test(cli.text())}`)
    assert.ok(pidAlive(cli.pid), 'cli running')

    cli.write('echo tether-attach\r')
    await cli.waitFor(/(^|\n)tether-attach\s*(\n|$)/)
    t.diagnostic('echo round-tripped through the slot')

    // A bigger terminal: attach forwards the size; nothing may die.
    cli.transport.resize(120, 40)
    await sleep(1_000)
    assert.equal(cli.exit, undefined, 'cli still running after the resize')
    cli.write('echo size-ok\r')
    await cli.waitFor(/(^|\n)size-ok\s*(\n|$)/)
    assert.equal((await state()).status, 'running')

    cli.write('\x1d') // Ctrl+]
    const exit = await cli.waitExit()
    assert.equal(exit.exitCode, 0, `attach exit code\n--- screen ---\n${cli.text()}`)
    assert.match(cli.text(), new RegExp(`desanexado do slot ${slotId}`))

    const after = await state()
    assert.equal(after.status, 'running', 'the slot keeps running after detach')
    assert.equal(after.pid, shellPid, 'same shell pid')
    assert.ok(pidAlive(shellPid))
  } finally {
    cli?.dispose()
    await suite.shutdown().catch(e => t.diagnostic(String(e)))
    for (let i = 0; i < 5; i++) { try { rmSync(base, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
