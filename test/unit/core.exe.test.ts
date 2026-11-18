// The renamed node executables (core/exe.ts): made from the source, kept while the source is unchanged, remade
// when it changes, kept (not replaced) while running, and the plain node when nothing can be made. Proven with
// the real node.exe: the copy runs, reports its new name, and loads node-pty (same binary, same ABI).
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { exePath } from '../../src/core/exe.ts'
import { ensureRenamedNode, inspectRenamedNode, isNodeExecutable, isRenamedNode, readStamp, sweepOrphanTemps } from '../../src/core/exe-sync.ts'
import { tempDirs } from './tmp.helpers.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const isWin = process.platform === 'win32'
const isDarwin = process.platform === 'darwin'
const tmp = tempDirs('tether-exe-')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

after(() => tmp.cleanup())

describe('name tests', () => {
  test('node, node.exe and our own copies count as node; anything else does not', () => {
    assert.ok(isNodeExecutable('C:\\x\\node.exe'))
    assert.ok(isNodeExecutable('/usr/bin/node'))
    assert.ok(isNodeExecutable('C:\\h\\bin\\tetherd.exe'))
    assert.ok(isNodeExecutable('C:\\h\\bin\\tether-soul.exe'))
    assert.ok(!isNodeExecutable('C:\\x\\soul.exe'))
    assert.ok(!isNodeExecutable('bash'))
    assert.ok(isRenamedNode('tetherd.exe') && isRenamedNode('/h/bin/tether-soul') && !isRenamedNode('node.exe'))
    assert.ok(isRenamedNode('tether-ptyd.exe') && isRenamedNode('/h/bin/tether-ptyd') && isNodeExecutable('C:/h/bin/tether-ptyd.exe'))
  })
})

