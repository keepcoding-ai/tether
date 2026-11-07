// The note tab's rules (F5, delivery 1): pane ids and params (app/shared/notes.ts), file naming and folders
// (app/main/note-files.ts), the atomic write, the `.gitignore` question, what an outside change means, how a
// Monaco action becomes a command (app/renderer/note-rules.ts), the layout never pruning a note, and the chords
// the editor keeps from the app (app/renderer/key-capture.ts).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addTetherToGitignore, findGitRoot, gitignoreStatus, notesDirFor, prepareNote, readNote, renameNote, userNotesDir, writeNote, writeTextAtomic } from '../../app/main/note-files.ts'
import { editorKeyOwner } from '../../app/renderer/key-capture.ts'
import { withQuickOpenKeybindings } from './quick-open-extension.ts'
import { emptyLayout, orphanedPanels, planRestore, type Layout } from '../../app/renderer/layout.ts'
import { chordFromLabel, editorCommandId, paneCwdOfNote } from '../../app/renderer/note-rules.ts'
import { chordLabel, type KeyLike } from '../../app/renderer/shortcuts.ts'
import { cleanNoteName, externalChangeAction, gitignoreCovers, gitignoreWithTether, isNotePanelId, newNotePanelId, noteDirOf, noteFileName, noteParams, noteTitle, uniqueFileName, withNote } from '../../app/shared/notes.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-notes-')
after(() => tmp.cleanup())

describe('note pane identity and params', () => {
  test('ids carry the note prefix, sort by time, and never collide with slot ids', () => {
    const a = newNotePanelId(1000, 0.1)
    const b = newNotePanelId(2000, 0.1)
    assert.ok(isNotePanelId(a) && isNotePanelId(b))
    assert.ok(a < b, 'time-ordered')
    assert.notEqual(newNotePanelId(1000, 0.1), newNotePanelId(1000, 0.9), 'the random tail tells two notes of the same millisecond apart')
    assert.ok(!isNotePanelId('slot-1') && !isNotePanelId('3f2a9c') && !isNotePanelId(''))
  })

  test('noteParams reads only a well-formed note; withNote keeps the other params', () => {
    assert.equal(noteParams(undefined), undefined)
    assert.equal(noteParams({ slotId: 'x' }), undefined)
    assert.equal(noteParams({ note: { path: 7 } }), undefined)
    assert.deepEqual(noteParams({ note: { path: 'C:\\n\\a.md', view: 'nope' } }), { path: 'C:\\n\\a.md' })
    assert.deepEqual(noteParams({ note: { path: 'C:\\n\\a.md', view: { cursorState: [] } } }), { path: 'C:\\n\\a.md', view: { cursorState: [] } })
    assert.deepEqual(withNote({ details: true, note: { path: 'old', view: { x: 1 } } }, { path: 'new' }), { details: true, note: { path: 'new' } })
  })

  test('title and folder of a path, both separators', () => {
    assert.equal(noteTitle('C:\\repo\\.tether\\notes\\2026-11-04-1530.md'), '2026-11-04-1530.md')
    assert.equal(noteTitle('/home/u/.tether/notes/a.md'), 'a.md')
    assert.equal(noteDirOf('C:\\repo\\.tether\\notes\\a.md'), 'C:\\repo\\.tether\\notes')
    assert.equal(noteDirOf('a.md'), '')
    assert.equal(paneCwdOfNote('C:\\repo\\.tether\\notes\\a.md'), 'C:\\repo')
    assert.equal(paneCwdOfNote('D:/x/y/.tether/notes/a.md'), 'D:/x/y')
    assert.equal(paneCwdOfNote('C:\\Users\\u\\.tether\\notes\\a.md'), 'C:\\Users\\u', 'the person\'s own folder reads as its parent: a note born there goes to the same place')
    assert.equal(paneCwdOfNote('C:\\docs\\readme.md'), undefined)
  })
})

