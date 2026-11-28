// RR4 step 4.3, the device's side with no screen: the files of a speech from afar.
// - file-rules.ts: the reference a file of a line goes by (never a path), and the pace of the chunks;
// - files.ts: a file of the conversation comes chunk by chunk and is drawn only when the portal's type and the bytes' own
//   signature agree on one of the four images (an SVG or HTML called "image/png" is a file to download, never a picture);
//   over the ceiling it is never asked for; the download always goes as application/octet-stream; the box's files are this
//   page's, under a local key, with a thumbnail only of a checked image;
// - talk.ts: the files of a speech go up chunk by chunk under its actId before it, resume from where the house is after a
//   cut, pause on the pace, stop on "Cancelar" (the house is told to give them up), and the speech then carries their indexes.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { b64url, fromB64url, opByName, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES } from '../../src/remote/files.ts'
import { chunkPace, fileRef, parseFileRef, REMOTE_ATTACH_LIMITS } from '../../remote/web/src/file-rules.ts'
import { remoteFiles, type FileChunks } from '../../remote/web/src/files.ts'
import { createTalker, type KeyValue, type TalkSession } from '../../remote/web/src/talk.ts'
import { parseOutbox, serializeOutbox } from '../../remote/web/src/talk-rules.ts'

const OP = { say: opByName('channels.say')!.code, upload: opByName('channels.upload')!.code, cancel: opByName('channels.upload-cancel')!.code }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('the reference of a file of a line', () => {
  test('channel, seq and index; a path or a name is no reference', () => {
    assert.equal(fileRef('c_1', 12, 0), 'rr/c_1/12/0')
    assert.deepEqual(parseFileRef('rr/c_1/12/3'), { channel: 'c_1', seq: 12, index: 3 })
    for (const r of ['foto.png', 'C:/Users/x/foto.png', 'rr/../12/0', 'rr/c_1/0/0', 'rr/c_1/12/100', 'local/1', 'rr/c 1/1/0']) assert.equal(parseFileRef(r), undefined, r)
  })

  test('the pace lets so many chunks a minute go, then waits for the oldest to leave the window', async () => {
    let t = 0
    const waited: number[] = []
    const p = chunkPace({ perMin: 2, now: () => t, wait: async ms => { waited.push(ms); t += ms } })
    await p.take()
    await p.take()
    await p.take()
    assert.deepEqual(waited, [60_000])
    assert.deepEqual(REMOTE_ATTACH_LIMITS, { files: 4, bytes: FILE_MAX_BYTES })
  })
})

/** A house that serves files of lines from a map: `${channel}/${seq}/${index}` → bytes and the type it says. */
function houseOf(files: Record<string, { bytes: Uint8Array; type: string } | 'gone'>): FileChunks & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fileChunk: async (channel, seq, index, offset) => {
      asked.push(`${channel}/${seq}/${index}@${offset}`)
      const f = files[`${channel}/${seq}/${index}`]
      if (!f || f === 'gone') throw Object.assign(new Error('not-found'), { why: 'not-found' })
      return { size: f.bytes.length, type: f.type, offset, data: b64url(f.bytes.subarray(offset, offset + FILE_CHUNK_BYTES)) }
    },
  }
}

