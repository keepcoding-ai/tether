import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { applyEdits, type DiskEdit, replaceInFile, replaceInFiles } from '../../app/main/search-replace-disk.ts'

function edit(l1: number, c1: number, l2: number, c2: number, expected: string, text: string): DiskEdit {
  return { range: { startLineNumber: l1, startColumn: c1, endLineNumber: l2, endColumn: c2 }, expected, text }
}

let dir = ''
let n = 0
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'search-replace-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
async function make(content: string | Buffer): Promise<string> {
  const p = join(dir, `f${n++}.txt`)
  await writeFile(p, content)
  return p
}

describe('search-replace-disk', () => {
  it('replaces one match', async () => {
    const p = await make('hello world\n')
    const r = await replaceInFile({ path: p, edits: [edit(1, 7, 1, 12, 'world', 'there')] })
    assert.deepEqual(r, { path: p, status: 'replaced', count: 1 })
    assert.equal(await readFile(p, 'utf8'), 'hello there\n')
  })

  it('applies several edits on one line and on different lines without shifting columns', async () => {
    const p = await make('aa bb aa\ncc aa\nlast')
    const r = await replaceInFile({
      path: p,
      edits: [edit(1, 1, 1, 3, 'aa', 'XXXX'), edit(1, 7, 1, 9, 'aa', 'Y'), edit(2, 4, 2, 6, 'aa', 'ZZZ')],
    })
    assert.equal(r.status, 'replaced')
    assert.equal(await readFile(p, 'utf8'), 'XXXX bb Y\ncc ZZZ\nlast')
  })

  it('counts columns in UTF-16 units after accents and emoji', async () => {
    const p = await make('é😀 foo\n')
    // "é"=1, "😀"=2 units, space=1 -> foo starts at column 5
    const r = await replaceInFile({ path: p, edits: [edit(1, 5, 1, 8, 'foo', 'bar')] })
    assert.equal(r.status, 'replaced')
    assert.equal(await readFile(p, 'utf8'), 'é😀 bar\n')
  })

  it('preserves CRLF', async () => {
    const p = await make('one\r\ntwo\r\nthree')
    const r = await replaceInFile({ path: p, edits: [edit(2, 1, 2, 4, 'two', '2')] })
    assert.equal(r.status, 'replaced')
    assert.equal((await readFile(p)).toString('latin1'), 'one\r\n2\r\nthree')
  })

  it('does not let a single-line range swallow the CR', () => {
    assert.equal(applyEdits('ab\r\ncd', [edit(1, 1, 1, 4, 'ab\r', 'x')]), undefined)
  })

  it('replaces a multi-line range', async () => {
    const p = await make('a\nb\nc\nd\n')
    const r = await replaceInFile({ path: p, edits: [edit(2, 1, 3, 2, 'b\nc', 'BC')] })
    assert.equal(r.status, 'replaced')
    assert.equal(await readFile(p, 'utf8'), 'a\nBC\nd\n')
  })

  it('reports changed and leaves the file intact when the text moved', async () => {
    const p = await make('hello world\n')
    await writeFile(p, 'hello planet\n')
    const r = await replaceInFile({ path: p, edits: [edit(1, 7, 1, 12, 'world', 'there')] })
    assert.deepEqual(r, { path: p, status: 'changed' })
    assert.equal(await readFile(p, 'utf8'), 'hello planet\n')
  })

  it('writes nothing when one of several edits does not match', async () => {
    const p = await make('a b c\n')
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 2, 'a', 'X'), edit(1, 3, 1, 4, 'Z', 'Y'), edit(1, 5, 1, 6, 'c', 'W')] })
    assert.equal(r.status, 'changed')
    assert.equal(await readFile(p, 'utf8'), 'a b c\n')
  })

  it('treats overlapping edits as changed', async () => {
    const p = await make('abcdef\n')
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 4, 'abc', 'X'), edit(1, 3, 1, 6, 'cde', 'Y')] })
    assert.equal(r.status, 'changed')
    assert.equal(await readFile(p, 'utf8'), 'abcdef\n')
  })

  it('reports missing for a file that does not exist', async () => {
    const r = await replaceInFile({ path: join(dir, 'nope.txt'), edits: [edit(1, 1, 1, 2, 'a', 'b')] })
    assert.equal(r.status, 'missing')
  })

  it('refuses paths that are not allowed without touching disk', async () => {
    const p = await make('a\n')
    const [r] = await replaceInFiles([{ path: p, edits: [edit(1, 1, 1, 2, 'a', 'b')] }], { allowed: () => false })
    assert.deepEqual(r, { path: p, status: 'refused' })
    assert.equal(await readFile(p, 'utf8'), 'a\n')
  })

  it('preserves a UTF-8 BOM', async () => {
    const p = await make(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('foo\n')]))
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 4, 'foo', 'barr')] })
    assert.equal(r.status, 'replaced')
    assert.deepEqual([...(await readFile(p))], [0xef, 0xbb, 0xbf, ...Buffer.from('barr\n')])
  })

  it('preserves a UTF-16 LE BOM and encoding', async () => {
    const p = await make(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('foo\n', 'utf16le')]))
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 4, 'foo', 'ç')] })
    assert.equal(r.status, 'replaced')
    assert.deepEqual([...(await readFile(p))], [0xff, 0xfe, ...Buffer.from('ç\n', 'utf16le')])
  })

  it('preserves a UTF-16 BE BOM and encoding', async () => {
    const p = await make(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('foo\n', 'utf16le').swap16()]))
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 4, 'foo', 'x')] })
    assert.equal(r.status, 'replaced')
    assert.deepEqual([...(await readFile(p))], [0xfe, 0xff, ...Buffer.from('x\n', 'utf16le').swap16()])
  })

  it('fails on invalid UTF-8', async () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62])
    const p = await make(bytes)
    const r = await replaceInFile({ path: p, edits: [edit(1, 1, 1, 2, 'a', 'b')] })
    assert.deepEqual(r, { path: p, status: 'failed', message: 'A codificação deste arquivo não é suportada para substituição.' })
    assert.deepEqual([...(await readFile(p))], [...bytes])
  })

  it('stops before the next file when aborted midway', async () => {
    const a = await make('a\n')
    const b = await make('a\n')
    const c = await make('a\n')
    const ctl = new AbortController()
    const files = [a, b, c].map((path) => ({ path, edits: [edit(1, 1, 1, 2, 'a', 'z')] }))
    const out = await replaceInFiles(files, {
      allowed: (path) => {
        if (path === b) ctl.abort()
        return true
      },
      signal: ctl.signal,
    })
    assert.deepEqual(out.map((o) => o.path), [a, b])
    assert.equal(await readFile(c, 'utf8'), 'a\n')
  })

  it('applyEdits is pure and rejects out-of-bounds ranges', () => {
    assert.equal(applyEdits('abc\n', [edit(1, 1, 1, 9, 'abc', 'x')]), undefined)
    assert.equal(applyEdits('abc\n', [edit(3, 1, 3, 2, 'a', 'x')]), undefined)
    assert.equal(applyEdits('abc\n', [edit(0, 1, 1, 2, 'a', 'x')]), undefined)
    assert.equal(applyEdits('abc', [edit(1, 1, 1, 2, 'a', 'x')]), 'xbc')
  })
})
