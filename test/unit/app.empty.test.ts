// The empty pane (F5): its id and params (app/shared/empty.ts), the layout never pruning it (app/renderer/layout.ts),
// what a chooser's pick means (app/renderer/chooser-rules.ts), the commands and the chord that make one
// (app/renderer/app-commands.ts, app/renderer/shortcuts.ts), and the editor keeping every arrow chord.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Profile } from '../../src/daemon/protocol.ts'
import { appCommands, type CommandHost } from '../../app/renderer/app-commands.ts'
import { choiceNeedsFolder, choiceOf, chooserItems, EMPTY_ITEM, NOTE_NEW_ITEM, NOTE_OPEN_ITEM } from '../../app/renderer/chooser-rules.ts'
import { CommandRegistry, type CommandContext } from '../../app/renderer/commands.ts'
import { editorKeyOwner, terminalKeyOwner } from '../../app/renderer/key-capture.ts'
import { emptyLayout, orphanedPanels, planRestore, type LayoutV2 } from '../../app/renderer/layout.ts'
import { shortcutHint, shortcutOf, type KeyLike } from '../../app/renderer/shortcuts.ts'
import { emptyParams, EMPTY_TITLE, isEmptyPanelId, isSlotlessPanelId, newEmptyPanelId, withEmpty } from '../../app/shared/empty.ts'
import { newNotePanelId } from '../../app/shared/notes.ts'

const key = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyLike =>
  ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

const PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', agent: 'claude', args: [], default: true },
  { id: 'powershell', name: 'PowerShell', agent: 'shell', args: [], default: true },
] as Profile[]

describe('empty pane identity and params', () => {
  test('ids carry the empty prefix, sort by time, and are slotless like a note', () => {
    const a = newEmptyPanelId(1000, 0.1)
    const b = newEmptyPanelId(2000, 0.1)
    assert.ok(isEmptyPanelId(a) && isEmptyPanelId(b) && a < b)
    assert.notEqual(newEmptyPanelId(1000, 0.1), newEmptyPanelId(1000, 0.9))
    assert.ok(isSlotlessPanelId(a) && isSlotlessPanelId(newNotePanelId()))
    assert.ok(!isSlotlessPanelId('3f2a9c') && !isEmptyPanelId('note:x') && !isEmptyPanelId(''))
    assert.equal(EMPTY_TITLE, 'Vazio')
  })

  test('params keep only the suggested folder; an empty string is no folder', () => {
    assert.deepEqual(withEmpty('D:\\p'), { empty: { cwd: 'D:\\p' } })
    assert.deepEqual(withEmpty(undefined), { empty: {} })
    assert.deepEqual(emptyParams({ empty: { cwd: 'D:\\p' } }), { cwd: 'D:\\p' })
    assert.deepEqual(emptyParams({ empty: { cwd: '' } }), {})
    assert.deepEqual(emptyParams({ empty: {} }), {})
    assert.equal(emptyParams({ slotId: 'x' }), undefined)
    assert.equal(emptyParams(undefined), undefined)
  })
})

/** A layout with one frame holding `ids` as tabs of one group. */
function layoutWith(ids: string[]): LayoutV2 {
  const l = emptyLayout()
  const panels: Record<string, { id: string; contentComponent: string; title: string }> = {}
  for (const id of ids) panels[id] = { id, contentComponent: id.startsWith('empty:') ? 'empty' : 'terminal', title: id }
  l.desks[0]!.frames.views['frame-1'] = {
    grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ids, activeView: ids[0]!, id: 'g1' }, size: 800 }], size: 600 }, width: 800, height: 600, orientation: 'HORIZONTAL' },
    panels,
    activeGroup: 'g1',
  } as unknown as LayoutV2['desks'][0]['frames']['views'][string]
  return l
}

