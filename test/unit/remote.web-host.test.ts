// The remote hosts of the Regency's shared screen (remote/web/src/host.ts): what the device holds of the house, the model it
// runs on the published tree, the channel's pages as the view asks for them, and that nothing here acts on the house.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { HistoryPage, MembersAnswer } from '../../extensions/channels/renderer/view-model.ts'
import { fakeHouse } from '../../remote/web/bench/page/fake.ts'
import {
  RemoteHouse, emblemOf, remoteChannelHost, remoteRegencyHost, sealSays, type PageAnswer, type PageLine, type RemoteNotice, type RemoteSource,
} from '../../remote/web/src/host.ts'

const tick = (): Promise<void> => new Promise(done => setTimeout(done, 0))
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await tick() }

const parts = { mount: () => undefined, quick: { open: () => {}, toggle: () => {}, shown: () => undefined, close: () => {} }, visible: () => true }

describe('the house as the device holds it', () => {
  test('reads the tree and the marks at start, and the model runs here on the published entry', async () => {
    const house = new RemoteHouse(fakeHouse())
    const host = remoteRegencyHost(house, parts)
    assert.equal(host.loading(), true)
    house.start()
    await settle()
    assert.equal(host.loading(), false)
    assert.equal(house.live, true)
    const { model, counts } = host.view({ collapsed: [], filter: 'all', query: '' })
    assert.deepEqual(model.tree.map(d => d.name), ['Obra', 'Migração', 'Pesquisa'])
    assert.deepEqual(model.waiting.map(w => w.label), ['revisor', '#extra'])
    assert.equal(counts.waiting, 1)
    assert.equal(counts.asleep, 2)
    // The device's own screen state narrows the model; the house's entry is the same.
    const narrowed = host.view({ collapsed: ['desk-obra'], filter: 'waiting', query: '' }).model
    assert.deepEqual(narrowed.tree.flatMap(d => d.panes.map(p => p.title)), ['revisor'])
  })

  test('the marks the house counts now go over the ones the app last published', async () => {
    const house = new RemoteHouse(fakeHouse())
    house.start()
    await settle()
    const marks = house.input().channelMarks
    assert.deepEqual(marks.extra, { unread: 1, toMe: 1, asks: 0, owed: 0, first: { why: 'to-you', text: 'bancada: Qual das duas telas de filtro fica?' } })
    assert.equal(marks.migra?.unread, 4)
  })

  test('the app closed on the machine: the tree is the last published, with when', async () => {
    const now = (): number => 1_800_000_000_000
    const house = new RemoteHouse(fakeHouse({ appClosed: true, now }))
    house.start()
    await settle()
    assert.equal(house.loaded, true)
    assert.equal(house.live, false)
    assert.equal(house.asOf, now() - 8 * 60_000)
  })

  test('a thin notice reads again: the tree for `regency`, the marks and the open channel for `channels`', async () => {
    const src = fakeHouse()
    const asked = { tree: 0, marks: 0 }
    const counting: RemoteSource = { ...src, tree: () => { asked.tree++; return src.tree() }, marks: () => { asked.marks++; return src.marks() } }
    const house = new RemoteHouse(counting)
    const stale: string[] = []
    let changes = 0
    house.onDidChange(() => { changes++ })
    house.onStale(id => stale.push(id))
    house.start()
    await settle()
    assert.deepEqual(asked, { tree: 1, marks: 1 })
    const before = changes
    src.notify({ what: 'regency' })
    await settle()
    assert.deepEqual(asked, { tree: 2, marks: 1 })
    src.notify({ what: 'channels', channels: ['obra'] })
    await settle()
    assert.deepEqual(asked, { tree: 2, marks: 2 })
    assert.deepEqual(stale, ['obra'])
    assert.ok(changes > before)
    // `all`: every channel with a view open is read again.
    house.openViews.add('migra')
    src.notify({ what: 'channels', channels: [], all: true })
    await settle()
    assert.deepEqual(stale, ['obra', 'migra'])
    house.dispose()
    src.notify({ what: 'regency' })
    await settle()
    assert.equal(asked.tree, 2, 'a disposed house hears nothing')
  })

  test('a reading that fails keeps what was read', async () => {
    const src = fakeHouse()
    let fail = false
    const house = new RemoteHouse({ ...src, tree: () => (fail ? Promise.reject(new Error('cut')) : src.tree()) })
    house.start()
    await settle()
    fail = true
    src.notify({ what: 'regency' })
    await settle()
    assert.equal(house.failed, true)
    assert.equal(house.loaded, true)
    assert.equal(house.input().desks.desks.length, 3)
  })
})

