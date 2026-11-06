// The explorer's file operations (F8 slice 5): VS Code's name validation (port of fileActions.ts validateFileName and
// extpath.ts isValidBasename), the rename selection, the menus by kind, the relative path, the delete dialog, the write
// guard (source and destination inside the roots, never a root, no link out) and create/rename on a real temp folder.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isValidBasename, renameSelection, validateFileName, wellFormedFileName } from '../../extensions/explorer/file-names.ts'
import { createEntry, guardWrite, renameEntry } from '../../extensions/explorer/main.ts'
import { deleteSituation, itemMenu, relativePath, trashFailedSituation } from '../../extensions/explorer/renderer/rules.ts'
import { manifest } from '../../extensions/explorer/manifest.ts'
import { rebasePath } from '../../app/shared/notes.ts'

const atriumTmp = resolve(import.meta.dirname, '..', '..', '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const win = { siblings: ['src', 'README.md', 'a.txt'], isWindows: true }

describe('explorer name validation (VS Code validateFileName)', () => {
  test('empty, blank and leading slash are errors', () => {
    for (const n of ['', '   ', '\t']) assert.equal(validateFileName(n, win)?.severity, 'error', JSON.stringify(n))
    assert.match(validateFileName('/x', win)!.message, /barra/)
    assert.match(validateFileName('\\x', win)!.message, /barra/)
  })

  test('an existing name is refused, ignoring case on Windows', () => {
    assert.match(validateFileName('README.md', win)!.message, /Já existe/)
    assert.match(validateFileName('readme.MD', win)!.message, /Já existe/)
    assert.equal(validateFileName('readme.MD', { ...win, isWindows: false }), null)
  })

  test('renaming: the same name and a change of case only are fine; slashes are not', () => {
    assert.equal(validateFileName('a.txt', { ...win, current: 'a.txt' }), null)
    assert.equal(validateFileName('A.txt', { ...win, current: 'a.txt' }), null)
    assert.match(validateFileName('README.md', { ...win, current: 'a.txt' })!.message, /Já existe/)
    assert.match(validateFileName('x/y.txt', { ...win, current: 'a.txt' })!.message, /sem barras/)
  })

  test('Windows: invalid characters, reserved names, trailing dot or space', () => {
    for (const n of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'CON', 'con.txt', 'PRN', 'aux', 'NUL.md', 'COM1', 'lpt9.log', 'clock$', 'name.', 'name ', '.', '..', 'x'.repeat(256)]) {
      assert.equal(validateFileName(n, win)?.severity, 'error', n)
    }
    assert.equal(validateFileName('console.txt', win), null, 'only the reserved names themselves')
  })

  test('Unix: only the slash is invalid; a trailing dot is fine', () => {
    const unix = { siblings: [], isWindows: false }
    assert.equal(validateFileName('a:b', unix), null)
    assert.equal(validateFileName('CON', unix), null)
    assert.equal(validateFileName('name.', unix), null)
  })

  test('leading whitespace: a warning on Unix, an error on Windows (isValidBasename trims)', () => {
    assert.equal(validateFileName(' x.md', { siblings: [], isWindows: false })?.severity, 'warning')
    assert.equal(validateFileName(' x.md', win)?.severity, 'error')
  })

  test('a nested name creates folders on the way; each part is validated', () => {
    assert.equal(validateFileName('docs/new.md', win), null)
    assert.equal(validateFileName('src/new.md', win), null, 'an existing first folder is where it goes')
    assert.equal(validateFileName('docs/CON', win)?.severity, 'error')
  })

  test('well formed: tabs trimmed, trailing slashes dropped', () => {
    assert.equal(wellFormedFileName('\tdocs/\\'), 'docs')
    assert.equal(validateFileName('newdir/', win), null)
  })

  test('isValidBasename', () => {
    assert.equal(isValidBasename('ok.txt', true), true)
    assert.equal(isValidBasename('a/b', false), false)
    assert.equal(isValidBasename(undefined, true), false)
  })
})

