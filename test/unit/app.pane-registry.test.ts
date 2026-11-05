// The pane-type registry (F9 slice 0a, app/renderer/pane-registry.ts): the core pane kinds' layout side
// (app/renderer/core-pane-layouts.ts) must rebuild every pane of a layout.json exactly as it was saved (component,
// tab, title, params), the slotless rule must match the one the restore always used, and registrations dispose.
// The fixture (fixtures/layout-v2-panes.json) is synthesized in the shape the app writes: one pane of each kind.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CORE_PANE_LAYOUTS, previewPaneOptions } from '../../app/renderer/core-pane-layouts.ts'
import { allPanelIds, planRestore, type LayoutV2 } from '../../app/renderer/layout.ts'
import { PaneRegistry, type PaneLayout } from '../../app/renderer/pane-registry.ts'
import { isSlotlessPanelId } from '../../app/shared/empty.ts'
import { DisposableStore, dispose, toDisposable } from '../../app/shared/vscode-lifecycle.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/layout-v2-panes.json', import.meta.url), 'utf8')) as LayoutV2

interface SavedPanel { id: string; contentComponent: string; tabComponent: string; title: string; params: Record<string, unknown> }
function savedPanels(layout: LayoutV2): SavedPanel[] {
  const frames = [...layout.desks.map(d => d.frames), ...(layout.drawer ? [layout.drawer.frames] : [])]
  return frames.flatMap(f => Object.values(f.views).flatMap(v => Object.values(v.panels) as unknown as SavedPanel[]))
}

function coreRegistry(): PaneRegistry<PaneLayout> {
  const r = new PaneRegistry<PaneLayout>()
  for (const l of CORE_PANE_LAYOUTS) r.register(l)
  return r
}

describe('pane registry: layout.json compatibility', () => {
  const registry = coreRegistry()
  const panels = savedPanels(fixture)

  test('the fixture has one pane of every core kind', () => {
    assert.deepEqual(new Set(panels.map(p => p.contentComponent)), new Set(CORE_PANE_LAYOUTS.map(l => l.component)))
  })

  test('every saved pane rebuilds with the same component, tab, title and params', () => {
    for (const p of panels) {
      const o = registry.optionsOf({ id: p.id, title: p.title, params: p.params })
      assert.equal(o.id, p.id)
      assert.equal(o.component, p.contentComponent, p.id)
      assert.equal(o.tabComponent, p.tabComponent, p.id)
      assert.equal(o.title, p.title, p.id)
      assert.deepEqual(o.params, p.params, p.id)
    }
  })

  test('the factories are found by the saved component and tab names', () => {
    for (const p of panels) {
      assert.equal(registry.byComponent(p.contentComponent)?.component, p.contentComponent)
      assert.equal(registry.byTab(p.tabComponent)?.tabComponent, p.tabComponent)
    }
    assert.equal(registry.byComponent('desconhecido')?.id, 'terminal', 'dockview default component = the terminal')
    // Both previews share the tab name: the type that has a tab factory is the one asked.
    const live = new PaneRegistry<PaneLayout & { createTab?: () => string }>()
    for (const l of CORE_PANE_LAYOUTS) live.register(l.id === 'md-preview' ? { ...l, createTab: () => 'md' } : l)
    assert.equal(live.byTab('md-preview-tab')?.id, 'md-preview')
  })

  test('the html preview keeps its page mounted (renderer: always), the markdown one does not', () => {
    const html = panels.find(p => p.contentComponent === 'html-preview')!
    const md = panels.find(p => p.contentComponent === 'md-preview')!
    assert.equal(registry.optionsOf(html).renderer, 'always')
    assert.equal(registry.optionsOf(md).renderer, undefined)
    assert.deepEqual(previewPaneOptions('preview:x', 'C:\\a.html', 'html', undefined).params, { preview: { path: 'C:\\a.html', kind: 'html' } })
  })

  test('missing params get the defaults they always had', () => {
    assert.deepEqual(registry.optionsOf({ id: 'abc123' }).params, { slotId: 'abc123' })
    assert.deepEqual(registry.optionsOf({ id: 'empty:x' }).params, { empty: {} })
    assert.deepEqual(registry.optionsOf({ id: 'note:x' }).params, {})
    assert.deepEqual(registry.optionsOf({ id: 'keybindings:x', params: { stray: 1 } }).params, {})
  })

  test('slotless is the same rule as before, for every id of the fixture and a few more', () => {
    for (const id of [...allPanelIds(fixture), 'abc123', 'note:', 'preview:', 'empty:', 'keybindings:', 'notes', '']) {
      assert.equal(registry.isSlotless(id), isSlotlessPanelId(id), id)
    }
  })

  test('restore with the registry rule = restore with the old rule (pruning keeps the slotless panes)', () => {
    const known = new Set(['a1b2c3d4'])
    const before = planRestore(structuredClone(fixture), known)
    const after = planRestore(structuredClone(fixture), known, id => registry.isSlotless(id))
    assert.deepEqual(after, before)
    assert.deepEqual(after.orphaned, ['e5f6a7b8'])
    assert.ok(allPanelIds(after.layout!).includes('keybindings:mh1k2g0'))
    const untouched = planRestore(fixture, new Set(['a1b2c3d4', 'e5f6a7b8']), id => registry.isSlotless(id))
    assert.equal(untouched.layout, fixture, 'nothing to prune: the saved object itself')
  })
})

