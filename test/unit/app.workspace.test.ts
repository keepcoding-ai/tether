// The window's projects (F8 slice 0, app/renderer/workspace.ts): inference only from AI agents' panes and from the folder
// the agent was opened in, gone with the last agent; pinned until closed; open = open and pin, idempotent; the pin toggle;
// unpinning with agents left makes it inferred; stable order of arrival; names; folderOf; followTarget; tolerant read;
// the ported compareFolders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPanes, compareFolders, deriveFolders, EMPTY_WORKSPACE, folderOf, followTarget, isEmptyChange, moveFolder, openFolder, pinnedInOrder, readWorkspace, togglePin, unpinFolder, workspaceCommands, type PaneSource, type ProjectFolder, type WorkspaceState } from '../../app/renderer/workspace.ts'

const CI = true
const A = 'C:\\work\\alpha'
const B = 'C:\\work\\beta'
const claude = (id: string, cwd: string): PaneSource => ({ id, kind: 'claude', cwd })
const shell = (id: string, cwd: string): PaneSource => ({ id, kind: 'shell', cwd })
const derive = (panes: PaneSource[], state: WorkspaceState = EMPTY_WORKSPACE, prev: ProjectFolder[] = []): ProjectFolder[] => deriveFolders(prev, state, panes, CI)

test('two agent panes in one folder infer one project, held by both', () => {
  const f = derive([claude('s1', A), claude('s2', A)])
  assert.deepEqual(f, [{ path: A, name: 'alpha', pinned: false, agents: ['s1', 's2'] }])
})

test('a plain terminal infers nothing; a pane without a slot neither', () => {
  assert.deepEqual(derive([shell('t1', A), { id: 'note-1', cwd: B }, { id: 'x' }]), [])
  assert.deepEqual(agentPanes([shell('t1', A), claude('c', B), { id: 'soul', kind: 'soul', cwd: A }]), [{ id: 'c', cwd: B }, { id: 'soul', cwd: A }])
})

test('the inferred project goes away with the last agent pane', () => {
  let f = derive([claude('s1', A), claude('s2', A)])
  f = derive([claude('s2', A)], EMPTY_WORKSPACE, f)
  assert.deepEqual(f.map(x => x.agents), [['s2']])
  f = derive([], EMPTY_WORKSPACE, f)
  assert.deepEqual(f, [])
})

test('cd is not followed: only the slot folder counts (a shell in another folder, the agent opened in A)', () => {
  // The slot's cwd is the folder the agent was opened in; nothing the terminal does later changes it.
  const f = derive([claude('s1', A), shell('t', 'C:\\elsewhere')])
  assert.deepEqual(f.map(x => x.path), [A])
})

test('opening a folder pins it; opening it again is the very same state (idempotent, case and trailing slash folded)', () => {
  const s1 = openFolder(EMPTY_WORKSPACE, B, CI)
  assert.deepEqual(s1, { pinned: [{ path: B }] })
  assert.equal(openFolder(s1, B, CI), s1)
  assert.equal(openFolder(s1, 'c:/work/BETA/', CI), s1)
  assert.equal(openFolder(s1, '  ', CI), s1)
  assert.deepEqual(derive([], s1), [{ path: B, name: 'beta', pinned: true, agents: [] }])
})

test('opening an inferred folder promotes it in place (pinned, same position)', () => {
  let f = derive([claude('s1', A), claude('s2', B)])
  const s = openFolder(EMPTY_WORKSPACE, A, CI)
  f = derive([claude('s1', A), claude('s2', B)], s, f)
  assert.deepEqual(f.map(x => [x.path, x.pinned]), [[A, true], [B, false]])
})

test('a pinned project stays without agents; unpinning closes it then', () => {
  const s = openFolder(EMPTY_WORKSPACE, A, CI)
  let f = derive([claude('s1', A)], s)
  f = derive([], s, f)
  assert.deepEqual(f.map(x => [x.path, x.pinned, x.agents.length]), [[A, true, 0]])
  f = derive([], unpinFolder(s, A, CI), f)
  assert.deepEqual(f, [])
})

test('unpinning while agents reference it makes it inferred', () => {
  const s = openFolder(EMPTY_WORKSPACE, A, CI)
  let f = derive([claude('s1', A)], s)
  f = derive([claude('s1', A)], unpinFolder(s, A, CI), f)
  assert.deepEqual(f, [{ path: A, name: 'alpha', pinned: false, agents: ['s1'] }])
  assert.equal(unpinFolder(EMPTY_WORKSPACE, A, CI), EMPTY_WORKSPACE, 'unpinning what is not pinned changes nothing')
})

test('the toggle: inferred → pinned → unpinned', () => {
  const s1 = togglePin(EMPTY_WORKSPACE, A, CI)
  assert.deepEqual(s1.pinned, [{ path: A }])
  assert.deepEqual(togglePin(s1, A.toUpperCase(), CI).pinned, [])
})

test('order of arrival is stable: an inferred folder coming and going does not reorder the others', () => {
  let f = derive([claude('s1', A)])
  f = derive([claude('s1', A), claude('s2', B)], EMPTY_WORKSPACE, f)
  f = derive([claude('s3', 'C:\\work\\gamma'), claude('s1', A), claude('s2', B)], EMPTY_WORKSPACE, f)
  assert.deepEqual(f.map(x => x.name), ['alpha', 'beta', 'gamma'])
  // On a fresh start (no prev) the pinned roots come first, in their saved order.
  const s = { pinned: [{ path: B }] }
  assert.deepEqual(derive([claude('s1', A)], s).map(x => x.name), ['beta', 'alpha'])
})

