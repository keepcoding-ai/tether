// RR4 step 4.3: the files of a speech from afar at the portal (src/remoted/files.ts and the three lines in house.ts).
// Proved here, on a real disk under a bench home:
// - a file of a line is given only when, resolved, it is a regular file directly inside that channel's folder: `..`, a
//   junction or a symbolic link out, another channel's folder, a hard link, a folder of files that is a link itself, a
//   line without that file, an index out, the staging folder: all the same `not-found`;
// - the type is the signature, a file over the ceiling is never read, the chunks rebuild the file;
// - an upload is written only in the channel's folder, renamed only when whole and of the size announced, a repeat changes
//   nothing, a device that comes back goes on from `received`, a cancel and an abandoned upload leave nothing, a portal that
//   starts cleans what an earlier one left, the ceilings of uploads at once hold;
// - through a real House: the round trip of an image (upload, speech with `files` → tetherd gets the paths, the device
//   never), the refusals, the device's bytes of files a minute, and the audit (device, op, channel, size; never the name).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { b64url, fromB64url, OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, uploadArgs, type UploadArgs } from '../../src/remote/files.ts'
import { linePathOf, PortalFiles, UPLOAD_DIR, UPLOADS_PER_DEVICE_MAX } from '../../src/remoted/files.ts'
import { pipeReads, type ExtRequestFn } from '../../src/remoted/reads.ts'
import { pipeWrites } from '../../src/remoted/writes.ts'
import { actId, ORIGIN, registerAndUnlock } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { benchHome, until, type DeviceSession } from './remoted.helpers.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)])
const homes: string[] = []
after(async () => { for (const h of homes) await rm(h, { recursive: true, force: true }) })

async function bench(): Promise<{ home: string; files: PortalFiles; folder: (id: string) => string; outside: string }> {
  const home = benchHome('remoted-files-')
  homes.push(home)
  for (const id of ['c_1', 'c_2']) await mkdir(join(home, 'channels', id, 'files'), { recursive: true })
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'segredo')
  return { home, files: new PortalFiles({ home, now: Date.now, log: () => {} }), folder: (id) => join(home, 'channels', id, 'files'), outside }
}

const tryLink = async (make: () => Promise<void>): Promise<boolean> => { try { await make(); return true } catch { return false } }