describe('pane registry: registration', () => {
  test('a duplicate id is refused; dispose unregisters', () => {
    const r = new PaneRegistry<PaneLayout>()
    const extra: PaneLayout = { id: 'demo', idPrefix: 'demo:', component: 'demo', tabComponent: 'demo-tab', hasSlot: false, optionsOf: p => ({ id: p.id, component: 'demo' }) }
    const d = r.register(extra)
    assert.throws(() => r.register(extra))
    assert.equal(r.byId('demo:1')?.id, 'demo')
    assert.equal(r.isSlotless('demo:1'), true)
    d.dispose()
    assert.equal(r.get('demo'), undefined)
    assert.equal(r.isSlotless('demo:1'), false)
  })

  test('the longest prefix wins; `owns` picks among types sharing a prefix', () => {
    const r = coreRegistry()
    r.register({ id: 'deep', idPrefix: 'note:deep:', component: 'deep', tabComponent: 'deep-tab', hasSlot: true, optionsOf: p => ({ id: p.id, component: 'deep' }) })
    assert.equal(r.byId('note:deep:1')?.id, 'deep')
    assert.equal(r.byId('note:1')?.id, 'note')
    assert.equal(r.bySaved({ id: 'preview:1', params: { preview: { path: 'a.html', kind: 'html' } } })?.id, 'html-preview')
    assert.equal(r.bySaved({ id: 'preview:1', params: { preview: { path: 'a.md' } } })?.id, 'md-preview')
  })
})

describe('vscode-lifecycle port', () => {
  test('toDisposable runs once; DisposableStore disposes each value once and leaks (with a warning) after dispose', () => {
    let n = 0
    const d = toDisposable(() => { n++ })
    d.dispose(); d.dispose()
    assert.equal(n, 1)
    const store = new DisposableStore()
    let m = 0
    const x = toDisposable(() => { m++ })
    store.add(x); store.add(x)
    store.dispose()
    assert.equal(m, 1)
    assert.equal(store.isDisposed, true)
    DisposableStore.DISABLE_DISPOSED_WARNING = true
    let late = 0
    store.add(toDisposable(() => { late++ }))
    DisposableStore.DISABLE_DISPOSED_WARNING = false
    assert.equal(late, 0)
  })

  test('dispose runs every item even when some throw, then rethrows', () => {
    let ran = 0
    const boom = toDisposable(() => { ran++; throw new Error('a') })
    const ok = toDisposable(() => { ran++ })
    assert.throws(() => dispose([boom, ok]), /a/)
    assert.equal(ran, 2)
    const two = [toDisposable(() => { throw new Error('x') }), toDisposable(() => { throw new Error('y') })]
    assert.throws(() => dispose(two), AggregateError)
  })
})
