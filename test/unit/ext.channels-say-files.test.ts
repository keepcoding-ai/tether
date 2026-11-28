// An agent attaches files and the conversation sees them (slice A2). The `say` verb (the MCP tool and the CLI are this one verb)
// passes the paths through the SAME check and copy as the person's: copied into <home>/channels/<id>/files/, refused with the
// reason (a secret's name, a folder, too many, gone), a relative path is the agent's own folder's, files alone are a speech, a
// closed channel takes none; and the view of a speech's files: an image is a thumbnail, any other file a card, in order.
// No daemon, no LLM: a fake delivery records what the members were handed. Every folder is a fresh temp home.
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ATTACH_MAX_PER_SAY } from '../../extensions/channels/attachments.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { REMOTE_UPLOAD_DIR } from '../../extensions/channels/daemon/files.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { UPLOAD_DIR } from '../../src/remoted/files.ts'
import type { VerbDeps } from '../../extensions/channels/daemon/verbs/common.ts'
import { sayVerb } from '../../extensions/channels/daemon/verbs/say.ts'
import { INSTRUCTIONS, FILES_TEXT } from '../../extensions/channels/daemon/verbs.ts'
import { rowsOf, viewFile } from '../../extensions/channels/renderer/view-model.ts'
import { USER, type Line } from '../../extensions/channels/rules.ts'
import type { DeliveryMessage } from '../../src/daemon/door/types.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

