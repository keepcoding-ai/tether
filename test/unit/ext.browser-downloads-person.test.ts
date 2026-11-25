// N7 (navegador da pessoa): her own tabs download like any browser, to the system's Downloads folder (here a temp folder standing
// in for it), never into the agents' tree `<home>/browser/downloads/`; the pad's "Baixados" still lists them under her owner id,
// from the tether's own list (never a listing of her folder). An agent's download is unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DownloadItem } from 'electron'
import { DownloadStore } from '../../extensions/browser/downloads.ts'
import { PERSON_OWNER } from '../../extensions/browser/tab-rules.ts'

function fakeItem(name: string, bytes: number): DownloadItem & { finish(): void } {
  const e = new EventEmitter() as EventEmitter & Record<string, unknown>
  let path = ''
  Object.assign(e, {
    getFilename: () => name, getURL: () => 'https://site.test/f', getTotalBytes: () => bytes, getReceivedBytes: () => bytes,
    setSavePath: (p: string) => { path = p }, cancel: () => { e.emit('done', {}, 'cancelled') },
    // The bytes are announced, not written: the ceiling is checked against the announced size.
    finish: () => { writeFileSync(path, 'x'); e.emit('done', {}, 'completed') },
  })
  return e as unknown as DownloadItem & { finish(): void }
}

test('her download goes to the Downloads folder, is listed as hers, and nothing of hers lands in the agents\' tree', () => {
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-dl-person-'))
  try {
    const browser = join(home, 'browser')
    mkdirSync(browser, { recursive: true })
    const system = join(home, 'Downloads')
    writeFileSync(join(home, 'unrelated.txt'), 'x')
    const store = new DownloadStore(browser, () => {}, system)
    const item = fakeItem('nota.txt', 70 * 1024 * 1024)
    store.take(item, PERSON_OWNER, 't1')
    item.finish()
    assert.ok(existsSync(join(system, 'nota.txt')), 'in her Downloads folder (no 50 MB ceiling of the agents)')
    assert.equal(existsSync(join(browser, 'downloads', PERSON_OWNER)), false, 'no person folder next to the agents\'')
    writeFileSync(join(system, 'outro.txt'), 'x')
    assert.deepEqual(store.list().map(e => [e.slotId, e.name]), [[PERSON_OWNER, 'nota.txt']], 'only what she downloaded through the tether')
    assert.equal(store.pathOf(PERSON_OWNER, 'nota.txt'), join(system, 'nota.txt'))
    assert.equal(store.pathOf(PERSON_OWNER, 'outro.txt'), undefined, 'a file of her folder she did not download here is not shown')
    // The list without the browser process (no Downloads folder known) still has hers.
    assert.deepEqual(new DownloadStore(browser, () => {}).list().map(e => e.name), ['nota.txt'])
    // An agent's download: its own folder, as before.
    const a = fakeItem('rel.txt', 10)
    store.take(a, 'a1b2c3d4', 't2')
    a.finish()
    assert.ok(existsSync(join(browser, 'downloads', 'a1b2c3d4', 'rel.txt')))
    assert.deepEqual(store.list().map(e => [e.slotId, e.name]).sort(), [['a1b2c3d4', 'rel.txt'], [PERSON_OWNER, 'nota.txt']])
    rmSync(join(system, 'nota.txt'))
    assert.deepEqual(store.list().map(e => e.slotId), ['a1b2c3d4'], 'a file she moved away leaves the list')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