// Not on macOS: no copy is made there (dyld refuses a link/copy of Homebrew's node); see the darwin block below.
describe('ensureRenamedNode with the real node', { skip: isDarwin }, () => {
  let home: string
  const log: string[] = []
  before(() => { home = tmp.make() })

  test('makes <home>/bin/tetherd[.exe] from process.execPath; it runs under its new name and loads node-pty', () => {
    const r = ensureRenamedNode(home, 'tetherd', process.execPath, (m) => log.push(m))
    assert.equal(r.state, 'fresh')
    assert.notEqual(r.method, 'fallback', `fallback: ${r.reason}`)
    assert.equal(r.path, exePath(home, 'tetherd'))
    assert.ok(existsSync(r.path))
    assert.equal(statSync(r.path).size, statSync(process.execPath).size)
    const stamp = readStamp(home, 'tetherd')
    assert.ok(stamp && stamp.source === process.execPath && stamp.method === r.method)
    assert.match(log.at(-1)!, /tetherd: .*(ligado a|copiado de)/)

    // The copy is a node: its execPath is the new name, and node-pty (native, ABI-bound) spawns a real console.
    // process.exit at the end: node-pty 1.1 keeps the ConPTY handles open after the child exits (see daemon/pty.ts).
    const shell = isWin ? `'cmd.exe',['/c','echo pty-ok']` : `'sh',['-c','echo pty-ok']`
    const probe = `const p=require('node-pty').spawn(${shell},{cols:40,rows:10});let o='';p.onData(d=>o+=d);`
      + `p.onExit(()=>{console.log(process.execPath+'|'+(o.includes('pty-ok')?'pty-ok':'no-pty'));setTimeout(()=>process.exit(0),100)})`
    const out = spawnSync(r.path, ['-e', probe], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(out.status, 0, out.stderr)
    const [execPath, pty] = out.stdout.trim().split('|')
    assert.equal(basename(execPath!), basename(r.path), 'the process runs under the new name')
    assert.equal(pty, 'pty-ok', 'node-pty loaded and worked under the renamed node')
  })

  test('a second call finds it current and touches nothing', () => {
    const before = statSync(join(home, 'bin', isWin ? 'tetherd.json' : 'tetherd.json')).mtimeMs
    const r = ensureRenamedNode(home, 'tetherd', process.execPath)
    assert.equal(r.state, 'current')
    assert.equal(statSync(join(home, 'bin', 'tetherd.json')).mtimeMs, before)
    const status = inspectRenamedNode(home, 'tetherd')
    assert.ok(status.present && !status.outdated && status.stamp?.method === r.method)
  })
})

describe('ensureRenamedNode refresh and failure paths (a fake source: a copy of node)', { skip: isDarwin }, () => {
  let home: string
  let source: string
  let running: ChildProcess | undefined
  before(() => {
    home = tmp.make()
    source = join(home, 'fake-node.exe')
    copyFileSync(process.execPath, source)
  })
  after(async () => {
    // A child killed by signal has exitCode null and signalCode set: only a child that never exited is waited for.
    if (running && running.exitCode === null && running.signalCode === null) { running.kill(); await new Promise((r) => running!.once('exit', r)) }
  })

  test('source changed (mtime) → remade; stamp follows', () => {
    const first = ensureRenamedNode(home, 'tether-soul', source)
    assert.equal(first.state, 'fresh')
    assert.ok(!inspectRenamedNode(home, 'tether-soul').outdated)
    const t = new Date(Date.now() - 60_000)
    utimesSync(source, t, t)
    assert.ok(inspectRenamedNode(home, 'tether-soul').outdated, 'doctor sees the source changed')
    const second = ensureRenamedNode(home, 'tether-soul', source)
    assert.equal(second.state, 'fresh')
    assert.equal(readStamp(home, 'tether-soul')!.mtimeMs, statSync(source).mtimeMs)
    assert.equal(ensureRenamedNode(home, 'tether-soul', source).state, 'current')
  })

  // Measured on Windows 11: the rename over the running executable succeeds (the old file stays alive for the
  // running image, unlinked). A Windows/file system that refuses it takes the 'stale' branch; both are accepted,
  // and in both the running process goes on and the target is a sane executable afterwards.
  test('target in use (running): the running process is never disturbed; replaced now or kept with a log line', async () => {
    const target = exePath(home, 'tether-soul')
    running = spawn(target, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    await sleep(500)
    assert.equal(running.exitCode, null, 'the copy is running')
    const t = new Date(Date.now() - 120_000)
    utimesSync(source, t, t)
    const log: string[] = []
    const r = ensureRenamedNode(home, 'tether-soul', source, (m) => log.push(m))
    assert.equal(r.path, target)
    assert.notEqual(r.method, 'fallback', `fallback: ${r.reason}`)
    assert.ok(r.state === 'fresh' || r.state === 'stale', JSON.stringify(r))
    if (r.state === 'stale') {
      assert.match(log.join('\n'), /está em uso/)
      assert.ok(inspectRenamedNode(home, 'tether-soul').outdated, 'still outdated: doctor will say so')
    } else {
      assert.ok(!inspectRenamedNode(home, 'tether-soul').outdated)
      assert.equal(readStamp(home, 'tether-soul')!.mtimeMs, statSync(source).mtimeMs)
    }
    await sleep(300)
    assert.equal(running.exitCode, null, 'the running process was not disturbed')
    assert.ok(!existsSync(`${target}.${process.pid}.tmp`), 'no temp file left behind')
    const check = spawnSync(target, ['-p', '1+1'], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.equal(check.stdout.trim(), '2', 'the executable in place runs')

    running.kill()
    await new Promise((res) => running!.once('exit', res))
    await sleep(300)
    const after = ensureRenamedNode(home, 'tether-soul', source)
    assert.ok(after.state === 'fresh' || after.state === 'current', `sane after exit: ${JSON.stringify(after)}`)
    assert.ok(!inspectRenamedNode(home, 'tether-soul').outdated)
  })

  test('missing source → fallback to the source path itself, with the reason in the stamp for doctor', () => {
    const missing = join(home, 'no-such-node.exe')
    const log: string[] = []
    const r = ensureRenamedNode(home, 'tetherd', missing, (m) => log.push(m))
    assert.equal(r.method, 'fallback')
    assert.equal(r.path, missing)
    assert.match(log[0]!, /rodando com o node original/)
    const status = inspectRenamedNode(home, 'tetherd')
    assert.equal(status.stamp?.method, 'fallback')
    assert.ok(status.stamp?.reason)
    assert.ok(status.outdated)
  })

  test('a corrupt stamp is ignored and the executable remade', () => {
    ensureRenamedNode(home, 'tetherd', source)
    writeFileSync(join(home, 'bin', 'tetherd.json'), '{not json')
    assert.equal(readStamp(home, 'tetherd'), undefined)
    const r = ensureRenamedNode(home, 'tetherd', source)
    assert.equal(r.state, 'fresh')
    assert.ok(readFileSync(join(home, 'bin', 'tetherd.json'), 'utf8').includes('"source"'))
  })
})

describe('ensureRenamedNode on darwin: nothing in bin/, the name goes by argv0', () => {
  test('returns the source with argv0 set, writes only the stamp, and a second call is current', () => {
    const home = tmp.make()
    const log: string[] = []
    const r = ensureRenamedNode(home, 'tetherd', process.execPath, (m) => log.push(m), 'darwin')
    assert.equal(r.path, process.execPath, 'runs the real node')
    assert.equal(r.method, 'argv0')
    assert.equal(r.argv0, 'tetherd')
    assert.equal(r.state, 'fresh')
    assert.match(r.reason!, /@rpath\/libnode|dyld/)
    assert.ok(!existsSync(exePath(home, 'tetherd')), 'no renamed executable is made')
    assert.deepEqual(readdirSync(join(home, 'bin')), ['tetherd.json'], 'only the stamp lives in bin/')
    const stamp = readStamp(home, 'tetherd')
    assert.equal(stamp?.method, 'argv0')
    assert.equal(stamp?.source, process.execPath)
    assert.match(stamp?.reason ?? '', /argv0/)
    assert.match(log.at(-1)!, /tetherd: rodando pelo node real/)
    const again = ensureRenamedNode(home, 'tetherd', process.execPath, undefined, 'darwin')
    assert.equal(again.state, 'current')
    assert.equal(again.argv0, 'tetherd')
    const status = inspectRenamedNode(home, 'tetherd', 'darwin')
    assert.ok(!status.present && !status.outdated && !status.residue && status.stamp?.method === 'argv0')
  })

  test('a leftover renamed file is reported as residue by inspect and never run', () => {
    const home = tmp.make()
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(exePath(home, 'tetherd'), 'stale link')
    const r = ensureRenamedNode(home, 'tetherd', process.execPath, undefined, 'darwin')
    assert.equal(r.path, process.execPath)
    assert.equal(readFileSync(exePath(home, 'tetherd'), 'utf8'), 'stale link', 'the leftover is left alone (it may be a running one)')
    assert.ok(inspectRenamedNode(home, 'tetherd', 'darwin').residue)
  })

  test('missing source is still the fallback, as elsewhere', () => {
    const home = tmp.make()
    const r = ensureRenamedNode(home, 'tetherd', join(home, 'no-such-node'), undefined, 'darwin')
    assert.equal(r.method, 'fallback')
    assert.equal(r.argv0, undefined)
  })
})

describe('orphan temp files in bin/', () => {
  test('tetherd.<dead pid>.tmp and tetherd.json.<dead pid>.tmp go; our own pid, a live pid and other names stay', () => {
    const home = tmp.make()
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    const dead = 2 ** 22 - 7 // past any real pid on these systems (pid_max 99998 on macOS, 4194304 default max on Linux)
    for (const n of [`tetherd.${dead}.tmp`, `tether-soul.exe.${dead}.tmp`, `tether-ptyd.exe.${dead}.tmp`, `tetherd.json.${dead}.tmp`, `tetherd.${process.pid}.tmp`, `tetherd.${process.ppid}.tmp`, 'other.1.tmp', 'tetherd.json']) writeFileSync(join(bin, n), 'x')
    const log: string[] = []
    const removed = sweepOrphanTemps(home, (m) => log.push(m))
    assert.deepEqual(removed.map((p) => basename(p)).sort(), [`tether-ptyd.exe.${dead}.tmp`, `tether-soul.exe.${dead}.tmp`, `tetherd.${dead}.tmp`, `tetherd.json.${dead}.tmp`])
    assert.deepEqual(readdirSync(bin).sort(), ['other.1.tmp', `tetherd.${process.pid}.tmp`, `tetherd.${process.ppid}.tmp`, 'tetherd.json'].sort())
    assert.equal(log.length, 4)
    assert.match(log[0]!, /temporário órfão/)
  })

  test('ensureRenamedNode sweeps them on its way (darwin branch, no bin file of its own)', () => {
    const home = tmp.make()
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'tetherd.4194297.tmp'), 'x')
    ensureRenamedNode(home, 'tetherd', process.execPath, undefined, 'darwin')
    assert.deepEqual(readdirSync(bin), ['tetherd.json'])
  })

  test('a missing bin/ is not an error', () => {
    assert.deepEqual(sweepOrphanTemps(tmp.make()), [])
  })
})
