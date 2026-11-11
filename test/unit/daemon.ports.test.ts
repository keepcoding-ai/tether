// Ports: the parsers of the listener tables (netstat with a localized header, lsof), the owner of a pid by process
// tree, the single view (managed / outside tether / declared), the texts of --check, and the probe against a real
// listener.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { describe, test } from 'node:test'
import { parseProcessTable } from '../../src/daemon/memory.ts'
import { buildPortRows, checkText, ownerText, parseLsof, parseNetstat, probePort, treeOwners } from '../../src/daemon/ports.ts'
import { statusText } from '../../src/daemon/procs.ts'

const NETSTAT_V4 = `
Conexões ativas

  Proto  Endereço local         Endereço externo       Estado         PID
  TCP    0.0.0.0:135            0.0.0.0:0              ESCUTANDO       1204
  TCP    127.0.0.1:47860        0.0.0.0:0              ESCUTANDO       5000
  TCP    127.0.0.1:47860        127.0.0.1:51000        ESTABELECIDA    5000
  TCP    192.168.0.10:51001     20.1.2.3:443           TIME_WAIT       0
`
const NETSTAT_V6 = `
  Proto  Endereço local         Endereço externo       Estado         PID
  TCP    [::]:135               [::]:0                 ESCUTANDO       1204
  TCP    [::1]:47861            [::]:0                 ESCUTANDO       6000
`

describe('ports: parsers', () => {
  test('netstat: listening lines by shape (5 columns, foreign :0), whatever the language', () => {
    assert.deepEqual(parseNetstat(NETSTAT_V4), [
      { port: 135, pid: 1204, address: '0.0.0.0:135' },
      { port: 47860, pid: 5000, address: '127.0.0.1:47860' },
    ])
    assert.deepEqual(parseNetstat(NETSTAT_V6).map((l) => [l.port, l.pid]), [[135, 1204], [47861, 6000]])
  })

  test('lsof: the NAME column of (LISTEN) lines; the dual-stack mirror is not doubled', () => {
    const text = [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    4242 guga   21u  IPv4 0x1      0t0  TCP *:3000 (LISTEN)',
      'node    4242 guga   22u  IPv6 0x2      0t0  TCP *:3000 (LISTEN)',
      'redis    777 guga    6u  IPv6 0x3      0t0  TCP [::1]:6379 (LISTEN)',
    ].join('\n')
    assert.deepEqual(parseLsof(text), [
      { port: 3000, pid: 4242, address: '*:3000' },
      { port: 6379, pid: 777, address: '[::1]:6379' },
    ])
  })

  test('process table keeps the executable name when the sample has it', () => {
    assert.deepEqual(parseProcessTable('10,4,2048,node.exe\n11,10,1024,Code Helper.exe\n12,4,512\n'), [
      { pid: 10, ppid: 4, bytes: 2048, name: 'node.exe' },
      { pid: 11, ppid: 10, bytes: 1024, name: 'Code Helper.exe' },
      { pid: 12, ppid: 4, bytes: 512 },
    ])
  })
})

describe('ports: owners and the view', () => {
  // 100 (managed web) → 101 (cmd) → 102 (node, listens 3000); 200 is outside tether, listens 5432.
  const rows = parseProcessTable('100,1,1,cmd.exe\n101,100,1,cmd.exe\n102,101,1,node.exe\n200,1,1,postgres.exe\n')
  const owners = treeOwners(rows, [{ pid: 100, name: 'web' }])
  const listeners = [{ port: 3000, pid: 102, address: '0.0.0.0:3000' }, { port: 5432, pid: 200, address: '0.0.0.0:5432' }]

  test('a pid deep in a managed tree belongs to that process; others to nobody', () => {
    assert.equal(owners.get(102), 'web')
    assert.equal(owners.get(200), undefined)
  })

  test('one row per port: managed, outside tether with exe and pid, declared but silent', () => {
    const view = buildPortRows(listeners, rows, owners, [
      { name: 'web', status: 'running', ports: [3000] },
      { name: 'api', status: 'stopped', ports: [4000] },
    ])
    assert.deepEqual(view, [
      { port: 3000, listening: true, owner: { proc: 'web', pid: 102, exe: 'node.exe' }, declaredBy: [{ name: 'web', status: 'running' }] },
      { port: 4000, listening: false, declaredBy: [{ name: 'api', status: 'stopped' }] },
      { port: 5432, listening: true, owner: { pid: 200, exe: 'postgres.exe' }, outside: true },
    ])
    assert.equal(ownerText(view[0]!), 'web (pid 102)')
    assert.equal(ownerText(view[2]!), 'fora do tether: postgres.exe, pid 200')
  })

  test('--check texts: livre, ocupada por quem, declarada por quem', () => {
    const view = buildPortRows(listeners, rows, owners, [{ name: 'api', status: 'stopped', ports: [4000] }])
    const st = (s: Parameters<typeof statusText>[0]['status']) => statusText({ status: s })
    assert.equal(checkText(undefined, 4100, st), 'porta 4100: livre')
    assert.equal(checkText(view.find((r) => r.port === 5432), 5432, st), 'porta 5432: ocupada por fora do tether: postgres.exe, pid 200')
    assert.equal(checkText(view.find((r) => r.port === 4000), 4000, st), 'porta 4000: declarada por api (parado)')
  })
})

describe('ports: probe', () => {
  test('true while something listens on localhost, false after it closes', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    assert.equal(await probePort(port), true)
    await new Promise<void>((r) => server.close(() => r()))
    assert.equal(await probePort(port), false)
  })
})
