// Which `ext:<id>` main accepts from a page (app/shared/faults-ext.ts) stays in step with the extension indexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RENDERER_ONLY_EXTENSION_IDS } from '../../app/shared/faults-ext.ts'

test('the renderer-only extension ids main accepts are exactly the ones the renderer index has beyond main and daemon', () => {
  const dir = join(import.meta.dirname, '..', '..', 'extensions')
  const ids = (host: string): string[] => [...readFileSync(join(dir, `index.${host}.ts`), 'utf8').matchAll(new RegExp(String.raw`from './([\w-]+)/${host}\.ts'`, 'g'))].map(m => m[1]!)
  const only = ids('renderer').filter(id => !ids('main').includes(id) && !ids('daemon').includes(id)).sort()
  assert.ok(only.length > 0)
  assert.deepEqual([...RENDERER_ONLY_EXTENSION_IDS].sort(), only)
})