test('the first spelling wins and case-insensitive paths are one folder', () => {
  const f = derive([claude('s1', A), claude('s2', 'c:\\WORK\\Alpha\\')])
  assert.equal(f.length, 1)
  assert.equal(f[0]!.path, A)
  // case-sensitive (linux): two folders
  assert.equal(deriveFolders([], EMPTY_WORKSPACE, [claude('s1', '/w/a'), claude('s2', '/w/A')], false).length, 2)
})

test('equal names get the parent in parentheses', () => {
  const f = derive([claude('s1', 'C:\\x\\tether'), claude('s2', 'D:\\old\\tether')])
  assert.deepEqual(f.map(x => x.name), ['tether (x)', 'tether (old)'])
})

test('moveFolder and the pinned order that follows it', () => {
  const s = { pinned: [{ path: A }, { path: B }] }
  const f = derive([], s)
  const moved = moveFolder(f, B, 'up', CI)
  assert.deepEqual(moved.map(x => x.name), ['beta', 'alpha'])
  assert.deepEqual(pinnedInOrder(moved), { pinned: [{ path: B }, { path: A }] })
  assert.deepEqual(moveFolder(f, A, 'up', CI).map(x => x.name), ['alpha', 'beta'], 'the first cannot go up')
  // derive keeps a moved order
  assert.deepEqual(derive([], pinnedInOrder(moved), moved).map(x => x.name), ['beta', 'alpha'])
})

test('folderOf: the folder itself, a path inside, never a sibling prefix; the innermost when nested', () => {
  const f = derive([claude('s1', A), claude('s2', `${A}\\sub`)])
  assert.equal(folderOf(f, A, CI)?.path, A)
  assert.equal(folderOf(f, `${A}\\src\\x.ts`, CI)?.path, A)
  assert.equal(folderOf(f, `${A}\\sub\\y`, CI)?.path, `${A}\\sub`)
  assert.equal(folderOf(f, 'C:\\work\\alphabet', CI), undefined)
  assert.equal(folderOf(f, undefined, CI), undefined)
})

test('followTarget: only an agent pane moves the current project', () => {
  const f = derive([claude('s1', A)])
  assert.equal(followTarget({ agent: 'claude', cwd: `${A}\\sub` }, f, CI), A)
  assert.equal(followTarget({ cwd: A }, f, CI), undefined, 'a shell / a note')
  assert.equal(followTarget(undefined, f, CI), undefined)
})

test('readWorkspace is tolerant: absent, malformed, duplicates, bare strings', () => {
  assert.deepEqual(readWorkspace(undefined), EMPTY_WORKSPACE)
  assert.deepEqual(readWorkspace({ pinned: 'x' }), EMPTY_WORKSPACE)
  assert.deepEqual(readWorkspace({ pinned: [{ path: A }, { path: A }, { nope: 1 }, 3, B, { path: '' }] }), { pinned: [{ path: A }, { path: B }] })
})

test('compareFolders (ported): added, removed, changed (moved, pinned, agents)', () => {
  const f1 = derive([claude('s1', A)])
  const f2 = derive([claude('s1', A), claude('s2', B)], EMPTY_WORKSPACE, f1)
  let e = compareFolders(f1, f2, CI)
  assert.deepEqual([e.added.map(x => x.name), e.removed.length, e.changed.length], [['beta'], 0, 0])
  e = compareFolders(f2, derive([claude('s2', B)], EMPTY_WORKSPACE, f2), CI)
  assert.deepEqual([e.added.length, e.removed.map(x => x.name), e.changed.map(x => x.name)], [0, ['alpha'], ['beta']]) // beta moved to index 0
  assert.ok(isEmptyChange(compareFolders(f2, derive([claude('s1', A), claude('s2', B)], EMPTY_WORKSPACE, f2), CI)))
  e = compareFolders(f1, derive([claude('s1', A)], openFolder(EMPTY_WORKSPACE, A, CI), f1), CI)
  assert.deepEqual(e.changed.map(x => x.pinned), [true])
})

test('the palette commands: "Abrir pasta como projeto…" and the pin toggle (unavailable without a project)', () => {
  const calls: string[] = []
  let target: ProjectFolder | undefined
  const cmds = workspaceCommands({ pickAndOpen: () => calls.push('pick'), toggleTarget: () => target, togglePin: p => calls.push(`toggle ${p}`) })
  const open = cmds.find(c => c.id === 'workspace.open-folder')!
  const pin = cmds.find(c => c.id === 'workspace.toggle-pin')!
  assert.equal(open.title, 'Abrir pasta como projeto…')
  assert.equal(pin.title, 'Fixar/Desafixar projeto')
  const ctx = { pane: false, desks: 1, drawerOpen: false, focus: 'none' as const }
  assert.equal(pin.when?.(ctx), false)
  target = derive([claude('s1', A)])[0]
  assert.equal(pin.when?.(ctx), true)
  open.run('palette'); pin.run('palette')
  assert.deepEqual(calls, ['pick', `toggle ${A}`])
})
