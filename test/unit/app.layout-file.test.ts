// layout.json is overwritten only after its previous content moved to layout.json.bak, and a lost or corrupt
// layout.json is read from the backup: a crash or a bad save never costs the person their arrangement.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLayoutFile, saveLayoutFile } from '../../app/main/layout-file.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-layout-file-')
after(() => tmp.cleanup())

describe('layout file', () => {
  test('first save: no backup yet, the file is written whole', () => {
    const path = join(tmp.make(), 'layout.json')
    saveLayoutFile(path, { panels: { a: 1 } })
    assert.deepEqual(loadLayoutFile(path), { panels: { a: 1 } })
    assert.equal(existsSync(`${path}.bak`), false)
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false, 'the temp file was renamed away')
  })

  test('second save keeps the previous content in .bak', () => {
    const path = join(tmp.make(), 'layout.json')
    saveLayoutFile(path, { panels: { a: 1, b: 2 } })
    saveLayoutFile(path, { panels: { a: 1 } })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { panels: { a: 1 } })
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { panels: { a: 1, b: 2 } })
  })

  test('missing, empty or corrupt layout.json falls back to the backup', () => {
    const path = join(tmp.make(), 'layout.json')
    saveLayoutFile(path, { panels: { a: 1, b: 2 } })
    saveLayoutFile(path, { panels: { a: 1 } })
    writeFileSync(path, '')
    assert.deepEqual(loadLayoutFile(path), { panels: { a: 1, b: 2 } }, 'empty file')
    writeFileSync(path, '{"panels": {')
    assert.deepEqual(loadLayoutFile(path), { panels: { a: 1, b: 2 } }, 'corrupt file')
  })

  test('a corrupt layout.json never replaces a good backup on save', () => {
    const path = join(tmp.make(), 'layout.json')
    saveLayoutFile(path, { panels: { a: 1, b: 2 } })
    saveLayoutFile(path, { panels: { a: 1 } })
    writeFileSync(path, 'garbage')
    saveLayoutFile(path, { panels: {} })
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { panels: { a: 1, b: 2 } }, 'the backup of the last good save stays')
    assert.deepEqual(loadLayoutFile(path), { panels: {} })
  })

  test('nothing on disk: null', () => {
    assert.equal(loadLayoutFile(join(tmp.make(), 'layout.json')), null)
  })
})
