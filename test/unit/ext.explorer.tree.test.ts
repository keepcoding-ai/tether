// The explorer tree's pure rules and the main side's path guard (F8 slice 1b): the sort (folders first, natural order), VS Code's
// default excludes (node_modules stays), paths, the expanded state's tolerant read, the keyboard rules, and the refusal of any
// folder outside the project roots (a `..` path, a sibling folder, a link that leads out).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { guardPath, readDirectory } from '../../extensions/explorer/main.ts'
import {
  compareFileNamesDefault, flatten, isExcluded, isInsideAny, isTypeAheadKey, joinPath, listing, navigate, pageTarget, parentPath, typeAheadMatch, readState, revealChain, samePath, sortEntries, type Entry, type NavRow,
} from '../../extensions/explorer/tree-rules.ts'

const atriumTmp = resolve(import.meta.dirname, '..', '..', '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const e = (name: string, kind: Entry['kind'] = 'file'): Entry => ({ name, kind })

describe('explorer sorting and excludes', () => {
  test('folders first, then natural order ignoring case', () => {
    const out = sortEntries([e('b.txt'), e('file10'), e('file2'), e('Zeta', 'dir'), e('alpha', 'dir'), e('A.md')])
    assert.deepEqual(out.map(x => x.name), ['alpha', 'Zeta', 'A.md', 'b.txt', 'file2', 'file10'])
  })

  test('mixed order does not group folders', () => {
    assert.deepEqual(sortEntries([e('b', 'dir'), e('a'), e('c', 'dir')], 'mixed').map(x => x.name), ['a', 'b', 'c'])
  })

  test('names the numeric collator calls equal go shorter first', () => {
    assert.ok(compareFileNamesDefault('foo1', 'foo01') < 0)
    assert.equal(compareFileNamesDefault('a', 'a'), 0)
  })

  test('the default files.exclude of VS Code hides version control and OS litter, but node_modules shows', () => {
    for (const n of ['.git', '.svn', '.hg', '.jj', 'CVS', '.DS_Store', 'Thumbs.db']) assert.equal(isExcluded(n), true, n)
    for (const n of ['node_modules', '.github', '.gitignore', 'src', '.env']) assert.equal(isExcluded(n), false, n)
    assert.deepEqual(listing([e('.git', 'dir'), e('node_modules', 'dir'), e('src', 'dir'), e('Thumbs.db'), e('a.ts')]).map(x => x.name), ['node_modules', 'src', 'a.ts'])
  })
})

describe('explorer paths and state', () => {
  test('join and parent keep the path style', () => {
    assert.equal(joinPath('C:\\proj', 'src'), 'C:\\proj\\src')
    assert.equal(joinPath('C:\\', 'src'), 'C:\\src')
    assert.equal(joinPath('/home/a', 'src'), '/home/a/src')
    assert.equal(parentPath('C:\\proj\\src'), 'C:\\proj')
    assert.equal(parentPath('C:\\proj'), 'C:\\')
    assert.equal(parentPath('/home/a/b.txt'), '/home/a')
  })

  test('the expanded state reads tolerantly and drops what is not a list of strings', () => {
    assert.deepEqual(readState(undefined), { v: 1, expanded: {} })
    assert.deepEqual(readState('x'), { v: 1, expanded: {} })
    assert.deepEqual(readState({ expanded: { 'C:\\a': ['C:\\a', 'C:\\a\\s', 3, 'C:\\a'], bad: 'x' } }), { v: 1, expanded: { 'C:\\a': ['C:\\a', 'C:\\a\\s'] } })
  })

  test('flatten draws only the expanded folders, depth first', () => {
    const tree: Record<string, Entry[]> = { '/r': [e('s', 'dir'), e('t', 'dir'), e('f.md')], '/r/s': [e('x.ts')], '/r/t': [e('y.ts')] }
    const rows = flatten({ path: '/r', name: 'r' }, new Set(['/r', '/r/s']), d => tree[d])
    assert.deepEqual(rows.map(r => `${r.level}:${r.name}`), ['1:r', '2:s', '3:x.ts', '2:t', '2:f.md'])
    assert.deepEqual(flatten({ path: '/r', name: 'r' }, new Set(), d => tree[d]).map(r => r.name), ['r'])
  })
})

describe('explorer keyboard rules', () => {
  // r (expanded) > [s (expanded) > [x], t (collapsed), f]
  const rows: NavRow[] = [
    { level: 1, dir: true, expanded: true }, { level: 2, dir: true, expanded: true }, { level: 3, dir: false, expanded: false },
    { level: 2, dir: true, expanded: false }, { level: 2, dir: false, expanded: false },
  ]
  test('up, down, home and end move and stop at the edges', () => {
    assert.deepEqual(navigate(rows, 1, 'ArrowDown'), { type: 'focus', index: 2 })
    assert.deepEqual(navigate(rows, 0, 'ArrowUp'), { type: 'none' })
    assert.deepEqual(navigate(rows, 4, 'ArrowDown'), { type: 'none' })
    assert.deepEqual(navigate(rows, 3, 'Home'), { type: 'focus', index: 0 })
    assert.deepEqual(navigate(rows, 0, 'End'), { type: 'focus', index: 4 })
  })
  test('right expands a collapsed folder or goes to its first child; left collapses or goes to the parent', () => {
    assert.deepEqual(navigate(rows, 3, 'ArrowRight'), { type: 'expand' })
    assert.deepEqual(navigate(rows, 1, 'ArrowRight'), { type: 'focus', index: 2 })
    assert.deepEqual(navigate(rows, 4, 'ArrowRight'), { type: 'none' })
    assert.deepEqual(navigate(rows, 1, 'ArrowLeft'), { type: 'collapse' })
    assert.deepEqual(navigate(rows, 2, 'ArrowLeft'), { type: 'focus', index: 1 })
    assert.deepEqual(navigate(rows, 3, 'ArrowLeft'), { type: 'focus', index: 0 })
    assert.deepEqual(navigate(rows, 0, 'ArrowLeft'), { type: 'collapse' })
  })
  test('enter opens a file and toggles a folder', () => {
    assert.deepEqual(navigate(rows, 4, 'Enter'), { type: 'open' })
    assert.deepEqual(navigate(rows, 3, 'Enter'), { type: 'toggle' })
    assert.deepEqual(navigate(rows, 3, 'x'), { type: 'none' })
  })
})

describe('explorer main side: only inside the project roots', () => {
  test('the lexical check refuses outside, sibling-prefix and dot-dot paths', () => {
    const roots = ['C:\\proj\\alpha']
    assert.equal(isInsideAny(roots, 'C:\\proj\\alpha', true), true)
    assert.equal(isInsideAny(roots, 'c:\\PROJ\\alpha\\src\\deep', true), true)
    assert.equal(isInsideAny(roots, 'C:\\proj\\alpha2', true), false)
    assert.equal(isInsideAny(roots, 'C:\\proj', true), false)
    assert.equal(isInsideAny(roots, 'C:\\proj\\alpha\\..\\beta', true), false)
    assert.equal(isInsideAny(roots, 'C:\\Windows', true), false)
    assert.equal(isInsideAny([], 'C:\\proj\\alpha', true), false, 'no roots announced, nothing is readable')
    assert.equal(isInsideAny(['/home/a'], '/home/A/x', false), false, 'case matters off Windows')
  })

  test('the guard refuses non-strings, other folders and a link that leads out of the project', async () => {
    const roots = ['/work/alpha']
    const identity = async (p: string): Promise<string> => p
    assert.equal(await guardPath(roots, '/work/alpha/src', identity, false), '/work/alpha/src')
    assert.equal(await guardPath(roots, 42, identity, false), undefined)
    assert.equal(await guardPath(roots, '', identity, false), undefined)
    assert.equal(await guardPath(roots, '/work/beta', identity, false), undefined)
    assert.equal(await guardPath(roots, '/work/alpha/../beta', identity, false), undefined)
    // /work/alpha/link is a link to /etc: its real path is outside the root
    const real = async (p: string): Promise<string> => (p.startsWith('/work/alpha/link') ? p.replace('/work/alpha/link', '/etc') : p)
    assert.equal(await guardPath(roots, '/work/alpha/link', real, false), undefined)
    assert.equal(await guardPath(roots, '/work/alpha/link/ssh', real, false), undefined)
    // a folder that does not exist is passed on so the read answers "not found"
    const gone = async (): Promise<string> => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
    assert.equal(await guardPath(roots, '/work/alpha/old', gone, false), '/work/alpha/old')
  })

  test('readDirectory lists one folder: excludes dropped, folders first, node_modules kept; errors are said', async () => {
    const dir = mkdtempSync(join(tmpBase, 'tether-explorer-unit-'))
    try {
      mkdirSync(join(dir, '.git')); mkdirSync(join(dir, 'node_modules')); mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'b.md'), ''); writeFileSync(join(dir, 'a.md'), ''); writeFileSync(join(dir, 'Thumbs.db'), '')
      const ok = await readDirectory(dir)
      assert.ok(ok.ok)
      assert.deepEqual(ok.entries.map(x => `${x.kind}:${x.name}`), ['dir:node_modules', 'dir:src', 'file:a.md', 'file:b.md'])
      const missing = await readDirectory(join(dir, 'nope'))
      assert.deepEqual(missing, { ok: false, missing: true, message: 'Pasta não encontrada.' })
      const file = await readDirectory(join(dir, 'a.md'))
      assert.equal(file.ok, false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('explorer reveal', () => {
  test('revealChain: the root, then each folder down to the file parent', () => {
    assert.deepEqual(revealChain('C:\\p\\a', 'C:\\p\\a\\sub\\deep\\x.md', true), ['C:\\p\\a', 'C:\\p\\a\\sub', 'C:\\p\\a\\sub\\deep'])
    assert.deepEqual(revealChain('C:\\p\\a', 'C:\\p\\a\\top.md', true), ['C:\\p\\a'])
    assert.deepEqual(revealChain('/p/a', '/p/a/sub/x.md', false), ['/p/a', '/p/a/sub'])
  })
  test('revealChain: nothing for a file outside the root, the root itself, or a sibling with the same prefix', () => {
    assert.deepEqual(revealChain('C:\\p\\a', 'C:\\p\\b\\x.md', true), [])
    assert.deepEqual(revealChain('C:\\p\\a', 'C:\\p\\a', true), [])
    assert.deepEqual(revealChain('C:\\p\\a', 'C:\\p\\ab\\x.md', true), [])
  })
  test('revealChain keeps the file spelling; case only matters where the system cares', () => {
    assert.deepEqual(revealChain('C:\\P\\A', 'c:\\p\\a\\Sub\\x.md', true), ['C:\\P\\A', 'C:\\P\\A\\Sub'])
    assert.deepEqual(revealChain('/p/A', '/p/a/x.md', false), [])
    assert.equal(samePath('C:\\p\\a\\', 'c:/P/A', true), true)
    assert.equal(samePath('/p/a', '/p/A', false), false)
  })
})

describe('explorer type to navigate and paging', () => {
  const names = ['src', 'docs', 'Apple.md', 'a.md', 'b.md', 'alpha.md']
  test('a prefix jumps to the next match, case-insensitive, wrapping', () => {
    assert.equal(typeAheadMatch(names, 0, 'd'), 1)
    assert.equal(typeAheadMatch(names, 1, 'do'), 1, 'a longer prefix stays on a row that still matches')
    assert.equal(typeAheadMatch(names, 4, 'a'), 5, 'a single letter starts after the current row')
    assert.equal(typeAheadMatch(names, 5, 'a'), 2, 'and wraps around')
    assert.equal(typeAheadMatch(names, 0, 'al'), 5)
    assert.equal(typeAheadMatch(names, 0, 'zz'), -1)
    assert.equal(typeAheadMatch(names, 0, ''), -1)
    assert.equal(typeAheadMatch([], 0, 'a'), -1)
  })
  test('a repeated letter cycles through the names that start with it', () => {
    assert.equal(typeAheadMatch(names, 2, 'aa'), 3)
    assert.equal(typeAheadMatch(names, 3, 'aaa'), 5)
  })
  test('which keys feed the prefix', () => {
    assert.equal(isTypeAheadKey('a', ''), true)
    assert.equal(isTypeAheadKey(' ', ''), false, 'space alone toggles')
    assert.equal(isTypeAheadKey(' ', 'my'), true)
    assert.equal(isTypeAheadKey('ArrowDown', ''), false)
  })
  test('page keys go to the edge of the view first, then a page further, clamped', () => {
    assert.equal(pageTarget(2, 100, 2, 11, 10, true), 11)
    assert.equal(pageTarget(11, 100, 2, 11, 10, true), 20)
    assert.equal(pageTarget(95, 100, 90, 99, 10, true), 99)
    assert.equal(pageTarget(20, 100, 20, 29, 10, false), 11)
    assert.equal(pageTarget(25, 100, 20, 29, 10, false), 20)
    assert.equal(pageTarget(3, 100, 0, 9, 10, false), 0)
    assert.equal(pageTarget(0, 0, 0, 0, 10, true), -1)
  })
})