describe('a file of the conversation', () => {
  test('an image comes by chunks and is drawn from a blob of the checked bytes', async () => {
    const big = new Uint8Array(FILE_CHUNK_BYTES + 10)
    big.set(PNG)
    const h = houseOf({ 'c_1/4/0': { bytes: big, type: 'image/png' } })
    const f = remoteFiles(h)
    const ref = fileRef('c_1', 4, 0)
    f.known(ref, { name: 'foto.png', size: big.length, type: 'image/png' })
    const [look] = await f.look([ref])
    assert.match(look!.thumb ?? '', /^blob:/)
    assert.deepEqual(h.asked, ['c_1/4/0@0', `c_1/4/0@${FILE_CHUNK_BYTES}`])
    const v = await f.view(ref)
    assert.equal(v.url, look!.thumb, 'the same bytes, asked once')
    assert.equal(h.asked.length, 2)
    const g = await f.get(ref)
    assert.ok(g.kind === 'image')
    assert.deepEqual(new Uint8Array(await g.blob.arrayBuffer()), big)
    f.dispose()
  })

  test('an SVG or HTML the house calls an image is a file to download, never drawn; downloads go as octet-stream', async () => {
    const saved: Array<{ type: string; name: string; bytes: Uint8Array }> = []
    const h = houseOf({ 'c_1/5/0': { bytes: SVG, type: 'image/png' }, 'c_1/5/1': { bytes: PNG, type: 'image/png' } })
    const f = remoteFiles(h, { save: (b, name) => { void b.arrayBuffer().then(a => saved.push({ type: b.type, name, bytes: new Uint8Array(a) })) } })
    f.known(fileRef('c_1', 5, 0), { name: 'x.png', size: SVG.length, type: 'image/png' })
    f.known(fileRef('c_1', 5, 1), { name: 'foto.png', size: PNG.length, type: 'image/png' })
    const [look] = await f.look([fileRef('c_1', 5, 0)])
    assert.equal(look!.thumb, undefined)
    const v = await f.view(fileRef('c_1', 5, 0))
    assert.equal(v.url, undefined)
    assert.match(v.note ?? '', /Baixar/)
    await f.download(fileRef('c_1', 5, 0))
    await f.download(fileRef('c_1', 5, 1))
    await flush()
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(saved.map(s => [s.type, s.name]), [['application/octet-stream', 'x.png'], ['application/octet-stream', 'foto.png']])
    assert.deepEqual(saved[0]!.bytes, SVG)
    f.dispose()
  })

  test('over the ceiling nothing is asked: name, size and "grande demais"; a file the house does not have is gone', async () => {
    const h = houseOf({ 'c_1/6/1': 'gone' })
    const f = remoteFiles(h)
    f.known(fileRef('c_1', 6, 0), { name: 'video.png', size: FILE_MAX_BYTES + 1, type: 'image/png' })
    f.known(fileRef('c_1', 6, 1), { name: 'sumiu.png', size: 3, type: 'image/png' })
    f.known(fileRef('c_1', 6, 2), { name: 'doc.pdf', size: 3, type: 'application/pdf' })
    const looks = await f.look([fileRef('c_1', 6, 0), fileRef('c_1', 6, 1), fileRef('c_1', 6, 2)])
    assert.deepEqual(looks[0], { path: fileRef('c_1', 6, 0), missing: false, note: 'grande demais para ver de longe' })
    assert.deepEqual(looks[1], { path: fileRef('c_1', 6, 1), missing: true })
    assert.deepEqual(looks[2], { path: fileRef('c_1', 6, 2), missing: false }, 'a PDF is not fetched without the person asking')
    assert.deepEqual(h.asked, ['c_1/6/1@0'])
    f.dispose()
  })

  test("the box's files are this page's: a thumbnail only of a checked image, an empty file is not there", async () => {
    const f = remoteFiles(houseOf({}), { choose: async () => [new File([PNG], 'foto.png'), new File([SVG], 'falsa.png'), new File([], 'vazio.txt')] })
    const infos = await f.pick()
    assert.deepEqual(infos.map(i => [i.name, i.size, i.thumb !== undefined, i.missing, i.staged]), [['foto.png', PNG.length, true, false, true], ['falsa.png', SVG.length, false, false, true], ['vazio.txt', 0, false, true, true]])
    assert.deepEqual(f.local(infos.map(i => i.path)).map(x => x.name), ['foto.png', 'falsa.png', 'vazio.txt'])
    f.discard([infos[0]!.path])
    assert.deepEqual(f.local(infos.map(i => i.path)).map(x => x.name), ['falsa.png', 'vazio.txt'])
    assert.equal(f.limits?.files, 4)
    f.dispose()
  })
})

// ---- the talker over a made-up session and a manual clock

function bench() {
  let clock = 10_000
  const timers: { at: number; f: () => void }[] = []
  const mem = new Map<string, string>()
  const store: KeyValue = { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v) }, remove: k => { mem.delete(k) } }
  const make = () => createTalker({
    houseId: 'h1', store, now: () => clock,
    setTimer: (f, ms) => { const t = { at: clock + ms, f }; timers.push(t); return t },
    clearTimer: t => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = async (ms: number): Promise<void> => {
    clock += ms
    for (;;) {
      await flush()
      const due = timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.f()
    }
    await flush()
  }
  return { make, advance, mem }
}

type Answer = (op: number, body: Record<string, unknown>, n: number) => Promise<{ status: number; body: Record<string, unknown> }>
function session(answer: Answer) {
  const calls: { op: number; body: Record<string, unknown>; actId: string }[] = []
  const s: TalkSession & { calls: typeof calls; ended: unknown } = {
    calls, ended: undefined,
    request: (op, body, o) => { calls.push({ op, body, actId: o?.actId ? toHex(o.actId as Bytes) : '' }); return answer(op, body, calls.length) },
  }
  return s
}
const ok = (body: Record<string, unknown>) => Promise.resolve({ status: RES_STATUS.ok, body })
/** A portal that keeps what each upload holds, as src/remoted/files.ts does: a chunk off its offset answers where it is. */
function portal() {
  const held = new Map<string, number>()
  const answer: Answer = async (op, body) => {
    if (op === OP.upload) {
      const key = `${body.act}/${body.file}`
      const at = held.get(key) ?? 0
      if (body.offset !== at) return ok({ received: at, done: false })
      const n = at + fromB64url(body.data as string).length
      held.set(key, n)
      return ok({ received: n, done: n === body.size })
    }
    if (op === OP.say) return ok({ seq: 30 })
    return ok({})
  }
  return { held, answer }
}
const until = async (b: ReturnType<typeof bench>, f: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !f(); i++) { await b.advance(25); await new Promise(r => setTimeout(r, 1)) }
  assert.ok(f(), what)
}