describe('say with files: the agent road', () => {
  let home: string
  let src: string
  let ch: Channels
  let deps: VerbDeps
  const delivered: Array<{ agent: string; msg: DeliveryMessage }> = []
  const A = 'aaaa0001'
  const B = 'bbbb0002'
  const none = { dispose: () => {} }

  before(async () => {
    home = tempHome()
    src = join(home, 'pasta-do-agente')
    mkdirSync(src, { recursive: true })
    const slots: Record<string, unknown> = {
      [A]: { slotId: A, kind: 'claude', status: 'running', name: 'quem-anexa', cwd: src },
      [B]: { slotId: B, kind: 'claude', status: 'running', name: 'quem-ouve', cwd: src },
    }
    const api = {
      slots: { get: (id: string) => slots[id], onState: () => none, userTypedAt: () => undefined },
      delivery: {
        deliver: async (agent: string, msg: DeliveryMessage) => {
          delivered.push({ agent, msg })
          return { id: `r${delivered.length}`, slotId: agent, state: 'inside', at: new Date().toISOString() }
        },
        pending: () => [], cancel: () => false, routeOf: () => 'inside', hasTools: () => false, onDidDeliver: () => none,
      },
      attention: { seen: () => {} },
      events: { emit: () => {} },
      settings: { get: () => undefined },
      log: () => {},
    } as unknown as ChannelsApi
    ch = createChannels(api, await openStore(fsIo, home))
    deps = { channels: ch, api: { slots: (api as unknown as { slots: unknown }).slots } } as unknown as VerbDeps
    writeFileSync(join(src, 'grafico.png'), 'png-bytes')
    writeFileSync(join(src, 'relatorio.pdf'), 'pdf-bytes')
    writeFileSync(join(src, '.env'), 'SEGREDO=nao-lido')
    mkdirSync(join(src, 'subpasta'))
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  const say = (canal: string, args: Record<string, unknown>) => sayVerb.run(deps, { slotId: A } as never, { canal, ...args })
  const errorOf = async (canal: string, args: Record<string, unknown>) => {
    const r = await say(canal, args).catch((e: Error & { code?: string }) => ({ thrown: e }))
    return (r as { thrown: Error & { code?: string } }).thrown
  }

  test('an agent attaches by path: copied into the channel, the others hear `anexos:`, a relative path is its own folder\'s', async () => {
    const made = await ch.create(USER, { name: 'anexos' })
    assert.ok(made.ok)
    const id = made.channel.id
    for (const a of [A, B]) assert.ok((await ch.join(USER, id, a)).ok)
    delivered.length = 0
    const r = await say(id, { text: 'Segue o gráfico e o relatório.', files: [join(src, 'grafico.png'), 'relatorio.pdf'] })
    assert.equal(r.isError, undefined, r.text)
    const dir = resolve(home, 'channels', id, 'files')
    const paths = [join(dir, 'grafico.png'), join(dir, 'relatorio.pdf')]
    assert.ok(paths.every(p => existsSync(p)))
    assert.deepEqual((r.data as { files: string[] }).files, paths)
    const heard = delivered.find(d => d.agent === B)!.msg.body
    assert.ok(heard.startsWith(`Segue o gráfico e o relatório.\nanexos:\n${paths.join('\n')}`), heard)
    assert.equal(delivered.some(d => d.agent === A), false, 'the speaker does not hear itself')

    // Files alone are a speech.
    const only = await say(id, { files: [join(src, 'grafico.png')] })
    assert.equal(only.isError, undefined, only.text)
    assert.ok(existsSync(join(dir, 'grafico (2).png')))
  })

  test('the refusals are the person\'s, said with the file and the reason; a speech refused copies nothing', async () => {
    const made = await ch.create(USER, { name: 'recusas-do-agente' })
    assert.ok(made.ok)
    const id = made.channel.id
    assert.ok((await ch.join(USER, id, A)).ok)
    const dir = resolve(home, 'channels', id, 'files')
    const secret = await errorOf(id, { text: 'x', files: [join(src, 'relatorio.pdf'), join(src, '.env')] })
    assert.equal(secret.code, 'secret-file')
    assert.ok(secret.message.includes('.env'), secret.message)
    assert.equal(existsSync(join(dir, 'relatorio.pdf')), false)
    const folder = await errorOf(id, { text: 'x', files: [join(src, 'subpasta')] })
    assert.equal(folder.code, 'is-folder')
    const gone = await errorOf(id, { text: 'x', files: [join(src, 'nao-existe.txt')] })
    assert.equal(gone.code, 'not-found')
    const many = await errorOf(id, { text: 'x', files: Array.from({ length: ATTACH_MAX_PER_SAY + 1 }, () => join(src, 'grafico.png')) })
    assert.equal(many.code, 'too-many')
    const empty = await errorOf(id, {})
    assert.equal(empty.code, 'bad-request')
    // A closed channel takes none, and says it is closed.
    assert.ok((await ch.close(USER, id)).ok)
    const closed = await errorOf(id, { text: 'x', files: [join(src, 'grafico.png')] })
    assert.equal(closed.code, 'closed')
  })

  test('the verb offers `files`, the instructions say how to attach and where the arrivals are', () => {
    const props = (sayVerb.input as { properties: Record<string, unknown>; required: string[] }).properties
    assert.ok('files' in props)
    assert.deepEqual((sayVerb.input as { required: string[] }).required, ['canal'])
    assert.ok(INSTRUCTIONS.includes(FILES_TEXT) && FILES_TEXT.includes('anexos:'))
  })
})

describe('say with files from afar (RR4 B-1, M-1): only the portal\'s uploads for this channel', () => {
  let home: string
  let ch: Channels
  const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>()
  const none = { dispose: () => {} }
  const READY = `${'a'.repeat(32)}-0-${'b'.repeat(8)}.ready`

  before(async () => {
    home = tempHome()
    const api = {
      slots: { get: () => undefined, onState: () => none, userTypedAt: () => undefined },
      delivery: { deliver: async () => ({ id: 'r', slotId: 'x', state: 'inside', at: '' }), pending: () => [], cancel: () => false, routeOf: () => 'inside', hasTools: () => false, onDidDeliver: () => none },
      attention: { seen: () => {} }, events: { emit: () => {} }, settings: { get: () => undefined }, log: () => {},
    } as unknown as ChannelsApi
    ch = createChannels(api, await openStore(fsIo, home))
    const reqApi = { requests: { handle: (name: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, fn); return none } } }
    registerChannelRequests(reqApi as never, Promise.resolve(ch), 1)
  })
  after(async () => { ch?.dispose(); await removeHome(home) })

  const staged = (id: string, name: string, body = 'x'): string => {
    const dir = join(home, 'channels', id, 'files', REMOTE_UPLOAD_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
    return join(dir, name)
  }
  const sayAs = (client: string, channel: string, files: Array<{ path: string; name?: string }>) => handlers.get('say')!({ channel, text: 'segue', files }, { client })
  const badRequest = (e: unknown): boolean => (e as { code?: string }).code === 'bad-request'

  test('a remote say that names any other path is refused bad-request and copies nothing; the app keeps free paths', async () => {
    assert.equal(REMOTE_UPLOAD_DIR, UPLOAD_DIR, "the portal's staging folder")
    const a = await ch.create(USER, { name: 'longe-a' })
    const b = await ch.create(USER, { name: 'longe-b' })
    assert.ok(a.ok && b.ok)
    const key = join(home, 'remote', 'house.key')
    mkdirSync(join(home, 'remote'), { recursive: true })
    writeFileSync(key, 'isca-nao-e-chave')
    const loose = join(home, 'channels', a.channel.id, 'files', REMOTE_UPLOAD_DIR, 'livre.txt')
    staged(a.channel.id, 'livre.txt')
    const other = staged(b.channel.id, READY)
    const sneaky = join(home, 'channels', a.channel.id, 'files', REMOTE_UPLOAD_DIR, '..', '..', '..', '..', 'remote', 'house.key')
    const linked = join(home, 'channels', a.channel.id, 'files', REMOTE_UPLOAD_DIR, `${'c'.repeat(32)}-1-${'d'.repeat(8)}.ready`)
    linkSync(key, linked)
    for (const path of [key, loose, other, sneaky, linked])
      await assert.rejects(sayAs('remote', a.channel.id, [{ path, name: 'foto.png' }]), badRequest, path)
    const filesOf = (id: string) => readdirSync(join(home, 'channels', id, 'files')).filter((f) => f !== REMOTE_UPLOAD_DIR)
    assert.deepEqual(filesOf(a.channel.id), [], 'nothing copied into the channel')
    // The app is the person on this machine: her paths stay free.
    const said = await sayAs('app', a.channel.id, [{ path: loose, name: 'livre.txt' }]) as { line: Line }
    assert.equal(said.line.files?.[0]?.name, 'livre.txt')
  })

  test('a remote say with its own channel\'s upload copies it under the inert name, with the Internet zone on Windows', async () => {
    const a = await ch.create(USER, { name: 'longe-c' })
    assert.ok(a.ok)
    const up = staged(a.channel.id, READY, '[InternetShortcut]\r\nURL=https://x\r\n')
    const said = await sayAs('remote', a.channel.id, [{ path: up, name: 'leia-isto.url' }]) as { line: Line }
    const f = said.line.files![0]!
    assert.equal(f.name, 'leia-isto.url.download')
    assert.equal(f.path, join(home, 'channels', a.channel.id, 'files', 'leia-isto.url.download'))
    if (process.platform === 'win32') assert.match(readFileSync(`${f.path}:Zone.Identifier`, 'utf8'), /ZoneId=3/)
  })
})

describe('the view of a speech\'s files', () => {
  const line = (files: Line['files']): Line => ({
    seq: 1, at: '2026-11-24T12:00:00.000Z', kind: 'message', from: { id: USER, name: 'Você', role: 'moderator' }, body: 'olhe', ...(files ? { files } : {}),
  } as Line)

  test('each file keeps its order, path and size, with its kind and the label of the card', () => {
    const rows = rowsOf([line([
      { name: 'print.png', path: 'C:/h/channels/c/files/print.png', size: 412 * 1024, type: 'image/png' },
      { name: 'contrato-v3.pdf', path: 'C:/h/channels/c/files/contrato-v3.pdf', size: 2.3 * 1024 * 1024, type: 'application/pdf' },
      { name: 'api.ts', path: 'C:/h/channels/c/files/api.ts', size: 18 * 1024, type: 'text/plain' },
      { name: 'dados.bin', path: 'C:/h/channels/c/files/dados.bin', size: 5, type: 'application/octet-stream' },
    ])])
    const say = rows.find(r => r.kind === 'say')
    assert.ok(say && say.kind === 'say')
    assert.deepEqual(say.files!.map(f => [f.name, f.kind, f.label]), [
      ['print.png', 'image', 'Imagem · 412 KB'],
      ['contrato-v3.pdf', 'pdf', 'PDF · 2,3 MB'],
      ['api.ts', 'code', 'Código · 18 KB'],
      ['dados.bin', 'other', 'Arquivo · 5 bytes'],
    ])
    assert.equal(say.files![0]!.path, 'C:/h/channels/c/files/print.png')
    assert.equal(viewFile({ name: 'a.PNG', path: 'p', size: 1, type: 'image/png' }).kind, 'image')
  })

  test('a speech without files has none', () => {
    const say = rowsOf([line(undefined)]).find(r => r.kind === 'say')
    assert.ok(say && say.kind === 'say' && say.files === undefined)
  })
})