describe('the channel view over the house', () => {
  const hostOf = (source: RemoteSource): { house: RemoteHouse; host: ReturnType<typeof remoteChannelHost>; quick: string[] } => {
    const house = new RemoteHouse(source)
    const quick: string[] = []
    return { house, host: remoteChannelHost(house, { quick: id => quick.push(id) }), quick }
  }

  test('`history` is the page of the contract as the view reads it; a file is a name, never a path', async () => {
    const { house, host } = hostOf(fakeHouse())
    house.start()
    await settle()
    const page = await host.request<HistoryPage>('history', { channel: 'obra', limit: 50 })
    assert.equal(page.last, 8)
    assert.equal(page.more, false)
    assert.deepEqual(page.lines.map(l => l.seq), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(page.channel.name, 'obra')
    assert.equal(page.reactions?.[0]?.seq, 3)
    assert.match(page.lines[6]!.body, /<script>alert\(1\)<\/script>/, 'the text is carried as it is: the view writes it as text')
  })

  test('an answer the house cut by size is completed with the cursor it gave', async () => {
    const line = (seq: number): PageLine => ({ seq, at: new Date(seq * 1000).toISOString(), kind: 'message', from: { id: 'a', name: 'a', role: 'member' }, body: `fala ${seq}` })
    const all = Array.from({ length: 120 }, (_, i) => line(i + 1))
    const asked: Array<number | undefined> = []
    const source: RemoteSource = {
      tree: () => fakeHouse().tree(),
      marks: async () => ({ channels: [], more: 0, moderator: { name: '' } }),
      // The house gives at most 20 lines per answer here (as if the page were too big), with the cursor of what is left.
      page: async (_channel, before): Promise<PageAnswer> => {
        asked.push(before)
        const upTo = before === undefined ? all : all.filter(l => l.seq < before)
        const lines = upTo.slice(-20)
        const first = lines[0]!.seq
        return { channel: { id: 'c', name: 'c', title: 'c' }, lines, reactions: [], polls: [], last: 120, members: [], moderator: { name: '' }, ...(first > 1 ? { before: first } : {}) }
      },
      onNotice: () => ({ dispose: () => {} }),
    }
    const { host } = hostOf(source)
    const newest = await host.request<HistoryPage>('history', { channel: 'c', limit: 50 })
    assert.deepEqual(asked, [undefined, 101, 81])
    assert.equal(newest.lines.length, 60)
    assert.equal(newest.lines[0]!.seq, 61)
    assert.equal(newest.more, true)
    // The view's older page: the lines before its cursor, whole too.
    asked.length = 0
    const older = await host.request<HistoryPage>('history', { channel: 'c', before: 71, limit: 50 })
    assert.equal(older.lines[older.lines.length - 1]!.seq, 70)
    assert.ok(older.lines[0]!.seq <= 21)
    assert.deepEqual(asked.slice(0, 3), [71, 51, 31])
  })

  test('`members`: who is in the channel now, as its page says; the lines and the members of a mount share one reading', async () => {
    const src = fakeHouse()
    const pages: string[] = []
    const counted: RemoteSource = { ...src, page: (c, b) => { pages.push(`${c}:${b ?? ''}`); return src.page(c, b) } }
    const { house, host } = hostOf(counted)
    house.start()
    await settle()
    // A channel never read: its page is read for it.
    const a = await host.request<MembersAnswer>('members', { channel: 'migra' })
    assert.deepEqual(a.members.map(m => [m.name, m.muted]), [['migra', false], ['revisor', true]])
    assert.equal(a.channel.id, 'migra')
    assert.deepEqual(pages, ['migra:'])
    // Read again: what the last page said, nothing asked.
    await host.request<MembersAnswer>('members', { channel: 'migra' })
    assert.deepEqual(pages, ['migra:'])
    // The view's mount asks the lines and the members together: one page.
    pages.length = 0
    const [, b] = await Promise.all([host.request<HistoryPage>('history', { channel: 'obra' }), host.request<MembersAnswer>('members', { channel: 'obra' })])
    assert.deepEqual(b.members.map(m => m.name), ['conferente', 'bancada'])
    assert.deepEqual(pages, ['obra:'])
  })

  test('"para você" is by the person\'s name as the house says it; an old house leaves the default', async () => {
    const { house, host } = hostOf(fakeHouse())
    assert.equal(host.moderatorName(), undefined)
    house.start()
    await settle()
    assert.equal(host.moderatorName(), 'usuário')
    const src = fakeHouse()
    const old = hostOf({ ...src, marks: async () => ({ ...(await src.marks()), moderator: { name: '' } }), page: async (c, b) => ({ ...(await src.page(c, b)), moderator: { name: '' } }) })
    old.house.start()
    await settle()
    await old.host.request<HistoryPage>('history', { channel: 'obra' })
    assert.equal(old.host.moderatorName(), undefined)
  })

  test('reading only: every other request is refused, seeing marks nothing, an agent\'s name opens the reading card', async () => {
    const { house, host, quick } = hostOf(fakeHouse())
    house.start()
    await settle()
    assert.equal(host.readOnly, true)
    for (const name of ['say', 'react', 'vote', 'poll', 'seen', 'close']) await assert.rejects(host.request(name, { channel: 'obra' }))
    await assert.rejects(host.ask({ title: 't', message: 'm', choices: [] } as never))
    assert.equal(await host.run('channels.close', { channel: 'obra' }), undefined)
    host.marks.viewed('extra', 99)
    host.marks.attended('extra', 3)
    assert.deepEqual(host.marks.of('extra'), { unread: 1, toMe: 1, seen: 2, firstToMe: 3 })
    assert.deepEqual(host.marks.of('nope'), { unread: 0, toMe: 0, seen: 0 })
    assert.deepEqual(host.marks.asksOf('extra'), [])
    host.peek('p6')
    assert.deepEqual(quick, ['p6'])
    assert.deepEqual(host.agent('p1'), { kind: 'claude' })
    assert.equal(host.agent('nobody'), undefined)
    assert.deepEqual(await host.files.look(['a.png']), [{ path: 'a.png', missing: false }])
    assert.equal(host.files.pathOf(undefined as never), '')
  })

  test('the `stale` event of the view is the house\'s thin notice', async () => {
    const src = fakeHouse()
    const { house, host } = hostOf(src)
    const heard: string[] = []
    const sub = host.onEvent<{ channelId: string }>('stale', ev => heard.push(ev.channelId))
    // The four events of the app's daemon never come from afar.
    for (const name of ['line', 'channel', 'reaction', 'poll']) host.onEvent(name, () => assert.fail(`${name} must not come`))
    house.start()
    await settle()
    src.notify({ what: 'channels', channels: ['extra'] } satisfies RemoteNotice)
    await settle()
    assert.deepEqual(heard, ['extra'])
    sub.dispose()
    src.notify({ what: 'channels', channels: ['extra'] })
    await settle()
    assert.deepEqual(heard, ['extra'])
  })
})

describe('the Regency\'s host over the house', () => {
  test('reading only: the acts ask nothing of the house; a pane or an agent shows its card', async () => {
    const house = new RemoteHouse(fakeHouse())
    const opened: string[] = []
    const host = remoteRegencyHost(house, { ...parts, quick: { ...parts.quick, open: t => opened.push(`${t.kind}:${t.id}`) } })
    house.start()
    await settle()
    assert.equal(host.readOnly, true)
    host.go({ kind: 'pane', id: 'p6' })
    host.go({ kind: 'desk', id: 'desk-obra' })
    host.talk({ kind: 'agent', id: 'p1' })
    assert.deepEqual(opened, ['pane:p6', 'agent:p1'])
    let restored = 0
    host.create({}, () => { restored++ })
    assert.equal(restored, 1, '"+ Novo" opens nothing and gives the keyboard back')
    assert.deepEqual(host.lines('p6'), ['Esperando você', 'Pergunta se aplica a migração 0042'])
    assert.equal(sealSays(host.lines('p6')), 'Pergunta se aplica a migração 0042', 'the core\'s "waiting" is not what it does')
    assert.equal(host.lines('p5'), undefined, 'no line, no seal')
    assert.deepEqual(host.identity('p1'), { kind: 'claude', name: 'conferente', seed: 'p1', emblem: undefined })
    assert.equal(host.identity('p4'), undefined)
    assert.equal(await host.pickChannel(), 'extra', 'the channel that calls the person first')
    assert.deepEqual(host.openChannels().map(c => c.id), ['obra', 'extra', 'migra'])
    assert.equal(host.system.model().dot.show, false)
    assert.deepEqual(await host.system.proc('stop', 'x'), { refusal: 'Daqui você só acompanha.' })
  })

  test('the seal says nothing once the app closed; an agent\'s channels are the marks that name it', async () => {
    const house = new RemoteHouse(fakeHouse({ appClosed: true }))
    const host = remoteRegencyHost(house, parts)
    house.start()
    await settle()
    assert.equal(host.lines('p6'), undefined, 'a closed app\'s tree says what the agent WAS doing')
    assert.deepEqual(house.channelsOf('p2').map(c => c.channel), ['obra', 'extra'])
    assert.deepEqual(house.channelsOf('p6').map(c => c.channel), ['migra'])
    assert.deepEqual(house.channelsOf('p4'), [])
    assert.equal(sealSays(['Esperando você']), undefined)
    assert.equal(sealSays(undefined), undefined)
  })

  test('an emblem whose colour is not one of the 12 hues is not an emblem', () => {
    assert.deepEqual(emblemOf({ id: 'a', kind: 'claude', name: 'a', emblem: { name: 'Rev', color: 'purple', icon: 'wrench' } }), { name: 'Rev', color: 'purple', icon: 'wrench' })
    assert.equal(emblemOf({ id: 'a', kind: 'claude', name: 'a', emblem: { name: 'x', color: 'red;background:url(x)', icon: 'wrench' } }), undefined)
    assert.equal(emblemOf({ id: 'a', kind: 'claude', name: 'a' }), undefined)
    assert.equal(emblemOf(undefined), undefined)
  })
})
