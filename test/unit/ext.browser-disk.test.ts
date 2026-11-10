// E15 (design §4.3, §12b rule 18): the browser's partition on disk and what never reaches a log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { partitionStep } from '../../extensions/browser/tab-rules.ts'
import { fusedMarkerOf, persistPartitionDir, prepareDiskPartition, wipePageStorage } from '../../extensions/browser/disk-partition.ts'
import { ADDRESS, KEY, PORT, scrubLogLine } from '../../extensions/browser/log-scrub.ts'

test('browser disk: partition step (memory without the fuse; wipe a partition found without the fused marker)', () => {
  assert.equal(partitionStep(false, true, false), 'memory')
  assert.equal(partitionStep(false, false, false), 'memory')
  assert.equal(partitionStep(true, false, false), 'use')
  assert.equal(partitionStep(true, true, true), 'use')
  assert.equal(partitionStep(true, true, false), 'wipe-then-use')
  assert.equal(partitionStep(true, false, true), 'use')
})

test('browser disk: prepareDiskPartition wipes the unfused partition once, leaves the marker, never touches disk without the fuse', () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-e15-disk-'))
  try {
    const home = join(base, 'home'), userData = join(home, 'electron')
    const dir = persistPartitionDir(userData)
    assert.equal(dir, join(userData, 'Partitions', 'tether-browser'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Cookies'), 'plain-text cookie')
    const logs: string[] = []
    const log = (m: string): void => { logs.push(m) }

    assert.equal(prepareDiskPartition({ fuseOn: false, home, userData, log }), 'memory')
    assert.ok(existsSync(join(dir, 'Cookies')), 'fuse off: the disk is left alone')
    assert.equal(existsSync(fusedMarkerOf(home)), false)

    assert.equal(prepareDiskPartition({ fuseOn: true, home, userData, log }), 'wipe-then-use')
    assert.equal(existsSync(dir), false, 'the unfused partition is gone')
    assert.equal(JSON.parse(readFileSync(fusedMarkerOf(home), 'utf8')).fuse, 'EnableCookieEncryption')
    assert.equal(logs.length, 1)

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Cookies'), 'encrypted cookie')
    assert.equal(prepareDiskPartition({ fuseOn: true, home, userData, log }), 'use')
    assert.ok(existsSync(join(dir, 'Cookies')), 'a fused partition is kept')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('browser disk: log lines lose page addresses, ports, keys and endpoint content, keep ids', () => {
  const key = 'Qm9vYmFyLWJhel9xdXV4LTE5Mi1iaXRz' // 32 base64url characters, the shape of an agent's key
  assert.equal(key.length, 32)
  const slot = '3f2b8c1e-9a4d-4e5f-8b7a-1c2d3e4f5a6b'
  assert.equal(scrubLogLine(`guia 7: popup não virou guia (ERR_FAILED (-2) loading 'https://banco.example/conta?token=abc')`),
    `guia 7: popup não virou guia (ERR_FAILED (-2) loading '${ADDRESS}')`)
  assert.equal(scrubLogLine('aberto ws://127.0.0.1:53211/devtools/browser/tether'), `aberto ${ADDRESS}`)
  assert.equal(scrubLogLine('porteiro em 127.0.0.1:53211'), `porteiro em 127.0.0.1:${PORT}`)
  assert.equal(scrubLogLine('falhou em localhost:9222 de novo'), `falhou em localhost:${PORT} de novo`)
  assert.equal(scrubLogLine('nav data:text/html,<b>x</b> e javascript:alert(1)'), `nav ${ADDRESS} e ${ADDRESS}`)
  assert.equal(scrubLogLine(`chave ${key} lida`), `chave ${KEY} lida`)
  assert.equal(scrubLogLine(`endpoint {"v":1,"port":53211,"pid":10,"instance":"abc123"}`), `endpoint {"v":1,"port":${PORT},"pid":10,"instance":"${KEY}"}`)
  assert.equal(scrubLogLine(`slot ${slot}: guia t-12 criada`), `slot ${slot}: guia t-12 criada`, 'slot and tab ids stay')
  assert.equal(scrubLogLine('rede: requisição barrada (rede local, xhr)'), 'rede: requisição barrada (rede local, xhr)')
  assert.equal(scrubLogLine(`chave em C:\\Users\\x\\tether\\browser\\keys\\${slot}.key`), `chave em C:\\Users\\x\\tether\\browser\\keys\\${slot}.key`, 'a Windows path is not an address')
})

test('browser disk: a fused partition keeps only the cookies and the network state between starts (review N-M2)', () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-nm2-disk-'))
  try {
    const home = join(base, 'home'), userData = join(home, 'electron')
    const dir = persistPartitionDir(userData)
    for (const d of ['Network', 'IndexedDB/https_mail.example_0.indexeddb.leveldb', 'Local Storage/leveldb', 'Service Worker/CacheStorage', 'Session Storage', 'Code Cache/js', 'GPUCache']) mkdirSync(join(dir, d), { recursive: true })
    writeFileSync(join(dir, 'Network', 'Cookies'), 'encrypted cookie')
    writeFileSync(join(dir, 'Preferences'), '{}')
    writeFileSync(join(dir, 'IndexedDB', 'https_mail.example_0.indexeddb.leveldb', '000003.log'), 'BAIT message body')
    writeFileSync(join(dir, 'Local Storage', 'leveldb', '000003.log'), 'BAIT bearer token')
    writeFileSync(join(dir, 'Service Worker', 'CacheStorage', 'body'), 'BAIT response body')
    mkdirSync(join(home, 'browser'), { recursive: true })
    writeFileSync(fusedMarkerOf(home), '{}')
    const logs: string[] = []
    assert.equal(prepareDiskPartition({ fuseOn: true, home, userData, log: m => { logs.push(m) } }), 'use')
    assert.deepEqual(readdirSync(dir).sort(), ['Network', 'Preferences'])
    assert.equal(readFileSync(join(dir, 'Network', 'Cookies'), 'utf8'), 'encrypted cookie', 'the logins survive')
    assert.deepEqual(logs, [])
    assert.deepEqual(wipePageStorage(dir, () => {}), [], 'nothing more to remove')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
