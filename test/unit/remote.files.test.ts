// RR4 step 4.3: the pure rules of the files of a speech from afar (src/remote/files.ts). Proved here:
// - the type is the signature of the first bytes, never the name: the four images, and everything else (SVG and HTML
//   included) is application/octet-stream;
// - the name an upload gets is the app's safe name (extensions/channels/attachments.ts safeFileName) and also loses the
//   control, bidi and zero-width characters; a secret's name is known;
// - the three bodies are strict: offsets on the chunk grid, whole chunks but the last, the ceilings of size and count;
// - the chunk fits one answer and one record of the relay.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { b64url, MAX_RECORD_CONTENT } from '../../src/remote/index.ts'
import { READ_BODY_MAX } from '../../src/remote/projection.ts'
import {
  cancelArgs, chunksOf, FILE_CHUNK_B64_MAX, FILE_CHUNK_BYTES, FILE_MAX_BYTES, FILES_PER_SAY_MAX, fileReadArgs, isSecretName, OTHER_TYPE,
  sayFiles, sniffType, uploadArgs, uploadName,
} from '../../src/remote/files.ts'
import { safeFileName } from '../../extensions/channels/attachments.ts'
import { talkArgs } from '../../src/remote/talk.ts'

const bytes = (...xs: number[]): Uint8Array => new Uint8Array(xs)
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('the type of a file is its first bytes', () => {
  test('png, jpeg, gif (87a and 89a) and webp by signature', () => {
    assert.equal(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)), 'image/png')
    assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
    assert.equal(sniffType(ascii('GIF87a....')), 'image/gif')
    assert.equal(sniffType(ascii('GIF89a....')), 'image/gif')
    assert.equal(sniffType(ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp')
  })

  test('SVG, HTML, a truncated signature, a RIFF that is no WEBP, nothing: all octet-stream', () => {
    for (const s of ['<svg xmlns="http://www.w3.org/2000/svg">', '<!doctype html><script>', '<html>', 'GIF8', 'GIF88a', 'RIFF\u0000\u0000\u0000\u0000WAVE', '%PDF-1.7', ''])
      assert.equal(sniffType(ascii(s)), OTHER_TYPE, JSON.stringify(s))
    assert.equal(sniffType(bytes(0x89, 0x50, 0x4e, 0x47)), OTHER_TYPE, 'a png cut short')
  })
})

describe('the name an upload gets', () => {
  test("the app's safe name for every plain name", () => {
    for (const n of ['foto.png', 'C:\\Users\\x\\foto.png', '../../etc/passwd', 'a:b*c?.txt', 'CON.txt', 'nul', 'lpt1.log', 'nome. . ', '...', '', 'x'.repeat(200) + '.jpeg', 'Captura de tela 2026-11-27 09.41.07.png'])
      assert.equal(uploadName(n), safeFileName(n), JSON.stringify(n))
  })

  test('controls, bidi overrides and zero-width characters go; a path is its last segment; never empty', () => {
    assert.equal(uploadName('fatura\u202Egnp.exe'), 'faturagnp.exe')
    assert.equal(uploadName('a\u200Bb\u0007c.png'), 'abc.png')
    assert.equal(uploadName('pasta/\u202E/x.png'), 'x.png')
    assert.equal(uploadName('\u200B\u202E'), 'arquivo')
    assert.equal(uploadName('linha\nquebrada.txt'), 'linha quebrada.txt')
  })

  test("a secret's name, as the app sees it", () => {
    for (const n of ['.env', '.env.local', 'prod.keys', 'cert.pem', 'id_rsa', 'id_rsa.pub', 'credentials.json', 'x.pfx', 'a.key']) assert.equal(isSecretName(n), true, n)
    for (const n of ['env.txt', 'foto.png', 'keys.md']) assert.equal(isSecretName(n), false, n)
  })
})