describe('note file names', () => {
  test('AAAA-MM-DD-HHmm.md in local time, made unique with -2, -3…', () => {
    assert.equal(noteFileName(new Date(2026, 10, 4, 9, 7)), '2026-11-04-0907.md')
    const taken = new Set(['2026-11-04-0907.md', '2026-11-04-0907-2.md'])
    assert.equal(uniqueFileName('2026-11-04-0907.md', n => taken.has(n)), '2026-11-04-0907-3.md')
    assert.equal(uniqueFileName('x.md', () => false), 'x.md')
    assert.equal(uniqueFileName('noext', n => n === 'noext'), 'noext-2')
  })

  test('a typed name becomes a file name: trimmed, separators and illegal characters out, .md when missing', () => {
    assert.equal(cleanNoteName('  ideias  '), 'ideias.md')
    assert.equal(cleanNoteName('plano.md'), 'plano.md')
    assert.equal(cleanNoteName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij.md')
    assert.equal(cleanNoteName('notas.txt'), 'notas.txt')
    assert.equal(cleanNoteName('fim.'), 'fim.md')
    assert.equal(cleanNoteName('   '), undefined)
    assert.equal(cleanNoteName('***'), undefined)
  })
})

describe('where a note goes', () => {
  test('with a pane: <cwd>/.tether/notes; without: ~/.tether/notes, or <TETHER_HOME>/notes when the home is set (tests never touch the real one)', () => {
    assert.equal(notesDirFor('D:\\repo', {}), join('D:\\repo', '.tether', 'notes'))
    assert.equal(userNotesDir({}, 'C:\\Users\\u'), join('C:\\Users\\u', '.tether', 'notes'))
    assert.equal(userNotesDir({ TETHER_HOME: 'C:\\tmp\\home' }, 'C:\\Users\\u'), join('C:\\tmp\\home', 'notes'))
    assert.equal(notesDirFor(undefined, { TETHER_HOME: 'C:\\tmp\\home' }), join('C:\\tmp\\home', 'notes'))
  })

  test('prepareNote creates the folder and an empty, uniquely named file; outside a repository nothing is asked', () => {
    const cwd = tmp.make()
    const now = new Date(2026, 10, 4, 15, 30)
    const a = prepareNote(cwd, { now })
    assert.equal(a.path, join(cwd, '.tether', 'notes', '2026-11-04-1530.md'))
    assert.ok(existsSync(a.path) && readFileSync(a.path, 'utf8') === '')
    assert.equal(a.askGitignore, undefined)
    const b = prepareNote(cwd, { now })
    assert.equal(b.path, join(cwd, '.tether', 'notes', '2026-11-04-1530-2.md'))
    const home = tmp.make()
    const c = prepareNote(undefined, { now, env: { TETHER_HOME: home } })
    assert.equal(c.path, join(home, 'notes', '2026-11-04-1530.md'))
  })

  test('in a repository without .tether/ in .gitignore the repository is named once; declined or covered, nothing is asked', () => {
    const repo = tmp.make()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    assert.equal(findGitRoot(sub), repo)
    assert.equal(findGitRoot(tmp.make()), undefined)
    assert.equal(gitignoreStatus(repo), 'missing', 'no .gitignore at all')
    assert.equal(prepareNote(sub, { now: new Date(2026, 0, 1) }).askGitignore, repo)
    assert.equal(prepareNote(sub, { now: new Date(2026, 0, 1), declined: [repo.toUpperCase()] }).askGitignore, undefined, 'declined (case-insensitively)')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    assert.equal(gitignoreStatus(repo), 'missing')
    addTetherToGitignore(repo)
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n.tether/\n')
    assert.equal(gitignoreStatus(repo), 'covered')
    assert.equal(prepareNote(sub, { now: new Date(2026, 0, 1) }).askGitignore, undefined)
  })

  test('gitignoreCovers accepts the usual spellings and refuses a negation; gitignoreWithTether appends with the file\'s line ending', () => {
    for (const line of ['.tether', '.tether/', '/.tether', '/.tether/', '**/.tether/', '  .tether/  ']) assert.ok(gitignoreCovers(`dist/\n${line}\n`), line)
    assert.ok(!gitignoreCovers('!.tether/\n'))
    assert.ok(!gitignoreCovers('.tether/notes/\n'), 'a deeper rule is not the folder')
    assert.ok(!gitignoreCovers(''))
    assert.equal(gitignoreWithTether(''), '.tether/\n')
    assert.equal(gitignoreWithTether('a\r\nb'), 'a\r\nb\r\n.tether/\r\n')
    assert.equal(gitignoreWithTether('a\n.tether/\n'), 'a\n.tether/\n', 'already there: unchanged')
  })
})

describe('reading, writing, renaming', () => {
  test('writeTextAtomic leaves no temp file behind and replaces the content whole; readNote tells a missing file apart', () => {
    const dir = tmp.make()
    const path = join(dir, 'n.md')
    assert.deepEqual(readNote(path), { ok: false, missing: true, message: readNote(path).ok ? '' : (readNote(path) as { message: string }).message })
    writeTextAtomic(path, 'um')
    writeTextAtomic(path, 'dois três')
    assert.deepEqual(readdirSync(dir), ['n.md'], 'no .tmp left')
    const r = readNote(path)
    assert.ok(r.ok && r.text === 'dois três' && r.mtimeMs > 0)
    const w = writeNote(join(dir, 'sub', 'deep', 'x.md'), 'y')
    assert.ok(w.ok, 'creates the folders')
    assert.ok(!writeNote(join(dir, 'n.md', 'impossible.md'), 'z').ok, 'a file is not a folder: an error, not a throw')
  })

  test('renameNote moves the file and refuses to overwrite', () => {
    const dir = tmp.make()
    writeTextAtomic(join(dir, 'a.md'), 'A')
    writeTextAtomic(join(dir, 'b.md'), 'B')
    assert.deepEqual(renameNote(join(dir, 'a.md'), join(dir, 'b.md')), { ok: false, message: 'Já existe um arquivo com esse nome.' })
    assert.deepEqual(renameNote(join(dir, 'a.md'), join(dir, 'c.md')), { ok: true })
    assert.equal(readFileSync(join(dir, 'c.md'), 'utf8'), 'A')
    assert.ok(!existsSync(join(dir, 'a.md')))
  })
})

describe('an outside change of the file', () => {
  test('same text as the editor: keep (our own save echoed); editor clean: reload; both changed: ask', () => {
    assert.equal(externalChangeAction({ diskText: 'x', editorText: 'x', savedText: 'w' }), 'keep')
    assert.equal(externalChangeAction({ diskText: 'y', editorText: 'x', savedText: 'x' }), 'reload')
    assert.equal(externalChangeAction({ diskText: 'y', editorText: 'x2', savedText: 'x' }), 'ask')
  })

  test('our own save echoed while the person kept typing: never ask (disk = what we wrote, editor ahead of it)', () => {
    assert.equal(externalChangeAction({ diskText: 'abc', editorText: 'abcd', savedText: 'abc' }), 'keep')
  })

  test('an older write of ours read back after a newer one landed: ours, not an outside change', () => {
    assert.equal(externalChangeAction({ diskText: 'ab', editorText: 'abcd', savedText: 'abc', ownTexts: ['a', 'ab', 'abc'] }), 'keep')
  })

  test('a genuine outside change is still caught, with or without pending edits', () => {
    assert.equal(externalChangeAction({ diskText: 'other', editorText: 'abcd', savedText: 'abc', ownTexts: ['ab', 'abc'] }), 'ask')
    assert.equal(externalChangeAction({ diskText: 'other', editorText: 'abc', savedText: 'abc', ownTexts: ['ab', 'abc'] }), 'reload')
  })
})

describe('the editor\'s actions as commands', () => {
  test('ids are the registry\'s shape: lowercase dotted kebab under editor.', () => {
    assert.equal(editorCommandId('editor.action.insertCursorBelow'), 'editor.action.insert-cursor-below')
    assert.equal(editorCommandId('editor.action.addSelectionToNextFindMatch'), 'editor.action.add-selection-to-next-find-match')
    assert.equal(editorCommandId('actions.find'), 'editor.actions.find')
    assert.equal(editorCommandId('cursorUndo'), 'editor.cursor-undo')
    assert.equal(editorCommandId('editor.action.toggleTabFocusMode'), 'editor.action.toggle-tab-focus-mode')
    assert.equal(editorCommandId('editor.action.selectToBracket'), 'editor.action.select-to-bracket')
    assert.equal(editorCommandId('vs.editor.ICodeEditor:3:tether.toggleWordWrap'), 'editor.tether.toggle-word-wrap', 'an action added to one editor instance keeps a stable id')
    assert.match(editorCommandId('editor.unfold-All_x'), /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/)
  })

  test('Monaco\'s keybinding labels become chords the hints print; two-step chords and unknown keys give none', () => {
    const win = (label: string): string | undefined => { const c = chordFromLabel(label); return c ? chordLabel(c, false) : undefined }
    assert.equal(win('Ctrl+Shift+L'), 'Ctrl+Shift+L')
    assert.equal(win('Ctrl+Alt+DownArrow'), 'Ctrl+Alt+↓')
    assert.equal(win('Shift+Alt+UpArrow'), 'Alt+Shift+↑')
    assert.equal(win('Alt+Z'), 'Alt+Z')
    assert.equal(win('Ctrl+D'), 'Ctrl+D')
    assert.equal(win('F3'), 'F3')
    assert.equal(win('Ctrl+Shift+K'), 'Ctrl+Shift+K')
    assert.equal(win('Ctrl+K Ctrl+C'), undefined)
    assert.equal(win('Ctrl+/'), undefined)
    assert.equal(win(''), undefined)
    const mac = chordFromLabel('⇧⌘L')
    assert.deepEqual(mac, { code: 'KeyL', shift: true, meta: true })
    assert.equal(chordLabel(mac!, true), '⇧⌘L')
    assert.deepEqual(chordFromLabel('⌥↓'), { code: 'ArrowDown', alt: true })
  })
})

describe('the layout keeps notes', () => {
  function layoutWith(ids: string[]): Layout {
    const l = emptyLayout()
    const frame = l.desks[0]!.frames
    frame.views['frame-1'] = {
      grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ids, activeView: ids[0]!, id: 'g1' }, size: 100 }], size: 100 }, width: 1000, height: 800, orientation: 'HORIZONTAL' as never },
      panels: Object.fromEntries(ids.map(id => [id, isNotePanelId(id)
        ? { id, contentComponent: 'note', tabComponent: 'note-tab', title: 'a.md', params: { note: { path: 'C:\\a.md' } } }
        : { id, contentComponent: 'terminal', tabComponent: 'slot-tab', title: id, params: { slotId: id } }])),
    }
    return l
  }

  test('a note pane is never an orphan, and pruning the slots the daemon lost keeps it', () => {
    assert.deepEqual(orphanedPanels(['slot-a', 'note:1', 'slot-b'], new Set(['slot-a'])), ['slot-b'])
    const saved = layoutWith(['slot-a', 'note:1', 'slot-b'])
    const plan = planRestore(saved, new Set(['slot-a']))
    assert.deepEqual(plan.orphaned, ['slot-b'])
    const views = plan.layout!.desks[0]!.frames.views['frame-1']!
    assert.deepEqual(Object.keys(views.panels).sort(), ['note:1', 'slot-a'])
    const only = planRestore(layoutWith(['note:1']), new Set(['slot-z']))
    assert.deepEqual(only.orphaned, [])
    assert.ok(only.layout, 'a layout of notes alone is shown as read')
    assert.deepEqual(Object.keys(only.layout!.desks[0]!.frames.views['frame-1']!.panels), ['note:1'])
  })
})

