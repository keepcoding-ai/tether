// Robustness of the extensions' menu rows (agent door, slice R3): a provider that throws or answers badly never breaks the
// menu or hides another extension's rows; rows go with their provider (dispose) and with their extension (removeOwner).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorHost } from '../../app/renderer/door/host.ts'
import { collect, withDeskMenuGroup, withPaneMenuItems } from '../../app/renderer/door/menus.ts'
import type { ContextMenuEntry, PaneInfo } from '../../app/renderer/ext-api.ts'

const pane: PaneInfo = { id: 'note:1', type: 'note' }
const row = (label: string): ContextMenuEntry => ({ icon: 'x', label, run: () => {} })
const labels = (es: readonly ContextMenuEntry[]): string[] => es.map(e => (e === 'sep' ? '—' : e.label))

/** The console error of a provider that threw is expected here; keep the test output clean. */
function quiet<T>(fn: () => T): { out: T; errors: number } {
  const orig = console.error
  let errors = 0
  console.error = () => { errors++ }
  try { return { out: fn(), errors } } finally { console.error = orig }
}

describe('door menus: providers', () => {
  test('a provider that throws is dropped and the others still answer', () => {
    const door = new DoorHost()
    door.paneMenu('bad', () => { throw new Error('boom') })
    door.paneMenu('good', p => [row(`para ${p.id}`)])
    door.deskMenu('bad', () => { throw new Error('boom') })
    door.deskMenu('good', id => [row(`mesa ${id}`)])
    const pm = quiet(() => door.paneMenuItems(pane))
    const dm = quiet(() => door.deskMenuItems('d1'))
    assert.deepEqual(labels(pm.out), ['para note:1'])
    assert.deepEqual(labels(dm.out), ['mesa d1'])
    assert.equal(pm.errors, 1)
    assert.equal(dm.errors, 1)
  })

  test('a provider that answers something that is not a list adds nothing', () => {
    const out = collect([{ ext: 'x', fn: () => undefined as unknown as ContextMenuEntry[] }, { ext: 'y', fn: () => [row('A')] }], 0, 'test')
    assert.deepEqual(labels(out), ['A'])
  })

  test('every extension is asked each time the menu opens, in the order they registered', () => {
    const door = new DoorHost()
    let calls = 0
    door.paneMenu('a', () => [row(`A${++calls}`)])
    door.paneMenu('b', () => [row('B')])
    assert.deepEqual(labels(door.paneMenuItems(pane)), ['A1', 'B'])
    assert.deepEqual(labels(door.paneMenuItems(pane)), ['A2', 'B'])
  })

  test('no pane: no rows, and no provider is asked', () => {
    const door = new DoorHost()
    let asked = false
    door.paneMenu('a', () => { asked = true; return [row('A')] })
    assert.deepEqual(door.paneMenuItems(undefined), [])
    assert.equal(asked, false)
  })

  test('disposing a provider, or removing its extension, takes its rows away', () => {
    const door = new DoorHost()
    const d = door.paneMenu('a', () => [row('A')])
    door.paneMenu('b', () => [row('B')])
    door.deskMenu('b', () => [row('B')])
    d.dispose()
    assert.deepEqual(labels(door.paneMenuItems(pane)), ['B'])
    door.removeOwner('b')
    assert.deepEqual(door.paneMenuItems(pane), [])
    assert.deepEqual(door.deskMenuItems('d1'), [])
  })
})

describe('door menus: placement', () => {
  const SEP = 'sep' as const
  const labelOf = (e: ContextMenuEntry): string | undefined => (e === SEP ? undefined : e.label)

  test('separators of the extension rows are tidied (leading, trailing, doubled)', () => {
    const out = withDeskMenuGroup<ContextMenuEntry>([row('Renomear'), row('Hibernar mesa')], [SEP, row('A'), SEP, SEP, row('B'), SEP], SEP, labelOf, ['Hibernar mesa'])
    assert.deepEqual(labels(out), ['Renomear', '—', 'A', '—', 'B', '—', 'Hibernar mesa'])
  })

  test('the rows sit before the floor of a pane menu, whatever the pane type', () => {
    const isFloor = (e: ContextMenuEntry): boolean => e !== SEP && (e.label === 'Copiar link do painel' || e.label.startsWith('Fechar'))
    for (const base of [['Reiniciar', '—', 'Copiar link do painel', 'Fechar painel…'], ['Revelar', 'Fechar', '—', 'Copiar link do painel'], ['Copiar link do painel', 'Fechar guia']]) {
      const out = labels(withPaneMenuItems<ContextMenuEntry>(base.map(l => (l === '—' ? SEP : row(l))), [row('Dar a guia')], SEP, isFloor))
      const at = out.indexOf('Dar a guia')
      assert.ok(at >= 0, base.join(','))
      assert.ok(out.slice(at + 1).every(l => l === '—' || isFloor(row(l))), `only the floor after the rows: ${out.join(',')}`)
    }
  })
})
