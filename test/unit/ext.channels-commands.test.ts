// The channel commands' pure parts (U2): the manifest's commands, the argument, the picker's rows (the desk's channel featured, the
// members' count), the join's and the member gestures' second step, and the words of the confirmations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CMD, manifest } from '../../extensions/channels/manifest.ts'
import { argOf } from '../../extensions/channels/renderer/commands.ts'
import type { ChannelSummary, MemberInfo } from '../../extensions/channels/daemon/requests.ts'
import type { MembersAnswer } from '../../extensions/channels/renderer/view-model.ts'
import {
  channelDetail, channelItem, channelMenu, channelPick, closeDialog, createRow, failedDialog, findChannel, inScope, joinItems, memberItems, memberMenu, muteDialog, PICK, removeDialog,
  type AgentChoice,
} from '../../extensions/channels/renderer/texts.ts'

const sum = (over: Partial<ChannelSummary> & { id: string; name: string }): ChannelSummary => ({
  title: over.name, owner: { kind: 'user' }, members: 2, seenByUser: 0, createdAt: '2026-11-23T10:00:00Z', ...over,
})
const OBRA = sum({ id: 'desk_desk-1', name: 'obra', desk: 'desk-1', owner: { kind: 'agent', id: 'a1', name: 'Atrium' }, members: 3 })
const CONF = sum({ id: 'c2', name: 'conferencia', members: 4 })
const OLD = sum({ id: 'c3', name: 'revisao', closed: { at: '2026-11-22T10:00:00Z', by: 'user' } as ChannelSummary['closed'] })
const LIST = [CONF, OLD, OBRA]

test('manifest: the eight commands, category Canais, ids never change', () => {
  const cmds = manifest.contributes!.commands!
  assert.deepEqual(cmds.map(c => c.command), ['channels.open', 'channels.create', 'channels.join', 'channels.remove', 'channels.mute', 'channels.unmute', 'channels.close', 'channels.reopen'])
  assert.deepEqual(Object.values(CMD).sort(), cmds.map(c => c.command).sort())
  assert.ok(cmds.every(c => c.category === 'Canais' && c.icon !== '' && c.title !== ''))
})

test('argOf: a text is the channel; an object keeps only the texts it knows', () => {
  assert.deepEqual(argOf('obra'), { channel: 'obra' })
  assert.deepEqual(argOf(''), {})
  assert.deepEqual(argOf(undefined), {})
  assert.deepEqual(argOf({ channel: 'c1', agent: 's1', confirmed: true, junk: 1 }), { channel: 'c1', agent: 's1', confirmed: true })
  assert.deepEqual(argOf({ channel: 5, agent: '' }), {})
})

test('channelPick: the desk\'s channel on top, the open ones, then the closed ones apart; the scope decides who is listed', () => {
  const all = channelPick(LIST, 'all', 'desk-1')
  assert.equal(all.featured!.value, 'desk_desk-1')
  assert.deepEqual(all.items.map(i => [i.value, i.group]), [['c2', 'Canais abertos'], ['c3', 'Encerrados']])
  const open = channelPick(LIST, 'open', 'desk-1')
  assert.deepEqual(open.items.map(i => i.value), ['c2'])
  assert.equal(open.featured!.label, '#obra')
  // Another desk, or none: nothing is featured.
  assert.equal(channelPick(LIST, 'open', 'desk-2').featured, undefined)
  assert.equal(channelPick(LIST, 'open', undefined).featured, undefined)
  // Close lists common open channels only (C17); reopen only common closed ones.
  assert.deepEqual(channelPick(LIST, 'common-open', 'desk-1'), { items: [{ ...channelPick(LIST, 'all', undefined).items[0]! }] })
  assert.deepEqual(inScope(LIST, 'closed').map(c => c.id), ['c3'])
  // A closed desk channel is not featured.
  const gone = { ...OBRA, closed: OLD.closed }
  assert.equal(channelPick([gone], 'all', 'desk-1').featured, undefined)
})

test('channelDetail: the members\' count and the owner; the desk channel and the closed one say so', () => {
  assert.equal(channelDetail(CONF), '4 membros · dono: Você')
  assert.equal(channelDetail(OBRA), 'canal da mesa · 3 membros · dono: Atrium')
  assert.equal(channelDetail(OLD), 'encerrado · só leitura')
  assert.equal(channelDetail({ ...CONF, members: 1 }), '1 membro · dono: Você')
})

test('findChannel: by id, or by the name with or without #, the open one first', () => {
  const dup = [sum({ id: 'x1', name: 'obra', closed: OLD.closed }), sum({ id: 'x2', name: 'obra' })]
  assert.equal(findChannel(LIST, 'c2')?.name, 'conferencia')
  assert.equal(findChannel(LIST, '#conferencia')?.id, 'c2')
  assert.equal(findChannel(dup, 'obra')?.id, 'x2')
  assert.equal(findChannel(LIST, 'nada'), undefined)
})