describe('explorer rename selection', () => {
  test('a file selects its name without the extension; a folder or a dotfile selects all', () => {
    assert.deepEqual(renameSelection('notes.md', false), { start: 0, end: 5 })
    assert.deepEqual(renameSelection('archive.tar.gz', false), { start: 0, end: 11 })
    assert.deepEqual(renameSelection('.env', false), { start: 0, end: 4 })
    assert.deepEqual(renameSelection('my.folder', true), { start: 0, end: 9 })
  })
})

describe('explorer item menus and paths', () => {
  const actions = (m: ReturnType<typeof itemMenu>): string[] => m.map(i => (i === 'sep' ? '-' : i.action))
  test('a file opens; a folder creates; both rename, trash, copy and reveal', () => {
    assert.deepEqual(actions(itemMenu('file')), ['open', 'open-side', '-', 'rename', 'delete', '-', 'copy-path', 'copy-relative-path', '-', 'reveal'])
    assert.deepEqual(actions(itemMenu('dir')), ['new-file', 'new-folder', 'new-pane', '-', 'rename', 'delete', '-', 'copy-path', 'copy-relative-path', '-', 'reveal'])
    const del = itemMenu('file').find(i => i !== 'sep' && i.action === 'delete')
    assert.equal((del as { danger?: boolean }).danger, true)
  })

  test('relative path keeps the separators; the root is "."', () => {
    assert.equal(relativePath('C:\\p\\alpha', 'C:\\p\\alpha\\src\\a.ts'), 'src\\a.ts')
    assert.equal(relativePath('C:\\p\\alpha\\', 'C:\\p\\alpha\\a.ts'), 'a.ts')
    assert.equal(relativePath('/w/a', '/w/a/x/y'), 'x/y')
    assert.equal(relativePath('/w/a', '/w/a'), '.')
  })

  test('the delete dialog: warn, a red trash card, cancel, "não perguntar de novo"; the failure deletes nothing', () => {
    const d = deleteSituation('a.md', 'C:\\p\\a.md', false)
    assert.equal(d.situation, 'explorer.delete')
    assert.deepEqual(d.choices.map(c => [c.id, c.tone]), [['keep', 'safe'], ['trash', 'destructive']])
    assert.equal(d.defaultChoice, 'keep', 'Enter keeps')
    assert.equal(d.escChoice, 'keep')
    assert.equal(d.remember?.choice, 'trash')
    assert.match(deleteSituation('src', 'C:\\p\\src', true).message!, /tudo o que ela contém/)
    assert.match(trashFailedSituation('a.md', 'x').choices[0]!.consequence, /Nada foi apagado/)
  })

  test('manifest: confirmDelete on by default and the commands of the operations', () => {
    assert.equal(manifest.contributes?.settings?.confirmDelete?.default, true)
    const ids = manifest.contributes?.commands?.map(c => c.command) ?? []
    for (const id of ['explorer.new-file', 'explorer.new-folder', 'explorer.rename', 'explorer.delete', 'explorer.copy-path', 'explorer.copy-relative-path', 'explorer.new-pane']) assert.ok(ids.includes(id), id)
  })

  test('rebasePath: the file itself, a file under a renamed folder, and an unrelated one', () => {
    assert.equal(rebasePath('C:\\p\\a.md', 'C:\\p\\a.md', 'C:\\p\\b.md'), 'C:\\p\\b.md')
    assert.equal(rebasePath('C:\\p\\Docs\\x.md', 'c:\\p\\docs', 'C:\\p\\notes'), 'C:\\p\\notes\\x.md')
    assert.equal(rebasePath('C:\\p\\docs2\\x.md', 'C:\\p\\docs', 'C:\\p\\notes'), undefined)
  })
})