describe('a file of a line: inside its channel folder, or not there', () => {
  test('a file of the folder is read by chunks, its type by its bytes', async () => {
    const b = await bench()
    const big = Buffer.concat([PNG, randomBytes(FILE_CHUNK_BYTES + 100)])
    await writeFile(join(b.folder('c_1'), 'foto.png'), big)
    await writeFile(join(b.folder('c_1'), 'desenho.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')
    const one = await b.files.chunk('c_1', join(b.folder('c_1'), 'foto.png'), 0)
    assert.ok(typeof one !== 'string')
    assert.deepEqual([one.size, one.type, one.offset], [big.length, 'image/png', 0])
    const two = await b.files.chunk('c_1', join(b.folder('c_1'), 'foto.png'), FILE_CHUNK_BYTES)
    assert.ok(typeof two !== 'string')
    assert.deepEqual(Buffer.concat([fromB64url(one.data), fromB64url(two.data)]), big)
    assert.equal(await b.files.chunk('c_1', join(b.folder('c_1'), 'foto.png'), 2 * FILE_CHUNK_BYTES), 'bad-request', 'past the end')
    const svg = await b.files.chunk('c_1', join(b.folder('c_1'), 'desenho.svg'), 0)
    assert.ok(typeof svg !== 'string' && svg.type === 'application/octet-stream', 'an SVG is never an image')
  })

  test('`..`, a link out, another channel, a hard link, a staging file, a folder that is a link: not-found', async () => {
    const b = await bench()
    const f1 = b.folder('c_1')
    await writeFile(join(b.folder('c_2'), 'dela.txt'), 'outro canal')
    const no = async (path: string, what: string, channel = 'c_1'): Promise<void> => {
      assert.equal(await b.files.resolve(channel, path), undefined, what)
      assert.equal(await b.files.chunk(channel, path, 0), 'not-found', what)
    }
    await no(join(f1, '..', '..', '..', 'outside', 'secret.txt'), '`..` out of the folder')
    await no(`${f1}/../../c_2/files/dela.txt`, 'another channel by `..`')
    await no(join(b.folder('c_2'), 'dela.txt'), "another channel's folder")
    await no(join(f1, 'nada.txt'), 'gone')
    await no(f1, 'the folder itself')
    // A junction and a hard link need no privilege; a file's symbolic link may (Windows without developer mode): tried.
    assert.ok(await tryLink(() => symlink(b.outside, join(f1, 'sub'), 'junction')), 'a junction made')
    await no(join(f1, 'sub', 'secret.txt'), 'a junction out')
    if (await tryLink(() => symlink(join(b.outside, 'secret.txt'), join(f1, 'atalho.txt'), 'file'))) await no(join(f1, 'atalho.txt'), 'a symbolic link out')
    assert.ok(await tryLink(() => link(join(b.outside, 'secret.txt'), join(f1, 'duro.txt'))), 'a hard link made')
    await no(join(f1, 'duro.txt'), 'a hard link')
    await mkdir(join(f1, UPLOAD_DIR), { recursive: true })
    await writeFile(join(f1, UPLOAD_DIR, 'x-0-abc.ready'), PNG)
    await no(join(f1, UPLOAD_DIR, 'x-0-abc.ready'), 'a file still to be said')
    // The channel's folder of files is itself a junction to elsewhere: nothing of it is given.
    const evil = b.folder('c_2')
    await rm(evil, { recursive: true })
    await mkdir(join(b.outside, 'files'))
    await writeFile(join(b.outside, 'files', 'a.png'), PNG)
    assert.ok(await tryLink(() => symlink(join(b.outside, 'files'), evil, 'junction')))
    await no(join(evil, 'a.png'), 'a folder of files that is a link', 'c_2')
    await no(join(f1, 'x.txt'), 'a channel that does not exist', 'c_9')
  })

  test('over the ceiling a file is never read', async () => {
    const b = await bench()
    await writeFile(join(b.folder('c_1'), 'grande.bin'), Buffer.alloc(FILE_MAX_BYTES + 1))
    assert.equal(await b.files.chunk('c_1', join(b.folder('c_1'), 'grande.bin'), 0), 'too-large')
  })

  test("the path comes from the line: only a message's file at that index", () => {
    const answer = { lines: [{ seq: 4, kind: 'message', files: [{ path: 'C:/h/channels/c_1/files/a.png' }] }, { seq: 5, kind: 'poll', files: [{ path: 'C:/x' }] }] }
    assert.equal(linePathOf(answer, 4, 0), 'C:/h/channels/c_1/files/a.png')
    assert.equal(linePathOf(answer, 4, 1), undefined, 'index out')
    assert.equal(linePathOf(answer, 5, 0), undefined, 'not a message')
    assert.equal(linePathOf(answer, 6, 0), undefined, 'no such line')
    assert.equal(linePathOf({ lines: [{ seq: 4, kind: 'message' }] }, 4, 0), undefined, 'a line without files')
    assert.equal(linePathOf({ lines: [{ seq: 4, kind: 'message', files: [{ path: 'relativo.png' }] }] }, 4, 0), undefined, 'a relative path')
  })
})

describe('an upload: in the channel folder only, renamed when whole', () => {
  const act = (): string => toHex(randomBytes(16))
  const args = (o: Partial<Record<string, unknown>> & { data: Uint8Array }): UploadArgs => {
    const a = uploadArgs({ channel: 'c_1', act: 'ab'.repeat(16), file: 0, name: 'foto.png', size: o.data.length, offset: 0, ...o, data: b64url(o.data) })
    assert.ok(typeof a !== 'string', String(a))
    return a
  }

  test('chunk by chunk, a repeat changes nothing, a wrong offset answers where it is, whole it is ready', async () => {
    const b = await bench()
    const id = act()
    const data = Buffer.concat([PNG, randomBytes(FILE_CHUNK_BYTES)])
    const first = args({ act: id, size: data.length, data: data.subarray(0, FILE_CHUNK_BYTES) })
    const last = args({ act: id, size: data.length, offset: FILE_CHUNK_BYTES, data: data.subarray(FILE_CHUNK_BYTES) })
    assert.deepEqual(await b.files.upload('d1', last), { received: 0, done: false }, 'not begun: from 0')
    assert.deepEqual(await b.files.upload('d1', first), { received: FILE_CHUNK_BYTES, done: false })
    assert.deepEqual(await b.files.upload('d1', first), { received: FILE_CHUNK_BYTES, done: false }, 'a repeat writes nothing')
    const staging = join(b.folder('c_1'), UPLOAD_DIR)
    assert.deepEqual(readdirSync(staging).map((f) => f.endsWith('.part')), [true], 'a temporary file, in the channel folder')
    assert.equal(await b.files.forSpeech('d1', id, 'c_1', [0]), undefined, 'not whole: no speech')
    assert.deepEqual(await b.files.upload('d1', last), { received: data.length, done: true })
    assert.deepEqual(await b.files.upload('d1', last), { received: data.length, done: true }, 'done stays done')
    assert.deepEqual(readdirSync(staging).map((f) => f.endsWith('.ready')), [true])
    assert.equal(await b.files.forSpeech('d1', id, 'c_2', [0]), undefined, 'another channel')
    assert.equal(await b.files.forSpeech('d2', id, 'c_1', [0]), undefined, 'another device')
    const s = await b.files.forSpeech('d1', id, 'c_1', [0])
    assert.ok(s && s.length === 1 && s[0]!.name === 'foto.png')
    assert.deepEqual(await readFile(s[0]!.path), data)
    await b.files.settled('d1', id, true)
    assert.ok(await b.files.forSpeech('d1', id, 'c_1', [0]), 'a speech never sent keeps its files')
    await b.files.settled('d1', id, false)
    assert.deepEqual(readdirSync(staging), [], 'said: nothing left')
    assert.equal(b.files.uploads, 0)
  })

  test("another file's name, size or channel under the same key is refused; a secret's name never starts", async () => {
    const b = await bench()
    const id = act()
    const data = randomBytes(FILE_CHUNK_BYTES + 1)
    await b.files.upload('d1', args({ act: id, size: data.length, data: data.subarray(0, FILE_CHUNK_BYTES) }))
    assert.equal(await b.files.upload('d1', args({ act: id, name: 'outro.png', size: data.length, offset: FILE_CHUNK_BYTES, data: data.subarray(FILE_CHUNK_BYTES) })), 'bad-request')
    assert.equal(await b.files.upload('d1', args({ act: id, name: '.env', data: randomBytes(3) })), 'secret-file')
    assert.equal(await b.files.upload('d1', args({ act: act(), channel: 'c_9', data: randomBytes(3) })), 'not-found', 'no such channel: nothing made')
    assert.equal(existsSync(join(b.home, 'channels', 'c_9')), false)
    // A dots-only id would name the folder above the channels: refused by the body, and by the disk's own guard.
    for (const channel of ['..', '.']) {
      assert.equal(uploadArgs({ channel, act: 'ab'.repeat(16), file: 0, name: 'a.png', size: 3, offset: 0, data: b64url(randomBytes(3)) }), 'bad-request', channel)
      assert.equal(await b.files.upload('d1', { ...args({ act: act(), data: randomBytes(3) }), channel }), 'not-found', channel)
      assert.equal(await b.files.chunk(channel, join(b.home, 'outside', 'secret.txt'), 0), 'not-found', channel)
    }
    assert.equal(existsSync(join(b.home, 'files')), false, 'nothing made above the channels')
  })

  test('cancel, abandon and a new portal leave nothing; the ceilings of uploads at once hold', async () => {
    const b = await bench()
    const half = (id: string, file = 0) => args({ act: id, file, size: FILE_CHUNK_BYTES + 1, data: randomBytes(FILE_CHUNK_BYTES) })
    const a = act()
    await b.files.upload('d1', half(a, 0))
    await b.files.upload('d1', half(a, 1))
    await b.files.cancel('d1', a, 1)
    assert.equal(b.files.uploads, 1)
    await b.files.cancel('d1', a)
    assert.equal(b.files.uploads, 0)
    const staging = join(b.folder('c_1'), UPLOAD_DIR)
    assert.deepEqual(readdirSync(staging), [])
    await b.files.upload('d1', half(act()))
    await b.files.sweep(Date.now(), 60_000)
    assert.equal(b.files.uploads, 1, 'not idle yet')
    await b.files.sweep(Date.now() + 60_000, 60_000)
    assert.equal(b.files.uploads, 0, 'abandoned')
    assert.deepEqual(readdirSync(staging), [])
    for (let i = 0; i < UPLOADS_PER_DEVICE_MAX; i++) assert.notEqual(await b.files.upload('d1', half(act())), 'busy')
    assert.equal(await b.files.upload('d1', half(act())), 'busy', 'one device holds two speeches at most')
    assert.notEqual(await b.files.upload('d2', half(act())), 'busy', 'another device still may')
    const again = new PortalFiles({ home: b.home, now: Date.now, log: () => {} })
    await again.sweepDisk()
    assert.deepEqual(readdirSync(staging), [], 'what a previous portal left goes at start')
  })
})

// ---- through a real House -------------------------------------------------------------------------------------------

describe('the three file lines through a real House', () => {
  let hb: HouseBench
  let s: DeviceSession
  let home = ''
  let folder = ''
  const said: Array<Record<string, unknown>> = []
  const lines = new Map<number, unknown>()
  const OP = { file: OP_CODES['channels.file'], upload: OP_CODES['channels.upload'], cancel: OP_CODES['channels.upload-cancel'], say: OP_CODES['channels.say'] }

  before(async () => {
    home = benchHome('remoted-files-house-')
    homes.push(home)
    folder = join(home, 'channels', 'c_1', 'files')
    await mkdir(folder, { recursive: true })
    const reads: ExtRequestFn = async (b) => {
      if (b.name !== 'history') throw new Error('only history')
      const seq = (b.args.before as number) - 1
      return { result: { lines: lines.has(seq) ? [lines.get(seq)] : [] } }
    }
    const writes: ExtRequestFn = async (b) => {
      said.push(structuredClone(b.args))
      return { result: { line: { seq: 40 } } }
    }
    hb = await startHouseBench({
      origin: ORIGIN, reads: pipeReads(reads), writes: pipeWrites(writes), files: new PortalFiles({ home, now: Date.now, log: () => {} }),
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, fileChunksPerDevicePerMin: 12, strikesMax: 50 },
    })
    await registerAndUnlock(hb.fresh, hb.device.kD.pub)
    s = hb.fresh
  })
  after(async () => { await hb?.stop() })

  test('an image goes up, the speech carries it to tetherd by path, the device reads one back; the audit has sizes and no name', async () => {
    const from = hb.audits().length
    const speech: Bytes = actId()
    const act = toHex(speech)
    const name = `foto-${randomBytes(6).toString('hex')}.png`
    const up = await s.request(OP.upload, { channel: 'c_1', act, file: 0, name, size: PNG.length, offset: 0, data: b64url(PNG) }, { actId: actId() })
    assert.deepEqual(up, { status: RES_STATUS.ok, body: { received: PNG.length, done: true } })
    const r = await s.request(OP.say, { channel: 'c_1', text: 'olha', files: [0] }, { actId: speech })
    assert.deepEqual(r, { status: RES_STATUS.ok, body: { seq: 40 } })
    const files = said.at(-1)!.files as Array<{ path: string; name: string }>
    assert.equal(files.length, 1)
    assert.equal(files[0]!.name, name)
    assert.ok(files[0]!.path.startsWith(join(folder, UPLOAD_DIR)), 'a path tetherd copies from, inside the channel folder')
    // A line of an agent with that image, as tetherd keeps it: the device asks by (channel, seq, index).
    await writeFile(join(folder, 'agente.png'), PNG)
    lines.set(41, { seq: 41, kind: 'message', files: [{ name: 'agente.png', path: join(folder, 'agente.png'), size: PNG.length, type: 'image/png' }] })
    const got = await s.request(OP.file, { channel: 'c_1', seq: 41, file: 0, offset: 0 })
    assert.equal(got.status, RES_STATUS.ok)
    assert.deepEqual(Object.keys(got.body).sort(), ['data', 'offset', 'size', 'type'])
    assert.equal(got.body.type, 'image/png')
    assert.deepEqual(Buffer.from(fromB64url(got.body.data as string)), PNG)
    assert.equal(JSON.stringify(got.body).includes(folder.replaceAll('\\', '\\\\')), false, 'no path')
    const mine = hb.audits().slice(from)
    assert.ok(mine.some((a) => a.act === 'channels.upload' && a.result === `done:${PNG.length}` && a.target === 'c_1' && a.deviceId))
    assert.ok(mine.some((a) => a.act === 'channels.say' && a.target === 'c_1'))
    assert.ok(mine.some((a) => a.act === 'channels.file' && a.result === `ok:${PNG.length}` && a.target === 'c_1'))
    assert.equal(JSON.stringify(mine).includes(name), false, 'never the name')
  })

  test('the refusals: not-found for every file that is not that line\'s, unknown-file for a speech without its upload', async () => {
    lines.set(50, { seq: 50, kind: 'message', files: [{ name: 's.txt', path: join(home, 'outside.txt'), size: 1, type: 'text/plain' }] })
    await writeFile(join(home, 'outside.txt'), 'x')
    for (const b of [{ seq: 50, file: 0 }, { seq: 41, file: 1 }, { seq: 99, file: 0 }]) {
      assert.deepEqual(await s.request(OP.file, { channel: 'c_1', ...b, offset: 0 }), { status: RES_STATUS.notFound, body: {} }, JSON.stringify(b))
    }
    assert.equal((await s.request(OP.file, { channel: 'c_1', seq: 41, file: 0, offset: 0, path: 'C:/x' })).status, RES_STATUS.badRequest, 'no path in a body')
    const r = await s.request(OP.say, { channel: 'c_1', text: 'x', files: [0] }, { actId: actId() })
    assert.deepEqual(r, { status: RES_STATUS.notFound, body: { error: 'unknown-file' } })
    const big = await s.request(OP.upload, { channel: 'c_1', act: toHex(actId()), file: 0, name: 'g.bin', size: FILE_MAX_BYTES + 1, offset: 0, data: '' }, { actId: actId() })
    assert.deepEqual(big, { status: RES_STATUS.badRequest, body: { error: 'too-large' } })
    const cancel = await s.request(OP.cancel, { act: toHex(actId()) }, { actId: actId() })
    assert.deepEqual(cancel, { status: RES_STATUS.ok, body: {} })
  })

  test("a device's bytes of files a minute: past it `slow-down`, and the other requests are not counted there", async () => {
    let refused = 0
    for (let i = 0; i < 12; i++) {
      const r = await s.request(OP.file, { channel: 'c_1', seq: 41, file: 0, offset: 0 })
      if (r.status === RES_STATUS.limit) { refused++; assert.deepEqual(r.body, { error: 'slow-down' }) }
    }
    assert.ok(refused >= 2, `refused ${refused}`)
    assert.equal((await s.request(0x0001)).status, RES_STATUS.ok, 'session.info still goes')
  })
})

