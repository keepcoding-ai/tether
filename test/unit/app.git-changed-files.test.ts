import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitChangedFiles, parsePorcelainZ } from '../../app/main/git-changed-files.ts'

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
}

function write(root: string, rel: string, text = 'x\n'): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

test('parsePorcelainZ: statuses, renames keep the new path, deletions dropped', () => {
  const out = [' M a.txt', 'A  b.txt', '?? dir/c.txt', 'R  new.txt', 'old.txt', ' D gone.txt', 'D  gone2.txt', 'C  copy.txt', 'src.txt', ''].join('\0')
  assert.deepEqual(parsePorcelainZ(out), ['a.txt', 'b.txt', 'dir/c.txt', 'new.txt', 'copy.txt'])
  assert.deepEqual(parsePorcelainZ(''), [])
})

test('gitChangedFiles: changed files of a repository', async t => {
  if (!hasGit) { t.skip('git not in PATH'); return }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gcf-')))
  try {
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'core.autocrlf', 'false')
    write(root, 'mod.txt', 'one\n')
    write(root, 'old name.txt', 'rename me, with enough content to be detected\n')
    write(root, 'gone.txt')
    write(root, 'sub/inner.txt')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')

    write(root, 'mod.txt', 'two\n')
    write(root, 'added.txt')
    git(root, 'add', 'added.txt')
    write(root, 'sub/deep/untracked.txt')
    write(root, 'açaí e café.txt')
    git(root, 'mv', 'old name.txt', 'new name.txt')
    rmSync(join(root, 'gone.txt'))

    const all = (await gitChangedFiles(root)).sort()
    assert.deepEqual(all, ['added.txt', 'açaí e café.txt', 'mod.txt', 'new name.txt', join('sub', 'deep', 'untracked.txt')].map(f => join(root, f)).sort())

    const sub = (await gitChangedFiles(join(root, 'sub'))).sort()
    assert.deepEqual(sub, [join(root, 'sub', 'deep', 'untracked.txt')])

    assert.equal((await gitChangedFiles(root, { max: 2 })).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('gitChangedFiles: folder outside a repository gives an empty list', async t => {
  if (!hasGit) { t.skip('git not in PATH'); return }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gcf-nogit-')))
  try {
    write(dir, 'a.txt')
    assert.deepEqual(await gitChangedFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
