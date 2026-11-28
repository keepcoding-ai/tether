// Attachments of a speech (slice A1): the pure rules (extensions/channels/attachments.ts: secret names, safe and numbered names,
// limits, sizes, the `anexos:` block), the daemon's copier (daemon/files.ts: checks again, copies under a unique name, takes back
// a half copy, never opens a refused file) and the fan-out with files: the line keeps them, the files are in
// <home>/channels/<id>/files/, the agent gets the text then `anexos:` and one absolute path per line on both roads (inside and
// typed), `channels read` shows the same, and a closed channel takes none. No daemon, no agent: a fake delivery records what it
// was handed. Every folder is a fresh temp home.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  admit, ANEXOS_LINE, ATTACH_MAX_BYTES, ATTACH_MAX_PER_SAY, fileRefusal, isSecretName, kindOf, numberedName, refusalText, roomNote, safeFileName,
  screenshotName, sizeLabel, withFiles,
} from '../../extensions/channels/attachments.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { parseSources, storeFiles, type FilesDisk } from '../../extensions/channels/daemon/files.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { readVerb } from '../../extensions/channels/daemon/verbs/read.ts'
import type { VerbDeps } from '../../extensions/channels/daemon/verbs/common.ts'
import { USER } from '../../extensions/channels/rules.ts'
import type { DeliveryMessage } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