const agent = (slotId: string, name: string, deskId: string | undefined, alive = true): AgentChoice => ({
  slotId, kind: 'claude', name, alive, ...(deskId !== undefined ? { deskId, deskTitle: deskId === 'desk-1' ? 'obra' : 'geral' } : {}),
})

test('joinItems: the active desk first, the other desks, the drawer, the stopped last; members never listed', () => {
  const items = joinItems([
    agent('s1', 'conferente', 'desk-2'), agent('s2', 'bancada', 'desk-1'), agent('s3', 'dentro', 'desk-1'),
    agent('s4', 'parado', 'desk-1', false), agent('s5', 'gaveta', undefined),
  ], new Set(['s3']), 'desk-1')
  assert.deepEqual(items.map(i => [i.value, i.label, i.group]), [
    ['s2', 'claude · bancada', 'Nesta mesa · obra'], ['s1', 'claude · conferente', 'Mesa · geral'],
    ['s5', 'claude · gaveta', 'Gaveta e blocos'], ['s4', 'claude · parado', 'Parados'],
  ])
  assert.equal(items[0]!.letter, 'B')
  assert.equal('detail' in items[0]!, false, 'nothing to say: no detail')
  assert.equal(items[3]!.detail, 'parado')
})

test('joinItems: removed, stopped and sleeping-desk marks; the sleeping desk\'s agents go last, in the queue\'s order', () => {
  const ctx = { removed: new Set(['s1', 's6']), desks: [{ id: 'desk-1', asleep: false }, { id: 'desk-2', asleep: true }, { id: 'desk-3', asleep: false }] }
  const items = joinItems([
    agent('s6', 'parado-tirado', 'desk-3', false), agent('s5', 'dorme', 'desk-2'), agent('s1', 'leitor', 'desk-3'),
    agent('s2', 'bancada', 'desk-1'), agent('s7', 'dorme-parado', 'desk-2', false),
  ], new Set(), 'desk-1', undefined, ctx)
  assert.deepEqual(items.map(i => [i.value, i.group, i.detail]), [
    ['s2', 'Nesta mesa · obra', undefined],
    ['s1', 'Mesa · geral', 'tirado deste canal'],
    ['s5', 'Parados', 'mesa dormindo'],
    ['s7', 'Parados', 'parado · mesa dormindo'],
    ['s6', 'Parados', 'tirado deste canal · parado'],
  ])
  assert.deepEqual(joinItems([], new Set(), 'desk-1'), [])
})

test('PICK.agentJoin: the empty texts tell nobody outside the channel from no agent pane at all', () => {
  assert.equal(PICK.agentJoin('obra').empty, 'Nenhum agente fora do canal.')
  assert.equal(PICK.agentJoin('obra', true).empty, 'Não há guia de agente aberta. Abra um agente numa mesa e ele aparece aqui.')
  assert.equal(PICK.agentJoin('obra').title, 'Juntar a #obra')
})

test('memberItems: the owner first; mute offers the ones who speak, unmute the muted, remove everyone', () => {
  const m = (id: string, name: string, muted: boolean, by = 'user'): MemberInfo => ({ id, name, muted, since: '', by, alive: true, path: 'inside' })
  const members = [m('b', 'bancada', true), m('a', 'Atrium', false, 'desk'), m('c', 'conferente', false)]
  assert.deepEqual(memberItems(members, 'a', 'remove').map(i => i.value), ['a', 'b', 'c'])
  assert.deepEqual(memberItems(members, 'a', 'mute').map(i => i.value), ['a', 'c'])
  assert.deepEqual(memberItems(members, 'a', 'unmute').map(i => i.value), ['b'])
  assert.equal(memberItems(members, 'a', 'remove')[0]!.detail, 'dono · da mesa')
  assert.equal(memberItems(members, 'a', 'remove')[1]!.detail, 'membro · calado')
})