describe('RR4 B-4: a revocation shuts the door before the sessions are down', () => {
  let hb: HouseBench
  let home = ''
  let staging = ''
  const said: Array<Record<string, unknown>> = []
  const OP = { upload: OP_CODES['channels.upload'], say: OP_CODES['channels.say'] }
  const idOf = (d: { result?: { deviceId: Bytes } }): string => toHex(d.result!.deviceId)
  const mine = (dev: string): string[] => (existsSync(staging) ? readdirSync(staging) : []).filter((f) => f.endsWith(`-${dev.slice(0, 8)}.part`) || f.endsWith(`-${dev.slice(0, 8)}.ready`))

  before(async () => {
    home = benchHome('remoted-files-revoke-')
    homes.push(home)
    await mkdir(join(home, 'channels', 'c_1', 'files'), { recursive: true })
    staging = join(home, 'channels', 'c_1', 'files', UPLOAD_DIR)
    const writes: ExtRequestFn = async (b) => { said.push(structuredClone(b.args)); return { result: { line: { seq: 40 } } } }
    hb = await startHouseBench({
      origin: ORIGIN, reads: pipeReads(async () => ({ result: { lines: [] } })), writes: pipeWrites(writes), files: new PortalFiles({ home, now: Date.now, log: () => {} }),
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000, fileChunksPerDevicePerMin: 1_000, strikesMax: 50 },
    })
    await registerAndUnlock(hb.fresh, hb.device.kD.pub)
  })
  after(async () => { await hb?.stop() })

  test('a speech that arrives once the revocation began (the registry says revoked, its session still up) never reaches tetherd', async () => {
    const s = hb.fresh
    const dev = idOf(hb.device)
    assert.equal((await s.request(OP.say, { channel: 'c_1', text: 'antes' }, { actId: actId() })).status, RES_STATUS.ok)
    const before = said.length
    // Step (1) of spec 6.1 is done and (2) has not come yet: the window B-4 is about.
    const d = hb.registry.get(dev)!
    d.state = 'revoked'
    hb.house.upsertDevice(structuredClone(d))
    const r = s.request(OP.say, { channel: 'c_1', text: 'depois' }, { actId: actId() }).catch(() => undefined)
    await until(() => s.closed, 5_000, 'the session closed by the house')
    assert.equal(s.closed?.code, 0x04, 'closed as revoked')
    assert.equal(said.length, before, 'tetherd got nothing')
    void r
  })

  test('an upload of a revoked device, also with a chunk in flight, leaves no .part nor .ready behind', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await hb.pair(`aparelho ${round}`)
      await registerAndUnlock(p.fresh, p.device.kD.pub)
      const dev = idOf(p.device)
      const big = Buffer.concat([PNG, randomBytes(2 * FILE_CHUNK_BYTES)])
      const act = toHex(actId())
      const chunk = (i: number) => p.fresh.request(OP.upload, {
        channel: 'c_1', act, file: 0, name: 'grande.png', size: big.length, offset: i * FILE_CHUNK_BYTES, data: b64url(big.subarray(i * FILE_CHUNK_BYTES, (i + 1) * FILE_CHUNK_BYTES)),
      }, { actId: actId() })
      assert.equal((await chunk(0)).status, RES_STATUS.ok)
      assert.equal(mine(dev).length, 1, 'the part is on disk')
      // A chunk on its way while the device is revoked (round 0: before, 1: with, 2: just after the chunk is sent).
      const flying = round === 0 ? undefined : chunk(1).catch(() => undefined)
      if (round === 2) await new Promise((r) => setImmediate(r))
      const d = hb.registry.get(dev)!
      d.state = 'revoked'
      await hb.house.revoke(dev, [])
      await flying
      await until(() => mine(dev).length === 0 || undefined, 5_000, `round ${round}: nothing of the revoked device in the staging folder`)
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(mine(dev), [], `round ${round}: still nothing after the dust settles`)
      p.fresh.leg.close()
    }
  })
})