describe('the files of a speech go up before it', () => {
  test('chunk by chunk under its actId, then the speech with their indexes; the outbox keeps names and sizes only', async () => {
    const b = bench()
    const t = b.make()
    const p = portal()
    const s = session(p.answer)
    t.attach(s)
    const big = new Uint8Array(FILE_CHUNK_BYTES + 7).fill(9)
    await t.say('obra', '', [], [{ file: new Blob([PNG]), name: 'foto.png' }, { file: new Blob([big]), name: 'dados.bin' }])
    await until(b, () => t.items('obra')[0]?.state === 'sent', 'the speech went')
    const ups = s.calls.filter(c => c.op === OP.upload)
    const say = s.calls.find(c => c.op === OP.say)!
    assert.deepEqual(ups.map(c => [c.body.file, c.body.offset, c.body.act === say.actId]), [[0, 0, true], [1, 0, true], [1, FILE_CHUNK_BYTES, true]])
    assert.equal(new Set(ups.map(c => c.actId)).size, ups.length, 'each chunk has an actId of its own')
    assert.deepEqual(say.body, { channel: 'obra', text: '', files: [0, 1] })
    const kept = [...b.mem.values()].find(v => v.includes('"items"'))!
    assert.deepEqual(parseOutbox(kept)[0]!.files, [{ name: 'foto.png', size: PNG.length }, { name: 'dados.bin', size: big.length }])
    assert.equal(kept.includes(b64url(PNG)), false, 'no byte in the storage')
    assert.equal(t.progress(say.actId), undefined, 'the bytes were let go of')
    assert.deepEqual(parseOutbox(serializeOutbox(parseOutbox(kept))), parseOutbox(kept))
  })

  test('a cut in the middle: the next session goes on from where the house is, and the speech is said once', async () => {
    const b = bench()
    const t = b.make()
    const p = portal()
    let cut = true
    const first = session(async (op, body, n) => {
      if (op === OP.upload && body.offset === FILE_CHUNK_BYTES && cut) { cut = false; first.ended = { by: 'route' }; return { status: -1, body: {} } }
      return p.answer(op, body, n)
    })
    t.attach(first)
    const big = new Uint8Array(2 * FILE_CHUNK_BYTES + 1).fill(3)
    await t.say('obra', 'segue', [], [{ file: new Blob([big]), name: 'grande.bin' }])
    await until(b, () => first.calls.filter(c => c.op === OP.upload).length === 2, 'two chunks tried')
    assert.equal(t.items('obra')[0]!.state, 'sending')
    assert.deepEqual(t.progress(t.items('obra')[0]!.id)!.map(x => x.received), [FILE_CHUNK_BYTES])
    t.detach()
    const second = session(p.answer)
    t.attach(second)
    await until(b, () => t.items('obra')[0]?.state === 'sent', 'the speech went')
    assert.deepEqual(second.calls.filter(c => c.op === OP.upload).map(c => c.body.offset), [FILE_CHUNK_BYTES, 2 * FILE_CHUNK_BYTES], 'from where the house was')
    assert.equal([...first.calls, ...second.calls].filter(c => c.op === OP.say).length, 1)
  })

  test('the pace of the portal holds a chunk and sends it again; "Cancelar" stops, tells the house, gives the text back', async () => {
    const b = bench()
    const t = b.make()
    const p = portal()
    let held = 0
    let stall: (() => void) | undefined
    const s = session(async (op, body, n) => {
      if (op === OP.upload && held === 0) { held++; return { status: RES_STATUS.limit, body: { error: 'slow-down' } } }
      if (op === OP.upload && body.offset === FILE_CHUNK_BYTES) await new Promise<void>(r => { stall = r })
      return p.answer(op, body, n)
    })
    t.attach(s)
    // The box lets go after its first wait (FIRST_REPLY_MS) while the files go up: the clock is moved meanwhile.
    const said = t.say('obra', 'texto', [], [{ file: new Blob([new Uint8Array(3 * FILE_CHUNK_BYTES)]), name: 'v.bin' }])
    await until(b, () => stall !== undefined, 'the second chunk waits')
    await said
    const ups = s.calls.filter(c => c.op === OP.upload).map(c => c.body.offset)
    assert.deepEqual(ups, [0, 0, FILE_CHUNK_BYTES], 'held, then the same chunk again')
    const id = t.items('obra')[0]!.id
    const back = t.cancel(id)
    assert.equal(back?.text, 'texto')
    assert.equal(t.items('obra').length, 0)
    stall!()
    await b.advance(5_000)
    await flush()
    assert.deepEqual(s.calls.filter(c => c.op === OP.cancel).map(c => c.body), [{ act: id }])
    assert.equal(s.calls.filter(c => c.op === OP.say).length, 0, 'never said')
    assert.equal(s.calls.filter(c => c.op === OP.upload).length, 3, 'nothing more went up')
  })

  test('more than four files, or a file over the ceiling, never leave', async () => {
    const t = bench().make()
    const f = (n = 1) => ({ file: new Blob([new Uint8Array(n)]), name: 'a' })
    await assert.rejects(t.say('obra', 'x', [], [f(), f(), f(), f(), f()]))
    await assert.rejects(t.say('obra', 'x', [], [{ file: { size: FILE_MAX_BYTES + 1 } as Blob, name: 'g' }]))
    assert.equal(t.items('obra').length, 0)
  })
})