describe('an empty pane survives the restore', () => {
  const empty = newEmptyPanelId(5000, 0.3)

  test('never an orphan, whatever the daemon knows', () => {
    assert.deepEqual(orphanedPanels(['a', empty, 'b'], new Set(['a'])), ['b'])
    assert.deepEqual(orphanedPanels([empty], new Set(['zzz'])), [])
  })

  test('kept when the daemon forgot the slot beside it; kept when the daemon knows nothing', () => {
    const saved = layoutWith(['a', empty, 'b'])
    const plan = planRestore(saved, new Set(['a']))
    assert.deepEqual(plan.orphaned, ['b'])
    const views = Object.keys(plan.layout!.desks[0]!.frames.views['frame-1']!.panels)
    assert.deepEqual(views.sort(), ['a', empty].sort(), 'the empty pane is not pruned with the forgotten slot')
    const untouched = planRestore(saved, new Set())
    assert.equal(untouched.layout, saved, 'an empty daemon list prunes nothing')
  })

  test('a layout of empty panes only (the person arranged the space first) comes back whole', () => {
    const e2 = newEmptyPanelId(6000, 0.3)
    const saved = layoutWith([empty, e2])
    const plan = planRestore(saved, new Set(['some-live-slot']))
    assert.deepEqual(plan.orphaned, [])
    assert.deepEqual(Object.keys(plan.layout!.desks[0]!.frames.views['frame-1']!.panels), [empty, e2])
  })
})

describe('what a chooser pick means (dialog and empty pane alike)', () => {
  test('the items besides the profiles: the notes everywhere; the empty pane only in the contextless popup', () => {
    const popup = chooserItems(PROFILES, { empty: true }).filter(i => i.kind !== 'profile')
    const pane = chooserItems(PROFILES, { empty: false }).filter(i => i.kind !== 'profile')
    assert.deepEqual(popup.map(i => i.id), [NOTE_NEW_ITEM.id, NOTE_OPEN_ITEM.id, EMPTY_ITEM.id])
    assert.deepEqual(pane.map(i => i.id), [NOTE_NEW_ITEM.id, NOTE_OPEN_ITEM.id])
    for (const item of popup) assert.ok(item.id.startsWith('kind:') && item.name && item.hint, item.id)
  })

  test('choiceOf: a profile by id, a kind by its value, nothing for the unknown', () => {
    assert.deepEqual(choiceOf('powershell', PROFILES), { kind: 'profile', profile: PROFILES[1] })
    assert.deepEqual(choiceOf('kind:empty', PROFILES), { kind: 'empty' })
    assert.deepEqual(choiceOf('kind:note-new', PROFILES), { kind: 'note-new' })
    assert.deepEqual(choiceOf('kind:note-open', PROFILES), { kind: 'note-open' })
    assert.equal(choiceOf('kind:what', PROFILES), undefined)
    assert.equal(choiceOf('gone-profile', PROFILES), undefined)
    assert.equal(choiceOf(undefined, PROFILES), undefined)
  })

  test('only a process needs the folder; a note and an empty pane fall back to the person\'s folder', () => {
    assert.equal(choiceNeedsFolder({ kind: 'profile', profile: PROFILES[0]! }), true)
    assert.equal(choiceNeedsFolder({ kind: 'empty' }), false)
    assert.equal(choiceNeedsFolder({ kind: 'note-new' }), false)
    assert.equal(choiceNeedsFolder({ kind: 'note-open' }), false)
  })
})