describe('attachments: the pure rules', () => {
  test('secret names are refused by the name alone (the eight patterns), common names pass', () => {
    for (const n of ['.env', '.ENV', '.env.production', '.env.local', 'prod.keys', 'server.pem', 'tls.key', 'cert.pfx', 'id_rsa', 'id_rsa.pub', 'credentials', 'credentials.json', 'C:\\x\\.env'])
      assert.equal(isSecretName(n), true, n)
    for (const n of ['env.txt', 'my.env.md', 'keys.txt', 'keyboard.png', 'pem.ts', 'contrato-v3.pdf', 'Captura de tela 2026-11-24 09.41.07.png', 'id.txt', 'my-credentials.txt'])
      assert.equal(isSecretName(n), false, n)
  })

  test('fileRefusal: gone, folder, secret, too large, in that order; 20 MB exactly passes', () => {
    assert.equal(fileRefusal({ name: 'a.png', size: 1, missing: true }), 'not-found')
    assert.equal(fileRefusal({ name: '.env', size: 1, isDirectory: true }), 'is-folder')
    assert.equal(fileRefusal({ name: '.env', size: ATTACH_MAX_BYTES + 1 }), 'secret-file')
    assert.equal(fileRefusal({ name: 'v.mp4', size: ATTACH_MAX_BYTES + 1 }), 'too-large')
    assert.equal(fileRefusal({ name: 'v.mp4', size: ATTACH_MAX_BYTES }), undefined)
  })

  test('admit: the first ten go in, refused ones apart, `over` counts the ones left out by the count', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i + 1}.txt`, size: 10 }))
    const r = admit(0, [...files.slice(0, 3), { name: '.env', size: 3 }, ...files.slice(3)])
    assert.deepEqual(r.accepted.map((f) => f.name), files.slice(0, 10).map((f) => f.name))
    assert.deepEqual(r.refused.map((x) => [x.file.name, x.why]), [['.env', 'secret-file']])
    assert.equal(r.over, 1)
    assert.equal(r.tried, 11)
    // With 8 already on the speech, 2 more fit.
    const r2 = admit(8, files.slice(0, 5))
    assert.deepEqual([r2.accepted.length, r2.over], [2, 3])
    assert.equal(ATTACH_MAX_PER_SAY, 10)
  })

  test('safe names: no folder, no forbidden character, no device name, no trailing dot, bounded with the extension kept', () => {
    assert.equal(safeFileName('C:\\Users\\p\\a<b>:c|d?.png'), 'a_b__c_d_.png')
    assert.equal(safeFileName('../../etc/passwd'), 'passwd')
    assert.equal(safeFileName('con.txt'), '_con.txt')
    assert.equal(safeFileName('relatorio. . '), 'relatorio')
    assert.equal(safeFileName('...'), 'arquivo')
    assert.equal(safeFileName(''), 'arquivo')
    const long = safeFileName(`${'x'.repeat(300)}.pdf`)
    assert.equal(long.length, 120)
    assert.ok(long.endsWith('.pdf'))
    assert.equal(safeFileName('.gitignore'), '.gitignore')
  })

  test('RR4 M-1: what the Windows shell acts on by itself is made inert, devices by the real rule, no format character', () => {
    // A type the shell resolves on its own (an icon fetched over SMB/WebDAV when the folder is shown) never keeps its type.
    for (const n of ['a.url', 'b.scf', 'c.library-ms', 'd.LNK', 'e.searchConnector-ms', 'f.appref-ms', 'g.website', 'h.theme', 'i.hta', 'j.cpl', 'k.msc', 'l.pif', 'm.themepack', 'n.settingcontent-ms', 'o.url. .'])
      assert.ok(safeFileName(n).endsWith('.download'), n)
    assert.equal(safeFileName('a.url'), 'a.url.download')
    assert.equal(safeFileName('Desktop.INI'), 'Desktop.INI.download')
    assert.equal(safeFileName('autorun.inf'), 'autorun.inf.download')
    assert.equal(safeFileName('fatura.pdf'), 'fatura.pdf')
    // A long dangerous name keeps both its type and the suffix, within the ceiling.
    const long = safeFileName(`${'x'.repeat(116)}.url${'y'.repeat(30)}`)
    assert.ok(long.length <= 120 && !/\.url$/i.test(long), long)
    const longUrl = safeFileName(`${'x'.repeat(300)}.url`)
    assert.ok(longUrl.length <= 120 && longUrl.endsWith('.url.download'), longUrl)
    // Reserved by Windows' own rule: the part before the first dot, trailing spaces gone, superscript digits, the console.
    for (const n of ['con .txt', 'COM¹.txt', 'lpt³', 'CONIN$', 'conout$.log', 'nul.tar.gz', 'AUX', 'com0.x'])
      assert.ok(safeFileName(n).startsWith('_'), n)
    for (const n of ['console.txt', 'com10.txt', 'conin.txt', 'nulo.txt']) assert.equal(safeFileName(n), n)
    // Format characters (RLO, zero width) go, in the app's road too.
    assert.equal(safeFileName('fatura‮fdp.exe'), 'faturafdp.exe')
    assert.equal(safeFileName('a​b.png'), 'ab.png')
    assert.equal(safeFileName('‮'), 'arquivo')
  })

  test('numbered names and the pasted print name', () => {
    assert.equal(numberedName('contrato-v3.pdf', 1), 'contrato-v3.pdf')
    assert.equal(numberedName('contrato-v3.pdf', 2), 'contrato-v3 (2).pdf')
    assert.equal(numberedName('LEIAME', 3), 'LEIAME (3)')
    assert.equal(screenshotName(new Date(2026, 10, 24, 9, 41, 7)), 'Captura de tela 2026-11-24 09.41.07.png')
  })

  test('sizes, kinds, the room note and the refusal texts of the preview', () => {
    assert.deepEqual([sizeLabel(12), sizeLabel(412 * 1024), sizeLabel(2.3 * 1024 * 1024), sizeLabel(148 * 1024 * 1024)], ['12 bytes', '412 KB', '2,3 MB', '148 MB'])
    assert.deepEqual(['a.PNG', 'b.pdf', 'c.ts', 'd.docx'].map(kindOf), ['image', 'pdf', 'code', 'other'])
    assert.equal(roomNote(0), '')
    assert.equal(roomNote(1), 'Todos os membros do canal poderão ler este arquivo.')
    assert.equal(roomNote(3), 'Todos os membros do canal poderão ler estes arquivos. · 3 de 10')
    const big = refusalText('too-large', 'vídeo-reuniao.mp4', { size: 148 * 1024 * 1024 })
    assert.equal(`${big.lead} ${big.rest}`, 'vídeo-reuniao.mp4 não entrou. Tem 148 MB e o limite é 20 MB por arquivo. Envie um trecho menor ou comprima o arquivo.')
    const many = refusalText('too-many', '', { accepted: 10, tried: 14 })
    assert.equal(`${many.lead} ${many.rest}`, 'Entraram 10 de 14 arquivos. O limite é 10 por fala. Envie estes e anexe o resto na fala seguinte.')
    assert.match(refusalText('secret-file', '.env.production').rest, /^Arquivos de variáveis, chaves e certificados não são anexados/)
    assert.equal(refusalText('is-folder', 'docs').rest, 'Pastas não podem ser anexadas. Compacte em .zip e anexe de novo.')
  })

  test('the `anexos:` block: after the text, alone without text, nothing without files', () => {
    const files = [{ path: 'C:\\h\\channels\\c_1\\files\\a.png' }, { path: 'C:\\h\\channels\\c_1\\files\\b.pdf' }]
    assert.equal(withFiles('Veja o print.', files), `Veja o print.\n${ANEXOS_LINE}\nC:\\h\\channels\\c_1\\files\\a.png\nC:\\h\\channels\\c_1\\files\\b.pdf`)
    assert.equal(withFiles('', files.slice(0, 1)), 'anexos:\nC:\\h\\channels\\c_1\\files\\a.png')
    assert.equal(withFiles('texto\n\n', files.slice(0, 1)), 'texto\nanexos:\nC:\\h\\channels\\c_1\\files\\a.png')
    assert.equal(withFiles('só texto', undefined), 'só texto')
    assert.equal(withFiles('só texto', []), 'só texto')
  })

  test('parseSources: a list of { path, name? } with absolute paths, at most ten', () => {
    const abs = resolve('x.png')
    assert.deepEqual(parseSources(undefined), [])
    assert.deepEqual(parseSources([{ path: abs, name: 'Captura.png' }]), [{ path: abs, name: 'Captura.png' }])
    assert.equal(parseSources([{ path: 'relativo.png' }]), 'bad-request')
    assert.equal(parseSources('x'), 'bad-request')
    assert.equal(parseSources(Array.from({ length: 11 }, () => ({ path: abs }))), 'too-many')
  })
})

describe('attachments: the daemon copier', () => {
  let home: string
  before(() => { home = tempHome() })
  after(async () => { await removeHome(home) })

  test('copies under a safe name; a taken name gets (2), (3); the line gets the absolute path, size and type', async () => {
    const src = join(home, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'contrato-v3.pdf'), 'pdf-1')
    const dir = join(home, 'channels', 'c_t', 'files')
    const one = await storeFiles(dir, [{ path: join(src, 'contrato-v3.pdf') }])
    const two = await storeFiles(dir, [{ path: join(src, 'contrato-v3.pdf') }, { path: join(src, 'contrato-v3.pdf'), name: 'contrato-v3.pdf' }])
    assert.ok(one.ok && two.ok)
    assert.deepEqual(one.files, [{ name: 'contrato-v3.pdf', path: resolve(dir, 'contrato-v3.pdf'), size: 5, type: 'application/pdf' }])
    assert.deepEqual(two.files.map((f) => f.name), ['contrato-v3 (2).pdf', 'contrato-v3 (3).pdf'])
    for (const f of [...one.files, ...two.files]) assert.equal(readFileSync(f.path, 'utf8'), 'pdf-1')
    // A pasted print goes by its generated name.
    writeFileSync(join(src, 'staged-123.png'), 'png')
    const shot = await storeFiles(dir, [{ path: join(src, 'staged-123.png'), name: 'Captura de tela 2026-11-24 09.41.07.png' }])
    assert.ok(shot.ok)
    assert.equal(shot.files[0]!.name, 'Captura de tela 2026-11-24 09.41.07.png')
    assert.equal(shot.files[0]!.type, 'image/png')
  })

  test('RR4 M-1: files from afar land inert, never a device nor a format character, and carry the Internet zone (Windows)', async () => {
    const src = join(home, 'src-afar')
    mkdirSync(src, { recursive: true })
    const shortcut = '[InternetShortcut]\r\nURL=https://x\r\nIconFile=\\\\evil.example@SSL\\s\\i.ico\r\nIconIndex=1\r\n'
    const names = ['a.url', 'b.scf', 'c.library-ms', 'desktop.ini', 'con .txt', 'COM¹.txt', 'CONIN$', 'fatura‮fdp.exe']
    const sources = names.map((name, i) => { const p = join(src, `up-${i}.ready`); writeFileSync(p, shortcut); return { path: p, name } })
    const dir = join(home, 'channels', 'c_afar', 'files')
    const r = await storeFiles(dir, sources, undefined, { fromAfar: true })
    assert.ok(r.ok, JSON.stringify(r))
    assert.deepEqual(r.files.map((f) => f.name), [
      'a.url.download', 'b.scf.download', 'c.library-ms.download', 'desktop.ini.download', '_con .txt', '_COM¹.txt', '_CONIN$', 'faturafdp.exe',
    ])
    for (const f of r.files) {
      assert.equal(readFileSync(f.path, 'utf8'), shortcut, `${f.name}: a regular file, not a device`)
      if (process.platform === 'win32') assert.match(readFileSync(`${f.path}:Zone.Identifier`, 'utf8'), /^\[ZoneTransfer\]\r\nZoneId=3\r\n$/, f.name)
    }
    // The app's own copies carry no mark: the person chose them on this machine.
    const own = await storeFiles(dir, [{ path: sources[0]!.path, name: 'nota.txt' }])
    assert.ok(own.ok)
    if (process.platform === 'win32') assert.equal(existsSync(`${own.files[0]!.path}:Zone.Identifier`), false)
  })

  const fakeDisk = (stats: Record<string, { size: number; isFile: boolean; isDirectory: boolean }>, failOn?: string): FilesDisk & { copies: string[]; removed: string[] } => {
    const copies: string[] = []
    const removed: string[] = []
    return {
      copies, removed,
      stat: async (p) => stats[p],
      mkdirp: async () => {},
      copyNew: async (from, to) => { if (from === failOn) throw new Error('disk full'); copies.push(to); return true },
      rm: async (p) => { removed.push(p) },
    }
  }

  test('refusals come before any copy: a secret by its name (the source or the name given), a folder, too large, gone', async () => {
    const big = resolve('/tmp-a/video.mp4')
    const env = resolve('/tmp-a/.env.production')
    const plain = resolve('/tmp-a/ok.txt')
    const folder = resolve('/tmp-a/docs')
    const disk = fakeDisk({
      [big]: { size: ATTACH_MAX_BYTES + 1, isFile: true, isDirectory: false },
      [env]: { size: 10, isFile: true, isDirectory: false },
      [plain]: { size: 10, isFile: true, isDirectory: false },
      [folder]: { size: 0, isFile: false, isDirectory: true },
    })
    assert.deepEqual(await storeFiles('D:/x', [{ path: plain }, { path: env }], disk), { ok: false, error: 'secret-file', file: '.env.production' })
    assert.deepEqual(await storeFiles('D:/x', [{ path: env, name: 'inocente.txt' }], disk), { ok: false, error: 'secret-file', file: 'inocente.txt' })
    assert.deepEqual(await storeFiles('D:/x', [{ path: plain, name: 'id_rsa' }], disk), { ok: false, error: 'secret-file', file: 'id_rsa' })
    assert.deepEqual(await storeFiles('D:/x', [{ path: big }], disk), { ok: false, error: 'too-large', file: 'video.mp4' })
    assert.deepEqual(await storeFiles('D:/x', [{ path: folder }], disk), { ok: false, error: 'is-folder', file: 'docs' })
    assert.deepEqual(await storeFiles('D:/x', [{ path: resolve('/tmp-a/sumiu.png') }], disk), { ok: false, error: 'not-found', file: 'sumiu.png' })
    assert.deepEqual(disk.copies, [], 'nothing was copied: a refused speech copies none of its files')
  })

  test('a copy that fails takes back the ones already made', async () => {
    const a = resolve('/tmp-b/a.txt')
    const b = resolve('/tmp-b/b.txt')
    const disk = fakeDisk({ [a]: { size: 1, isFile: true, isDirectory: false }, [b]: { size: 1, isFile: true, isDirectory: false } }, b)
    const r = await storeFiles(resolve('/tmp-b/files'), [{ path: a }, { path: b }], disk)
    assert.deepEqual(r, { ok: false, error: 'copy-failed', file: 'b.txt' })
    assert.deepEqual(disk.removed, disk.copies)
  })
})

describe('attachments: the fan-out and the two roads', () => {
  let home: string
  let ch: Channels
  const delivered: Array<{ agent: string; msg: DeliveryMessage }> = []
  const IN = 'aaaa0001'
  const OUT = 'bbbb0002'
  const routes: Record<string, 'inside' | 'terminal'> = { [IN]: 'inside', [OUT]: 'terminal' }
  const slots: Record<string, unknown> = {
    [IN]: { slotId: IN, kind: 'claude', status: 'running', name: 'dentro', cwd: 'C:/x' },
    [OUT]: { slotId: OUT, kind: 'claude', status: 'running', name: 'fora', cwd: 'C:/x' },
  }
  const none = { dispose: () => {} }

  before(async () => {
    home = tempHome()
    const api = {
      slots: { get: (id: string) => slots[id], onState: () => none, userTypedAt: () => undefined },
      delivery: {
        deliver: async (agent: string, msg: DeliveryMessage) => {
          delivered.push({ agent, msg })
          return { id: `r${delivered.length}`, slotId: agent, state: routes[agent] === 'inside' ? 'inside' : 'typed', at: new Date().toISOString() }
        },
        pending: () => [], cancel: () => false, routeOf: (id: string) => routes[id] ?? 'wait', hasTools: () => false, onDidDeliver: () => none,
      },
      attention: { seen: () => {} },
      events: { emit: () => {} },
      settings: { get: () => undefined },
      log: () => {},
    } as unknown as ChannelsApi
    ch = createChannels(api, await openStore(fsIo, home))
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  test('a speech with files: copied into files/, kept on the line, and `anexos:` with the absolute paths on both roads and in read', async () => {
    const made = await ch.create(USER, { name: 'obra' })
    assert.ok(made.ok)
    const id = made.channel.id
    for (const a of [IN, OUT]) assert.ok((await ch.join(USER, id, a)).ok)
    const src = join(home, 'fora-do-canal')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'print.png'), 'png-bytes')
    writeFileSync(join(src, 'contrato-v3.pdf'), 'pdf')
    delivered.length = 0
    const r = await ch.say(USER, id, { body: 'Veja o erro do print.', files: [{ path: join(src, 'print.png'), name: 'Captura de tela 2026-11-24 09.41.07.png' }, { path: join(src, 'contrato-v3.pdf') }] })
    assert.ok(r.ok, JSON.stringify(r))
    const dir = resolve(home, 'channels', id, 'files')
    const paths = [join(dir, 'Captura de tela 2026-11-24 09.41.07.png'), join(dir, 'contrato-v3.pdf')]
    assert.deepEqual(r.line.files, [
      { name: 'Captura de tela 2026-11-24 09.41.07.png', path: paths[0], size: 9, type: 'image/png' },
      { name: 'contrato-v3.pdf', path: paths[1], size: 3, type: 'application/pdf' },
    ])
    assert.ok(paths.every((p) => existsSync(p)))
    assert.equal(r.line.body, 'Veja o erro do print.')
    const block = `anexos:\n${paths.join('\n')}`
    const inside = delivered.find((d) => d.agent === IN)!.msg
    const typed = delivered.find((d) => d.agent === OUT)!.msg
    assert.equal(inside.body, `Veja o erro do print.\n${block}`)
    assert.ok(typed.body.startsWith(`Veja o erro do print.\n${block}\n(para responder no canal:`), typed.body)

    // Files with no text: the block alone (inside), the block and the hint (typed).
    delivered.length = 0
    const only = await ch.say(USER, id, { body: '', files: [{ path: join(src, 'contrato-v3.pdf') }] })
    assert.ok(only.ok)
    const second = join(dir, 'contrato-v3 (2).pdf')
    assert.equal(delivered.find((d) => d.agent === IN)!.msg.body, `anexos:\n${second}`)
    assert.ok(delivered.find((d) => d.agent === OUT)!.msg.body.startsWith(`anexos:\n${second}\n(para responder`))

    // `channels read` shows the same block under each speech.
    const deps = { channels: ch, api: {} } as unknown as VerbDeps
    const read = await readVerb.run(deps, { slotId: IN } as never, { canal: 'obra' })
    assert.ok(read.text.includes(`${r.line.seq} ${ch.nameOf(USER)}: Veja o erro do print.\n${block}`), read.text)
    assert.ok(read.text.includes(`${only.line.seq} ${ch.nameOf(USER)}:\nanexos:\n${second}`), read.text)
    const lines = (read.data as { lines: Array<{ seq: number; files?: unknown[] }> }).lines
    assert.equal(lines.find((l) => l.seq === r.line.seq)!.files!.length, 2)
  })

  test('the daemon refuses again: a secret by name, an empty speech; a closed channel takes no file', async () => {
    const made = await ch.create(USER, { name: 'recusas' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, IN)).ok)
    const src = join(home, 'src2')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, '.env'), 'SEGREDO=nao-lido')
    writeFileSync(join(src, 'ok.txt'), 'ok')
    const secret = await ch.say(USER, id, { body: 'x', files: [{ path: join(src, 'ok.txt') }, { path: join(src, '.env') }] })
    assert.deepEqual(secret, { ok: false, error: 'secret-file', file: '.env' })
    assert.equal(existsSync(resolve(home, 'channels', id, 'files', 'ok.txt')), false, 'a refused speech copies nothing')
    assert.deepEqual(await ch.say(USER, id, { body: '  ' }), { ok: false, error: 'bad-request' })
    assert.ok((await ch.close(USER, id)).ok)
    assert.deepEqual(await ch.say(USER, id, { body: '', files: [{ path: join(src, 'ok.txt') }] }), { ok: false, error: 'closed' })
  })
})