test('agent rows carry the emblem the reader gives, and none when it gives none', () => {
  const deploy = { name: 'Deploy', color: 'teal', icon: 'rocket-launch' } as const
  const reader = (id: string) => (id === 's2' || id === 'a' ? deploy : undefined)
  const join = joinItems([agent('s1', 'conferente', 'desk-1'), agent('s2', 'bancada', 'desk-1')], new Set(), 'desk-1', reader)
  assert.equal('emblem' in join[0]!, false)
  assert.deepEqual(join[1]!.emblem, deploy)
  assert.equal('emblem' in joinItems([agent('s2', 'bancada', 'desk-1')], new Set(), 'desk-1')[0]!, false, 'no reader: no emblem')
  const m = (id: string, name: string): MemberInfo => ({ id, name, muted: false, since: '', by: 'user', alive: true, path: 'inside' })
  const rows = memberItems([m('a', 'Atrium'), m('c', 'conferente')], 'a', 'remove', reader)
  assert.deepEqual(rows[0]!.emblem, deploy)
  assert.equal('emblem' in rows[1]!, false)
  // Channel rows never carry one.
  assert.equal('emblem' in channelItem(sum({ id: 'c9', name: 'obra' })), false)
})

test('the confirmations say the consequence; remove, mute and close are declared situations with one act each', () => {
  const rm = removeDialog({ channel: 'obra', member: 'soul · bancada', fromDesk: true })
  assert.equal(rm.situation, 'channels.remove')
  assert.equal(rm.title, 'Tirar soul · bancada de #obra?')
  assert.match(rm.message!, /recebe um aviso da sala/)
  assert.match(rm.message!, /ou até sair da mesa e voltar/)
  assert.equal(rm.choices[0]!.id, 'remove')
  assert.equal(rm.choices[0]!.tone, 'destructive')
  assert.doesNotMatch(removeDialog({ channel: 'obra', member: 'x', fromDesk: false }).message!, /da mesa/)

  const mu = muteDialog({ channel: 'obra', member: 'soul · bancada', fromDesk: false })
  assert.equal(mu.situation, 'channels.mute')
  assert.match(mu.message!, /continua ouvindo tudo/)
  assert.deepEqual(mu.choices.map(c => c.id), ['mute'])

  const cl = closeDialog({ channel: 'conferencia', members: 4 })
  assert.equal(cl.situation, 'channels.close')
  assert.match(cl.message!, /os 4 membros recebem um aviso/)
  assert.match(closeDialog({ channel: 'x', members: 1 }).message!, /o 1 membro recebe/)
  assert.deepEqual(cl.choices.map(c => c.id), ['close'])
})

test('removeDialog: three variants of the consequence (member, owner of a common channel, owner of the desk)', () => {
  const plain = removeDialog({ channel: 'obra', member: 'x', fromDesk: false, isOwner: false, desk: false }).message!
  assert.doesNotMatch(plain, /dono/)
  const own = removeDialog({ channel: 'obra', member: 'Atrium', fromDesk: false, isOwner: true, desk: false }).message!
  assert.match(own, /Ele é o dono deste canal\. Ao sair deixa de ser dono, e o canal passa para você\. Se for juntado de novo, volta como membro\./)
  const desk = removeDialog({ channel: 'obra', member: 'Atrium', fromDesk: true, isOwner: true, desk: true }).message!
  assert.match(desk, /Ele é o dono da mesa\. O canal segue com você até a mesa trocar de dono\./)
  assert.doesNotMatch(desk, /passa para você/)
})

test('memberMenu: member, muted, owner and desk member; the rows and their order', () => {
  const ids = (m: ReturnType<typeof memberMenu>): string[] => m.map(e => (e === 'sep' ? '-' : 'heading' in e ? `# ${e.heading}` : e.id))
  assert.deepEqual(ids(memberMenu({ name: 'claude · conferente', owner: false, muted: false, fromDesk: false })),
    ['# claude · conferente · membro', 'mute', 'remove', '-', 'talk', 'reveal'])
  assert.deepEqual(ids(memberMenu({ name: 'codex · conferência', owner: false, muted: true, fromDesk: false })),
    ['# codex · conferência · membro · calado', 'unmute', 'remove', '-', 'talk', 'reveal'])
  assert.equal((memberMenu({ name: 'Atrium', owner: true, muted: false, fromDesk: true })[0] as { heading: string }).heading, 'Atrium · dono · da mesa')
  const rows = memberMenu({ name: 'soul · bancada', owner: false, muted: false, fromDesk: true })
  const talk = rows.find(e => e !== 'sep' && 'id' in e && e.id === 'talk') as { label: string }
  assert.equal(talk.label, 'Falar com soul · bancada')
  const rm = rows.find(e => e !== 'sep' && 'id' in e && e.id === 'remove') as { danger?: boolean; label: string }
  assert.equal(rm.label, 'Tirar do canal')
  assert.equal(rm.danger, true)
})

