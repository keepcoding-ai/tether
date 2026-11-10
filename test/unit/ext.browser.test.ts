// The browser extension's manifest (Tether Browser E1): the system desk, the pad, the `web` pane type and the three
// settings of design §10, and its entries in the three extension indexes (a product extension: no test guard).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest, DESK_ID, PAD_ID } from '../../extensions/browser/manifest.ts'
import { EMPTY_HELP } from '../../extensions/browser/rules.ts'
import { manifest as explorer } from '../../extensions/explorer/manifest.ts'
import { systemDeskProblems } from '../../app/renderer/system-desk-rules.ts'
import { normalizeSetting } from '../../app/shared/vscode-configuration-registry.ts'

const ext = join(fileURLToPath(new URL('../../', import.meta.url)), 'extensions')

describe('browser extension manifest', () => {
  test('identity and hosts', () => {
    assert.equal(manifest.id, 'browser')
    assert.deepEqual([...manifest.hosts].sort(), ['daemon', 'main', 'renderer'])
  })

  test('the system desk "Browser" is valid and prefixed by the extension', () => {
    const [d, ...rest] = manifest.contributes!.systemDesks!
    assert.equal(rest.length, 0)
    assert.equal(d!.id, DESK_ID)
    assert.equal(d!.title, 'Browser')
    assert.deepEqual(systemDeskProblems(manifest.id, d!), [])
  })

  test('the pad "Guias" sits on the left bar below the explorer', () => {
    const [p, ...rest] = manifest.contributes!.pads!
    assert.equal(rest.length, 0)
    assert.equal(p!.id, PAD_ID)
    assert.equal(p!.title, 'Guias')
    assert.equal(p!.defaultSide, 'left')
    assert.ok(p!.order! > explorer.contributes!.pads![0]!.order!)
  })

  test('the `web` pane type keeps a saved pane in place', () => {
    const [t] = manifest.contributes!.paneTypes!
    assert.equal(t!.id, 'web')
    const o = t!.optionsOf({ id: 'web:1', title: 'Github', params: { a: 1 } })
    assert.deepEqual([o.id, o.component, o.tabComponent, o.title, o.params], ['web:1', t!.component, t!.tabComponent, 'Github', { a: 1 }])
  })

  test('settings follow design §10: serve off, evaluate off, local network asks', () => {
    const s = manifest.contributes!.settings!
    assert.deepEqual(Object.keys(s).sort(), ['evaluate', 'localNetwork', 'serveToAgents'])
    assert.equal(normalizeSetting(s.serveToAgents!, undefined), false)
    assert.equal(normalizeSetting(s.evaluate!, undefined), false)
    assert.equal(normalizeSetting(s.localNetwork!, undefined), 'ask')
    assert.equal(normalizeSetting(s.localNetwork!, 'nope'), 'ask')
    for (const [k, v] of Object.entries(s)) {
      assert.ok(v.description, k)
      if (v.type === 'string' && v.enumLabels) assert.equal(v.enumLabels.length, v.enum?.length)
    }
  })

  test('the empty state reads as design §5.3', () => {
    assert.equal(EMPTY_HELP, 'Nenhuma guia aberta. Quando um agente abrir uma, ela aparece aqui.')
  })

  test('listed in the three indexes without a test guard', () => {
    for (const host of ['renderer', 'main', 'daemon']) {
      const text = readFileSync(join(ext, `index.${host}.ts`), 'utf8')
      const line = text.split('\n').find(l => l.includes('browser.manifest'))
      assert.ok(line, `index.${host}.ts`)
      assert.ok(!line.includes('__TETHER_TEST_EXTENSIONS__'), `index.${host}.ts: no test guard`)
      assert.ok(text.includes(`'./browser/${host}.ts'`))
    }
  })
})