describe('explorer write guard', () => {
  const roots = ['/work/alpha']
  const identity = async (p: string): Promise<string> => p
  const exists = (set: string[]) => async (p: string): Promise<boolean> => set.includes(p.replace(/\\/g, '/'))

  test('a source must exist inside a root and never be the root', async () => {
    const present = exists(['/work/alpha', '/work/alpha/a.md'])
    assert.equal(await guardWrite(roots, '/work/alpha/a.md', true, identity, false, present), '/work/alpha/a.md')
    assert.equal(await guardWrite(roots, '/work/alpha', true, identity, false, present), undefined, 'the root itself')
    assert.equal(await guardWrite(roots, '/work/alpha/gone.md', true, identity, false, present), undefined, 'missing')
    assert.equal(await guardWrite(roots, '/work/beta/a.md', true, identity, false, present), undefined, 'outside')
    assert.equal(await guardWrite(roots, '/work/alpha/../beta/a.md', true, identity, false, present), undefined, 'dot-dot')
    assert.equal(await guardWrite(roots, 7, true, identity, false, present), undefined)
  })

  test('a source behind a link that leads out is refused', async () => {
    const real = async (p: string): Promise<string> => (p.startsWith('/work/alpha/link') ? p.replace('/work/alpha/link', '/etc') : p)
    const present = exists(['/work/alpha', '/work/alpha/link', '/work/alpha/link/passwd'])
    assert.equal(await guardWrite(roots, '/work/alpha/link/passwd', true, real, false, present), undefined)
    assert.equal(await guardWrite(roots, '/work/alpha/link', true, real, false, present), undefined)
  })

  test('a destination: its nearest existing folder must really be inside', async () => {
    const real = async (p: string): Promise<string> => (p.startsWith('/work/alpha/link') ? p.replace('/work/alpha/link', '/etc') : p)
    const present = exists(['/work/alpha', '/work/alpha/src', '/work/alpha/link'])
    assert.equal(await guardWrite(roots, '/work/alpha/src/new.md', false, real, false, present), '/work/alpha/src/new.md')
    assert.equal(await guardWrite(roots, '/work/alpha/new/deep/x.md', false, real, false, present), '/work/alpha/new/deep/x.md', 'folders on the way are made')
    assert.equal(await guardWrite(roots, '/work/alpha/link/x.md', false, real, false, present), undefined, 'through a link out')
    assert.equal(await guardWrite(roots, '/work/other/x.md', false, real, false, present), undefined)
  })

  test('create and rename on disk: never over an existing entry, never out of the roots', async () => {
    const dir = mkdtempSync(join(tmpBase, 'tether-explorer-ops-'))
    const outside = mkdtempSync(join(tmpBase, 'tether-explorer-out-'))
    try {
      const r = [dir]
      assert.deepEqual(await createEntry(r, join(dir, 'a.md'), 'file'), { ok: true })
      assert.deepEqual(await createEntry(r, join(dir, 'sub', 'deep'), 'dir'), { ok: true })
      assert.equal((await createEntry(r, join(dir, 'a.md'), 'file')).ok, false, 'no overwrite')
      assert.equal((await createEntry(r, join(dir, 'CON'), 'file')).ok, false, 'reserved name')
      assert.equal((await createEntry(r, join(outside, 'x.md'), 'file')).ok, false, 'outside the roots')
      assert.equal((await createEntry(r, dir, 'dir')).ok, false, 'the root')
      writeFileSync(join(dir, 'b.md'), 'b')
      assert.equal((await renameEntry(r, join(dir, 'a.md'), join(dir, 'b.md'))).ok, false, 'no rename over an existing file')
      assert.equal((await renameEntry(r, join(dir, 'a.md'), join(dir, 'sub', 'a.md'))).ok, false, 'rename does not move')
      assert.equal((await renameEntry(r, join(dir, 'a.md'), join(outside, 'a.md'))).ok, false, 'nor out of the roots')
      assert.equal((await renameEntry(r, dir, join(tmpBase, 'renamed'))).ok, false, 'a root is never renamed')
      assert.deepEqual(await renameEntry(r, join(dir, 'a.md'), join(dir, 'c.md')), { ok: true })
      if (process.platform === 'win32') assert.deepEqual(await renameEntry(r, join(dir, 'c.md'), join(dir, 'C.md')), { ok: true }, 'a change of case only')
      assert.deepEqual(readdirSync(dir).sort(), (process.platform === 'win32' ? ['C.md', 'b.md', 'sub'] : ['b.md', 'c.md', 'sub']).sort())
      assert.deepEqual(readdirSync(outside), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