test('channelMenu: open channel, with a muted member, desk channel and closed channel; rows and order', () => {
  const ids = (m: ReturnType<typeof channelMenu>): string[] => m.map(e => (e === 'sep' ? '-' : 'heading' in e ? `# ${e.heading}` : e.id))
  const member = (id: string, muted: boolean): MemberInfo => ({ id, name: id, muted, since: '', by: 'user', alive: true, path: 'inside' }) as MemberInfo
  const ans = (c: ChannelSummary, ms: MemberInfo[]): MembersAnswer => ({ channel: c, members: ms, removed: [] })

  // Open, loose, nobody muted: no "Devolver a voz…"; "Encerrar canal…" last.
  const open = ans(CONF, [member('a', false), member('b', false)])
  assert.deepEqual(ids(channelMenu(CONF, open)),
    ['# Dono: Você · 2 membros', '# canal avulso', 'join', 'members', 'toEnd', 'mute', 'remove', '-', 'link', 'move', 'closePane', '-', 'close'])
  const close = channelMenu(CONF, open).at(-1) as { label: string; danger?: boolean }
  assert.deepEqual([close.label, close.danger], ['Encerrar canal…', true])

  // With a muted member: the info line counts it and "Devolver a voz…" enters after "Calar agente…".
  const muted = ans(CONF, [member('a', false), member('b', true)])
  const withMuted = channelMenu(CONF, muted, { membersOpen: true })
  assert.equal((withMuted[0] as { heading: string }).heading, 'Dono: Você · 2 membros · 1 calado')
  assert.deepEqual(ids(withMuted).slice(5, 8), ['mute', 'unmute', 'remove'])
  assert.equal((withMuted.find(e => e !== 'sep' && 'id' in e && e.id === 'unmute') as { label: string }).label, 'Devolver a voz…')
  assert.equal((withMuted.find(e => e !== 'sep' && 'id' in e && e.id === 'members') as { checked?: boolean }).checked, true)

  // The desk's channel: no "Encerrar" and no "Reabrir"; the second line says it follows the desk.
  const desk = channelMenu(OBRA, ans(OBRA, [member('a', false)]))
  assert.equal((desk[0] as { heading: string }).heading, 'Dono: Atrium · 1 membro')
  assert.match((desk[1] as { heading: string }).heading, /^canal da mesa · segue a mesa/)
  assert.ok(!ids(desk).includes('close') && !ids(desk).includes('reopen'))
  const deskClosed = channelMenu({ ...OBRA, closed: OLD.closed }, ans({ ...OBRA, closed: OLD.closed }, []))
  assert.ok(!ids(deskClosed).includes('close') && !ids(deskClosed).includes('reopen'))

  // Closed loose channel: the gestures go, reading stays, "Reabrir canal" takes the last place.
  const closed = channelMenu(OLD, ans(OLD, [member('a', true)]))
  assert.deepEqual(ids(closed), ['# Dono: Você · 1 membro · 1 calado', '# canal avulso · encerrado', 'members', 'toEnd', '-', 'link', 'move', 'closePane', '-', 'reopen'])

  // Empty open channel: nothing to mute or take out (disabled), no "Membros" (no column).
  const empty = channelMenu(CONF, ans(CONF, []))
  assert.ok(!ids(empty).includes('members'))
  assert.equal((empty.find(e => e !== 'sep' && 'id' in e && e.id === 'remove') as { disabled?: boolean }).disabled, true)
})

test('createRow: the typed text makes the row "Criar #nome"; the rule shows while it is not a name; nothing for blank text', () => {
  assert.deepEqual(createRow('sala-nova'), { value: 'sala-nova', label: 'Criar #sala-nova', icon: 'chats-circle' })
  assert.equal(createRow('  #sala  ')!.value, 'sala', 'trimmed, one leading # dropped')
  assert.equal(createRow('  '), undefined)
  assert.equal(createRow('#'), undefined)
  const bad = createRow('Nova Sala!')!
  assert.equal(bad.value, 'Nova Sala!', 'the daemon judges: it goes as typed')
  assert.match(bad.detail!, /minúsculas, números e hífen/)
  assert.equal(createRow('a'.repeat(41))!.detail !== undefined, true)
})

test('failedDialog: the daemon\'s own message is told with the words', () => {
  assert.match(failedDialog('Criar canal', 'bad-name', 'recusado: bad-name').message!, /letras minúsculas.*O tetherd respondeu: recusado: bad-name/)
  assert.doesNotMatch(failedDialog('Criar canal', 'bad-name').message!, /tetherd respondeu/)
})

test('failedDialog: a refusal in plain words, an unknown code still says something', () => {
  assert.match(failedDialog('Encerrar canal', 'desk').message!, /segue a mesa/)
  assert.match(failedDialog('Juntar agente', 'removed').message!, /foi tirado do canal/)
  assert.match(failedDialog('Juntar agente', 'weird').message!, /\(weird\)/)
  assert.equal(failedDialog('x', 'closed').choices[0]!.id, 'ok')
})