describe('the strict bodies', () => {
  const act = 'ab'.repeat(16)
  const chunk = (n: number): string => b64url(new Uint8Array(n).fill(7))
  const up = (b: Record<string, unknown>) => uploadArgs({ channel: 'c_1', act, file: 0, name: 'a.png', size: 10, offset: 0, data: chunk(10), ...b })

  test('channels.file: a channel id, a seq, an index, an offset on the chunk grid', () => {
    assert.deepEqual(fileReadArgs({ channel: 'c_1', seq: 4, file: 1 }), { channel: 'c_1', seq: 4, file: 1, offset: 0 })
    assert.deepEqual(fileReadArgs({ channel: 'c_1', seq: 4, file: 0, offset: FILE_CHUNK_BYTES }), { channel: 'c_1', seq: 4, file: 0, offset: FILE_CHUNK_BYTES })
    for (const b of [{ seq: 0 }, { seq: '4' }, { file: -1 }, { file: 64 }, { offset: 1 }, { offset: FILE_MAX_BYTES + FILE_CHUNK_BYTES }, { channel: '../c_2' }, { channel: 'c\u202E1' }])
      assert.equal(fileReadArgs({ channel: 'c_1', seq: 4, file: 0, ...b }), 'bad-request', JSON.stringify(b))
  })

  test('channels.upload: whole chunks on the grid, the last one the rest; over the ceiling `too-large`', () => {
    const a = up({ name: 'pasta\\fo\u202Eto.png' })
    assert.ok(typeof a !== 'string')
    assert.equal(a.name, 'foto.png')
    assert.equal(a.data.length, 10)
    assert.equal(a.secret, false)
    const big = FILE_CHUNK_BYTES + 5
    assert.ok(typeof up({ size: big, data: chunk(FILE_CHUNK_BYTES) }) !== 'string', 'the first of two')
    assert.ok(typeof up({ size: big, offset: FILE_CHUNK_BYTES, data: chunk(5) }) !== 'string', 'the last is the rest')
    assert.equal(up({ size: big, data: chunk(FILE_CHUNK_BYTES - 1) }), 'bad-request', 'a short chunk that is not the last')
    assert.equal(up({ size: big, offset: 5, data: chunk(5) }), 'bad-request', 'off the grid')
    assert.equal(up({ size: 10, offset: 10, data: '' }), 'bad-request', 'past the end')
    assert.equal(up({ size: FILE_MAX_BYTES + 1 }), 'too-large')
    assert.ok(typeof up({ size: FILE_MAX_BYTES, data: chunk(FILE_CHUNK_BYTES) }) !== 'string', 'the ceiling itself')
    for (const b of [{ act: 'AB'.repeat(16) }, { act: 'ab' }, { file: FILES_PER_SAY_MAX }, { name: '' }, { name: 'x'.repeat(513) }, { size: 0 }, { data: '!!!!' }, { data: 'x'.repeat(FILE_CHUNK_B64_MAX + 1) }, { channel: 'a b' }])
      assert.equal(up(b), 'bad-request', JSON.stringify(b).slice(0, 80))
    const s = up({ name: '.env' })
    assert.ok(typeof s !== 'string' && s.secret === true)
  })

  test('channels.upload-cancel and the files of a speech', () => {
    assert.deepEqual(cancelArgs({ act }), { act })
    assert.deepEqual(cancelArgs({ act, file: 2 }), { act, file: 2 })
    assert.equal(cancelArgs({ act, file: 4 }), 'bad-request')
    assert.deepEqual(sayFiles([0, 2]), [0, 2])
    for (const v of [[], [0, 0], [4], [0, 1, 2, 3, 0], '0', [1.5]]) assert.equal(sayFiles(v), 'bad-request', JSON.stringify(v))
    assert.deepEqual(talkArgs('channels.say', { channel: 'c_1', text: '', files: [0] }), { channel: 'c_1', args: { channel: 'c_1', text: '' }, files: [0] }, 'files alone')
    assert.deepEqual(talkArgs('channels.say', { channel: 'c_1', files: [0, 1] }), { channel: 'c_1', args: { channel: 'c_1', text: '' }, files: [0, 1] })
    assert.equal(talkArgs('channels.say', { channel: 'c_1', text: '' }), 'bad-request', 'no text and no files')
    assert.equal(talkArgs('channels.say', { channel: 'c_1', text: 'x', files: [{ path: 'C:/x' }] }), 'bad-request', 'a path is never a file of a speech')
  })

  test('a chunk is one answer and one record', () => {
    assert.equal(FILE_CHUNK_B64_MAX, b64url(new Uint8Array(FILE_CHUNK_BYTES)).length)
    const answer = JSON.stringify({ size: FILE_MAX_BYTES, type: 'application/octet-stream', offset: FILE_MAX_BYTES, data: 'x'.repeat(FILE_CHUNK_B64_MAX) }).length
    assert.ok(answer <= READ_BODY_MAX, `answer ${answer}`)
    const request = JSON.stringify({ channel: 'c'.repeat(64), act: 'a'.repeat(32), file: 3, name: 'n'.repeat(512), size: FILE_MAX_BYTES, offset: FILE_MAX_BYTES, data: 'x'.repeat(FILE_CHUNK_B64_MAX) }).length
    assert.ok(request + 4 + 2 + 1 + 16 <= MAX_RECORD_CONTENT, `request ${request}`)
    assert.equal(chunksOf(FILE_MAX_BYTES), 64)
  })
})
