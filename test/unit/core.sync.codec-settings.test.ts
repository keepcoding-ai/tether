import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_LOCAL_SETTINGS, exportSettings, importSettings } from '../../src/core/sync/codecs/settings.ts'

const machineA = (): Record<string, unknown> => ({
  window: { x: 10, y: 20, width: 1200, height: 800, maximized: false, fullscreen: false },
  trayNoticeShown: true,
  terminal: { preset: 'dark', font: 'Cascadia', fontSize: 14, ligatures: true },
  theme: 'night',
  ui: { tabClose: 'hover', dimUnfocused: true },
  extensions: { disabled: ['x'], browser: { serveToAgents: true, evaluate: false } },
  extensionState: { browser: { lastDir: 'C:\\Users\\a\\dl' } },
})

const keys = (): unknown => [{ key: 'ctrl+t', command: 'tab.new' }, { key: 'ctrl+w', command: 'tab.close' }]

describe('exportSettings', () => {
  test('default local paths stay out of the entities', () => {
    const coll = exportSettings(machineA(), keys()).entities.settings ?? {}
    const s = coll.settings as Record<string, unknown>
    for (const p of DEFAULT_LOCAL_SETTINGS) assert.equal(p in s, false, p)
    assert.equal(s.theme, 'night')
    assert.deepEqual(coll.keybindings, { keybindings: keys() })
  })

  test('extra local path is added to the defaults; emptied objects are removed', () => {
    const { entities } = exportSettings(machineA(), undefined, ['extensions.browser.serveToAgents', 'extensions.browser.evaluate'])
    const coll = entities.settings ?? {}
    const s = coll.settings as { extensions: Record<string, unknown> }
    assert.deepEqual(s.extensions, { disabled: ['x'] })
    assert.equal('keybindings' in coll, false)
  })

  test('leaks: win32, UNC and posix paths are reported; ~ and URLs are not', () => {
    const settings = {
      extensions: { note: { x: 'C:\\Users\\a\\n', y: '~/notes', z: 'https://a.b/c/d', u: '\\\\srv\\share', p: '/home/a/n', short: '/tmp' } },
      window: { dir: 'D:\\local' },
    }
    const kb = [{ key: 'a' }, { key: 'b' }, { key: 'c', args: '/usr/local/bin' }]
    const { leaks } = exportSettings(settings, kb)
    assert.deepEqual(leaks.sort(), [
      'keybindings[2].args',
      'settings.extensions.note.p',
      'settings.extensions.note.u',
      'settings.extensions.note.x',
    ])
  })

  test('does not mutate the inputs', () => {
    const s = machineA()
    const k = keys()
    const sCopy = structuredClone(s)
    const kCopy = structuredClone(k)
    exportSettings(s, k, ['extensions.browser'])
    assert.deepEqual(s, sCopy)
    assert.deepEqual(k, kCopy)
  })
})

describe('importSettings', () => {
  test('round trip on the same machine is identical and unchanged', () => {
    const s = machineA()
    const k = keys()
    const { entities } = exportSettings(s, k)
    const r = importSettings(entities, { settings: s, keybindings: k })
    assert.deepEqual(r.settings, s)
    assert.deepEqual(r.keybindings, k)
    assert.deepEqual(r.changed, { settings: false, keybindings: false })
  })

  test('two machines: B gets the preferences of A and keeps its own window and extensionState', () => {
    const { entities } = exportSettings(machineA(), keys())
    const b = {
      window: { x: 0, y: 0, width: 800, height: 600 },
      theme: 'day',
      extensionState: { browser: { lastDir: '/home/b' } },
    }
    const r = importSettings(entities, { settings: b, keybindings: [] })
    assert.deepEqual(r.settings.window, b.window)
    assert.deepEqual(r.settings.extensionState, b.extensionState)
    assert.equal(r.settings.theme, 'night')
    assert.equal('trayNoticeShown' in r.settings, false)
    assert.deepEqual(r.keybindings, keys())
    assert.deepEqual(r.changed, { settings: true, keybindings: true })
  })

  test('nested local path lives with the sibling that traveled', () => {
    const local = ['extensions.browser.serveToAgents']
    const { entities } = exportSettings(machineA(), keys(), local)
    const b = { extensions: { browser: { serveToAgents: false, evaluate: true } } }
    const r = importSettings(entities, { settings: b, keybindings: keys() }, local)
    assert.deepEqual(r.settings.extensions, { disabled: ['x'], browser: { serveToAgents: false, evaluate: false } })
  })

  test('local path present in the entity is dropped in favor of the local one', () => {
    const entities = { settings: { settings: { theme: 'night', window: { x: 99 }, trayNoticeShown: true } } }
    const r = importSettings(entities, { settings: { window: { x: 1 } }, keybindings: undefined })
    assert.deepEqual(r.settings, { theme: 'night', window: { x: 1 } })
  })

  test('local path missing here is not invented', () => {
    const entities = { settings: { settings: { theme: 'night', window: { x: 99 } } } }
    const r = importSettings(entities, { settings: {}, keybindings: undefined })
    assert.deepEqual(r.settings, { theme: 'night' })
  })

  test('without entities the current stays intact', () => {
    const cur = { settings: machineA(), keybindings: keys() }
    const r = importSettings({}, cur)
    assert.deepEqual(r.settings, cur.settings)
    assert.deepEqual(r.keybindings, cur.keybindings)
    assert.deepEqual(r.changed, { settings: false, keybindings: false })
  })

  test('keybindings: absent in the entities keeps current; present replaces', () => {
    const cur = { settings: {}, keybindings: keys() }
    const only = importSettings({ settings: { settings: { theme: 'x' } } }, cur)
    assert.deepEqual(only.keybindings, keys())
    assert.equal(only.changed.keybindings, false)
    const r = importSettings({ settings: { keybindings: { keybindings: [] } } }, cur)
    assert.deepEqual(r.keybindings, [])
    assert.equal(r.changed.keybindings, true)
  })

  test('key order does not count as a change', () => {
    const r = importSettings({ settings: { settings: { b: 1, a: { y: 2, x: 1 } } } }, { settings: { a: { x: 1, y: 2 }, b: 1 }, keybindings: undefined })
    assert.equal(r.changed.settings, false)
  })

  test('malformed entities are ignored', () => {
    const cur = { settings: { theme: 'day' }, keybindings: keys() }
    for (const bad of [
      { settings: { settings: 'oops', keybindings: 5 } },
      { settings: { settings: [1, 2], keybindings: { nope: 1 } } },
      { settings: null },
    ] as unknown as Record<string, Record<string, unknown>>[]) {
      const r = importSettings(bad, cur)
      assert.deepEqual(r.settings, cur.settings)
      assert.deepEqual(r.keybindings, cur.keybindings)
      assert.deepEqual(r.changed, { settings: false, keybindings: false })
    }
  })

  test('does not mutate the inputs', () => {
    const { entities } = exportSettings(machineA(), keys())
    const cur = { settings: { window: { x: 1 }, theme: 'day' } as Record<string, unknown>, keybindings: [] as unknown }
    const eCopy = structuredClone(entities)
    const cCopy = structuredClone(cur)
    const r = importSettings(entities, cur)
    ;(r.settings.terminal as Record<string, unknown>).font = 'changed'
    assert.deepEqual(entities, eCopy)
    assert.deepEqual(cur, cCopy)
  })
})