describe('the commands and the chord of the empty pane', () => {
  const calls: string[] = []
  const log = (name: string) => (...args: unknown[]): void => { calls.push([name, ...args.map(a => JSON.stringify(a))].join(' ')) }
  const host = new Proxy({} as CommandHost, { get: (_t, p) => (p === 'activePane' ? () => 'slot-1' : log(String(p))) })
  const list = appCommands(host)
  const byId = new Map(list.map(c => [c.id, c]))
  const CTX: CommandContext = { pane: true, desks: 2, drawerOpen: false, focus: 'terminal' }

  test('the ids and titles: Dividir … (vazio) at the pane and frame levels, Novo quadro vazio, Nova mesa vazia', () => {
    assert.equal(byId.get('pane.split-empty.pane.right')!.title, 'Dividir à direita (vazio)')
    assert.equal(byId.get('pane.split-empty.pane.left')!.title, 'Dividir à esquerda (vazio)')
    assert.equal(byId.get('pane.split-empty.pane.above')!.title, 'Dividir acima (vazio)')
    assert.equal(byId.get('pane.split-empty.pane.below')!.title, 'Dividir abaixo (vazio)')
    assert.equal(byId.get('pane.split-empty.frame.right')!.title, 'Dividir na borda do quadro, à direita (vazio)')
    assert.equal(byId.get('frame.new-empty.right')!.title, 'Novo quadro vazio à direita')
    assert.equal(byId.get('frame.new-empty.above')!.title, 'Novo quadro vazio acima')
    assert.equal(byId.get('desk.new-empty')!.title, 'Nova mesa vazia')
  })

  test('Ctrl+Shift+Arrow splits empty beside the pane (the frame and desk levels have no chord; Ctrl+Alt+N stays the desk\'s)', () => {
    const r = new CommandRegistry(() => CTX)
    r.register(...list)
    assert.equal(shortcutOf(key('ArrowRight', { ctrl: true, shift: true }), false), 'pane.split-empty.pane.right')
    assert.equal(shortcutOf(key('ArrowUp', { ctrl: true, shift: true }), false), 'pane.split-empty.pane.above')
    assert.equal(shortcutOf(key('ArrowDown', { ctrl: true, shift: true }), false), 'pane.split-empty.pane.below')
    assert.equal(r.hint(byId.get('pane.split-empty.pane.right')!, false), 'Ctrl+Shift+→')
    assert.equal(r.hint(byId.get('pane.split-empty.frame.right')!, false), '')
    assert.equal(r.hint(byId.get('frame.new-empty.right')!, false), '')
    assert.equal(r.hint(byId.get('desk.new-empty')!, false), '')
    // The existing chords are untouched (the desk's key is Ctrl+Shift+N since delivery 5).
    assert.equal(shortcutHint('pane.duplicate.pane.right', false), 'Ctrl+Alt+→')
    assert.equal(shortcutHint('pane.duplicate.frame.right', false), 'Ctrl+Alt+Shift+→')
    assert.equal(shortcutHint('pane.duplicate.desk.right', false), 'Alt+Shift+→')
    assert.equal(shortcutHint('desk.new', false), 'Ctrl+Shift+N')
  })

  test('running goes to the host with the target', async () => {
    calls.length = 0
    const r = new CommandRegistry(() => CTX)
    r.register(...list)
    await r.run('pane.split-empty.pane.left', 'key')
    await r.run('pane.split-empty.frame.below', 'palette')
    await r.run('frame.new-empty.above')
    await r.run('desk.new-empty')
    // From the chord the pane is a request (origin add); from the palette or anywhere else it is layout.
    assert.deepEqual(calls, ['splitEmpty {"level":"pane","placement":"left"} "add"', 'splitEmpty {"level":"frame","placement":"below"} "layout"', 'splitEmpty {"level":"desk","placement":"above"} "layout"', 'newEmptyDesk'])
  })

  test('from a terminal the chord is the app\'s; inside a note every arrow chord is the editor\'s (Ctrl+Shift+→ selects by word)', () => {
    assert.equal(terminalKeyOwner(key('ArrowRight', { ctrl: true, shift: true }), false).owner, 'app')
    assert.deepEqual(editorKeyOwner(key('ArrowRight', { ctrl: true, shift: true }), false), { owner: 'editor' })
    assert.deepEqual(editorKeyOwner(key('ArrowDown', { ctrl: true, shift: true }), false), { owner: 'editor' })
    assert.equal(editorKeyOwner(key('KeyT', { ctrl: true, shift: true }), false).owner, 'app')
  })
})
