// "Nova nota" destination (Guga, 09/11): the general rule that cuts a suggested folder at `.tether`
// (app/shared/tether-folder.ts, applied by the chooser's effectiveFolder), the grey suffix after the typed folder,
// "Minhas notas" from its setting, and a note written exactly in a chosen folder (app/main/note-files.ts).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { folderSuffix, stripTether } from '../../app/shared/tether-folder.ts'
import { effectiveFolder, type ChooserItem } from '../../app/renderer/chooser-rules.ts'
import { personalNotesDir, prepareNote, PERSONAL_FOLDER_DEFAULT, userNotesDir } from '../../app/main/note-files.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-note-dest-')
after(() => tmp.cleanup())

describe('a suggested folder is cut at .tether', () => {
  test('the part from .tether on goes away', () => {
    assert.equal(stripTether('d:\\minha\\pasta\\.tether\\alguma\\pasta'), 'd:\\minha\\pasta')
    assert.equal(stripTether('D:\\x\\.tether\\notes'), 'D:\\x')
    assert.equal(stripTether('D:\\x\\.TETHER'), 'D:\\x')
    assert.equal(stripTether('/home/a/.tether/notes'), '/home/a')
  })
  test('a drive or the root keeps its separator', () => {
    assert.equal(stripTether('D:\\.tether\\notes'), 'D:\\')
    assert.equal(stripTether('D:/.tether/notes'), 'D:/')
    assert.equal(stripTether('/.tether/notes'), '/')
  })
  test('a folder without a .tether part is kept, and a name that only contains it too', () => {
    assert.equal(stripTether('D:\\atrium\\workspace\\tether'), 'D:\\atrium\\workspace\\tether')
    assert.equal(stripTether('D:\\x\\.tether-old\\a'), 'D:\\x\\.tether-old\\a')
    assert.equal(stripTether(''), '')
  })
  test('the chooser cuts what it suggests, never what the person chose', () => {
    const profile = { cwd: 'D:\\p\\.tether\\notes' } as ChooserItem
    assert.deepEqual(effectiveFolder(profile, '', false), { folder: 'D:\\p', fromProfile: true })
    assert.deepEqual(effectiveFolder(undefined, 'D:\\r\\.tether\\notes', false), { folder: 'D:\\r', fromProfile: false })
    assert.deepEqual(effectiveFolder(undefined, 'D:\\r\\.tether\\notes', true), { folder: 'D:\\r\\.tether\\notes', fromProfile: false })
  })
})

describe('the grey suffix after the typed folder', () => {
  const seg = ['.tether', 'notes']
  test('a separator is added only when the text does not end in one', () => {
    assert.equal(folderSuffix('d:\\my\\folder', seg), '\\.tether\\notes')
    assert.equal(folderSuffix('d:\\my\\folder\\', seg), '.tether\\notes')
  })
  test('in the separator the person types', () => {
    assert.equal(folderSuffix('d:/my/folder', seg), '/.tether/notes')
    assert.equal(folderSuffix('d:/my/folder/', seg), '.tether/notes')
  })
  test('nothing for an empty field', () => {
    assert.equal(folderSuffix('', seg), '')
    assert.equal(folderSuffix('   ', seg), '')
  })
})

describe('"Minhas notas" and a chosen folder', () => {
  test('the default (or empty) setting is the person\'s own folder, the test home included', () => {
    const env = { TETHER_HOME: 'C:\\th' }
    assert.equal(personalNotesDir(PERSONAL_FOLDER_DEFAULT, env, 'C:\\Users\\a'), userNotesDir(env, 'C:\\Users\\a'))
    assert.equal(personalNotesDir('', {}, 'C:\\Users\\a'), join('C:\\Users\\a', '.tether', 'notes'))
    assert.equal(personalNotesDir(undefined, {}, 'C:\\Users\\a'), join('C:\\Users\\a', '.tether', 'notes'))
  })
  test('another folder, with ~ as the home', () => {
    assert.equal(personalNotesDir('~/notas', {}, 'C:\\Users\\a'), join('C:\\Users\\a', 'notas'))
    assert.equal(personalNotesDir('D:\\notas', {}, 'C:\\Users\\a'), 'D:\\notas')
  })
  test('a note in a chosen folder lands right there, without .tether/notes nor the .gitignore question', () => {
    const dir = join(tmp.make(), 'escolhida')
    const p = prepareNote(dir, { dir })
    assert.equal(dirname(p.path), dir)
    assert.ok(existsSync(p.path))
    assert.equal(p.askGitignore, undefined)
  })
})
