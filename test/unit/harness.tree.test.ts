// The harness builds a process tree by ppid. On Windows the ppid of a long-lived system process (csrss, winlogon,
// dwm) points at a parent that died at boot (smss) and whose pid gets reused; a claude process that lands on that
// pid would "adopt" the session and the harness would report them as orphans after /exit. Creation time settles it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { descendants, type Proc } from '../../test/e2e/harness.ts'

const T = 1_330_000_000_000_000 // an arbitrary FILETIME-like instant (below 2^53); smaller = earlier
const proc = (pid: number, ppid: number, name: string, created: number): Proc => ({ pid, ppid, name, created })

describe('descendants (process tree by ppid + creation time)', () => {
  // smss (pid 4064) started the session at boot and exited; much later a claude process got pid 4064.
  const bootSession = [
    proc(7768, 4064, 'csrss.exe', T + 1_000),
    proc(3316, 4064, 'winlogon.exe', T + 1_000),
    proc(8508, 3316, 'fontdrvhost.exe', T + 1_100),
    proc(7140, 3316, 'dwm.exe', T + 1_200),
  ]
  const claude = proc(4064, 500, 'claude.exe', T + 9_000_000)
  const helpers = [
    proc(4100, 4064, 'node.exe', T + 9_000_100),
    proc(4200, 4100, 'conhost.exe', T + 9_000_200),
  ]
  const all = [proc(500, 1, 'tetherd.exe', T + 8_000_000), claude, ...helpers, ...bootSession]

  test('a reused pid does not adopt the boot session: only processes created after the root belong', () => {
    const ids = descendants(all, 4064).map(p => p.pid).sort((a, b) => a - b)
    assert.deepEqual(ids, [4064, 4100, 4200])
  })

  test('real descendants are found transitively, with the root first', () => {
    const tree = descendants(all, 500)
    assert.equal(tree[0]!.pid, 500)
    assert.deepEqual(tree.map(p => p.pid).sort((a, b) => a - b), [500, 4064, 4100, 4200])
  })

  test('an unknown creation time (0) falls back to the ppid alone', () => {
    const list = [proc(10, 1, 'a.exe', T), proc(11, 10, 'b.exe', 0), proc(12, 10, 'c.exe', T - 1)]
    assert.deepEqual(descendants(list, 10).map(p => p.pid), [10, 11])
    const unknownRoot = [proc(10, 1, 'a.exe', 0), proc(12, 10, 'c.exe', T - 1)]
    assert.deepEqual(descendants(unknownRoot, 10).map(p => p.pid), [10, 12])
  })

  test('a root that is not listed has no tree (no parent to compare against)', () => {
    assert.deepEqual(descendants(bootSession, 4064), [])
  })
})