describe('chords inside the editor', () => {
  const key = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyLike =>
    ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })

  test('every Alt+arrow chord is the editor\'s (cursors, column selection, copy and move line, smart select)', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      assert.deepEqual(editorKeyOwner(key(code, { ctrl: true, alt: true }), false), { owner: 'editor' }, `Ctrl+Alt+${code}`)
      assert.deepEqual(editorKeyOwner(key(code, { ctrl: true, alt: true, shift: true }), false), { owner: 'editor' }, `Ctrl+Shift+Alt+${code}`)
      assert.deepEqual(editorKeyOwner(key(code, { alt: true, shift: true }), false), { owner: 'editor' }, `Shift+Alt+${code}`)
      assert.deepEqual(editorKeyOwner(key(code, { alt: true }), false), { owner: 'editor' }, `Alt+${code}`)
    }
  })

  test('the workbench chords stay the app\'s: palette, quick open, chooser, desks, drawer, font size, status bar', () => {
    assert.deepEqual(editorKeyOwner(key('KeyP', { ctrl: true, shift: true }), false), { owner: 'app', command: 'palette.show' })
    withQuickOpenKeybindings() // Ctrl+P comes from the quick-open extension
    assert.deepEqual(editorKeyOwner(key('KeyP', { ctrl: true }), false), { owner: 'app', command: 'palette.quick-open' })
    assert.equal(editorKeyOwner(key('KeyT', { ctrl: true, shift: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('Tab', { ctrl: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('Digit2', { ctrl: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('Backquote', { ctrl: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('Equal', { ctrl: true, shift: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('KeyH', { ctrl: true, shift: true }), false).owner, 'app')
    assert.equal(editorKeyOwner(key('Backslash', { ctrl: true }), false).owner, 'app', 'Ctrl+\ duplicates (VS Code: split editor, a workbench chord)')
    assert.deepEqual(editorKeyOwner(key('KeyD', { ctrl: true }), false), { owner: 'editor' }, 'Ctrl+D is not an app chord: the editor adds the next match')
    assert.deepEqual(editorKeyOwner(key('KeyL', { ctrl: true, shift: true }), false), { owner: 'editor' }, 'Ctrl+Shift+L is not an app chord: select all occurrences')
  })
})

test('note params: the per-editor minimap choice is read, kept by withNote, set and cleared', () => {
  assert.equal(noteParams({ note: { path: 'a.md' } })?.minimap, undefined)
  assert.equal(noteParams({ note: { path: 'a.md', minimap: 'off' } })?.minimap, undefined, 'malformed reads as no choice')
  assert.equal(noteParams({ note: { path: 'a.md', minimap: false } })?.minimap, false)
  const own = withNote(undefined, { path: 'a.md', minimap: false })
  assert.equal(noteParams(own)?.minimap, false)
  assert.equal(noteParams(withNote(own, { path: 'a.md', view: { x: 1 } }))?.minimap, false, 'absent keeps the choice')
  assert.equal(noteParams(withNote(own, { path: 'a.md', minimap: true }))?.minimap, true)
  assert.equal(noteParams(withNote(own, { path: 'a.md', minimap: null }))?.minimap, undefined, 'null clears it')
})

test('note params: the per-editor line-numbers choice is read, kept by withNote, set and cleared', () => {
  assert.equal(noteParams({ note: { path: 'a.md' } })?.lineNumbers, undefined)
  assert.equal(noteParams({ note: { path: 'a.md', lineNumbers: 'off' } })?.lineNumbers, undefined, 'malformed reads as no choice')
  const own = withNote(undefined, { path: 'a.md', lineNumbers: false, minimap: true })
  assert.equal(noteParams(own)?.lineNumbers, false)
  assert.equal(noteParams(withNote(own, { path: 'a.md', view: { x: 1 } }))?.lineNumbers, false, 'absent keeps the choice')
  assert.equal(noteParams(withNote(own, { path: 'a.md', minimap: null }))?.lineNumbers, false, 'clearing the minimap keeps line numbers')
  assert.equal(noteParams(withNote(own, { path: 'a.md', lineNumbers: null }))?.lineNumbers, undefined, 'null clears it')
  assert.equal(noteParams(withNote(own, { path: 'a.md', lineNumbers: null }))?.minimap, true)
})
