// A made-up house for the bench: the readings of the contract answered from memory, so the Regency's screen can be looked
// at (and captured) with no relay and no machine. Plausible, small and fixed: three desks (one hibernating), five agents of
// the four engines, three channels, someone waiting. The times are relative to "now", so "há 6 min" stays true.
// Text that looks like markup is here on purpose: it must reach the page as text.
import type { ChannelSummary } from '../../../../extensions/channels/daemon/requests.ts'
import type { RegencyInput } from '../../../../extensions/regency/model.ts'
import type { MarksAnswer, PageAnswer, PageLine, RemoteMember, RemoteNotice, RemoteSource, TreeAnswer } from '../../src/host.ts'

const MIN = 60_000

export interface FakeOptions {
  /** The app is closed on the machine: the tree is the last one it published. */
  appClosed?: boolean
  now?: () => number
}

export interface FakeHouse extends RemoteSource {
  /** Sends a notice, as the house would. */
  notify(n: RemoteNotice): void
}

export function fakeHouse(o: FakeOptions = {}): FakeHouse {
  const now = o.now ?? Date.now
  const t0 = now()
  const iso = (minutesAgo: number): string => new Date(t0 - minutesAgo * MIN).toISOString()
  const listeners = new Set<(n: RemoteNotice) => void>()

  const channel = (id: string, members: number): ChannelSummary => ({ id, name: id, title: id, owner: { kind: 'user' }, members, seenByUser: 0, createdAt: iso(600) })

  const input: RegencyInput = {
    desks: {
      desks: [
        {
          id: 'desk-obra', name: 'Obra', color: 'blue', kind: 'queue', asleep: false, panes: [
            { id: 'p1', type: 'terminal', icon: 'sparkle', title: 'conferente', busy: true },
            { id: 'p2', type: 'terminal', icon: 'lightning', title: 'bancada', attention: 'done' },
            { id: 'channel:obra', type: 'channel', icon: 'chats-circle', title: '#obra' },
            { id: 'p4', type: 'terminal', icon: 'terminal-window', title: 'web · npm run dev' },
          ],
        },
        {
          id: 'desk-migr', name: 'Migração', color: 'green', kind: 'queue', asleep: false, panes: [
            { id: 'p5', type: 'terminal', icon: 'ghost', title: 'migra', busy: true },
            { id: 'p6', type: 'terminal', icon: 'sparkle', title: 'revisor', attention: 'waiting' },
            { id: 'web:p7', type: 'web', icon: 'globe-simple', title: 'Docs do Postgres 17 <b>índices</b>' },
          ],
        },
        {
          id: 'desk-pesq', name: 'Pesquisa', color: 'purple', kind: 'queue', asleep: true, panes: [
            { id: 'p8', type: 'terminal', icon: 'hand', title: 'leitor', asleep: true },
            { id: 'note:p9', type: 'note', icon: 'note-pencil', title: 'achados.md' },
          ],
        },
      ],
    },
    owners: { desk: { 'desk-migr': { id: 'p5', name: 'migra' } }, pane: {} },
    channels: [channel('obra', 2), channel('extra', 1), channel('migra', 2)],
    channelMarks: {},
    agents: [
      { id: 'p1', kind: 'claude', name: 'conferente' },
      { id: 'p2', kind: 'codex', name: 'bancada', emblem: { name: 'Bancada', color: 'purple', icon: 'wrench' } },
      { id: 'p5', kind: 'soul', name: 'migra' },
      { id: 'p6', kind: 'claude', name: 'revisor' },
      { id: 'p8', kind: 'hands', name: 'leitor' },
    ],
    since: { 'agent:p6': t0 - 6 * MIN, 'pane:p6': t0 - 6 * MIN, 'channel:extra': t0 - 3 * MIN },
    collapsed: [],
    closed: [
      { slotId: 's-old', kind: 'claude', name: 'explorador-velho', endedAt: iso(120) },
      { slotId: 's-sh', kind: 'shell', name: 'rascunho.sh', endedAt: iso(26 * 60) },
    ],
  }

  const members: Record<string, RemoteMember[]> = {
    obra: [{ id: 'p1', name: 'conferente' }, { id: 'p2', name: 'bancada' }],
    extra: [{ id: 'p2', name: 'bancada' }],
    migra: [{ id: 'p5', name: 'migra' }, { id: 'p6', name: 'revisor', muted: true }],
  }
  const ids = (channelId: string): string[] => (members[channelId] ?? []).map(m => m.id)
  const moderator = { name: 'usuário' }

  const marks: MarksAnswer = {
    channels: [
      { channel: 'obra', name: 'obra', unread: 0, toMe: 0, seen: 8, asks: 0, owed: 0, members: ids('obra') },
      { channel: 'extra', name: 'extra', unread: 1, toMe: 1, seen: 2, asks: 0, owed: 0, firstToMe: 3, firstCall: { why: 'to-you', text: 'bancada: Qual das duas telas de filtro fica?' }, members: ids('extra') },
      { channel: 'migra', name: 'migra', unread: 4, toMe: 0, seen: 5, asks: 0, owed: 0, members: ids('migra') },
    ],
    more: 0,
    moderator,
  }

  const me: PageLine['from'] = { id: 'user', name: 'usuário', role: 'moderator' }
  const who = (id: string, name: string): PageLine['from'] => ({ id, name, role: 'member' })
  const sys: PageLine['from'] = { id: 'tether', name: 'tether', role: 'system' }
  const say = (seq: number, minutesAgo: number, from: PageLine['from'], body: string, to?: string[]): PageLine =>
    ({ seq, at: iso(minutesAgo), kind: 'message', from, body, ...(to ? { to } : {}) })

  const pages: Record<string, PageLine[]> = {
    obra: [
      { seq: 1, at: iso(44), kind: 'notice', from: sys, body: 'conferente entrou', event: { type: 'join', who: 'p1' } },
      { seq: 2, at: iso(43), kind: 'notice', from: sys, body: 'bancada entrou', event: { type: 'join', who: 'p2' } },
      say(3, 38, who('p1', 'conferente'), 'O índice paginado está pronto; 18 testes verdes.'),
      say(4, 35, who('p2', 'bancada'), 'Confiro a tela de filtros e volto.'),
      say(5, 29, me, 'Quero a versão com os chips numa linha só, rolando de lado no celular.', ['bancada']),
      say(6, 16, who('p2', 'bancada'), 'Feito: os chips rolam de lado no celular. Deixei as duas versões para você escolher em #extra.', ['usuário']),
      say(7, 9, who('p1', 'conferente'), 'Rodando a bateria de paginação de novo, agora com 10 mil linhas. Detalhe em https://example.org/bateria e no arquivo <script>alert(1)</script>.'),
      say(8, 2, who('p1', 'conferente'), 'Metade passou. A ordenação por data ficou estável; sigo com a busca.'),
    ],
    extra: [
      { seq: 1, at: iso(20), kind: 'notice', from: sys, body: 'bancada entrou', event: { type: 'join', who: 'p2' } },
      say(2, 18, who('p2', 'bancada'), 'Deixo aqui as duas telas de filtro.'),
      say(3, 3, who('p2', 'bancada'), 'Qual das duas telas de filtro fica?', ['usuário']),
    ],
    migra: [
      { seq: 1, at: iso(50), kind: 'notice', from: sys, body: 'migra entrou', event: { type: 'join', who: 'p5' } },
      { seq: 2, at: iso(49), kind: 'notice', from: sys, body: 'revisor entrou', event: { type: 'join', who: 'p6' } },
      say(3, 30, who('p5', 'migra'), 'Copiando 1,2 mi de linhas para a tabela nova.'),
      say(4, 22, who('p6', 'revisor'), 'Reviso a migração 0042 enquanto isso.'),
      say(5, 14, who('p5', 'migra'), 'Um terço copiado, sem erro.'),
      say(6, 8, who('p6', 'revisor'), 'A 0042 está certa. Falta só aplicar.'),
      say(7, 7, who('p5', 'migra'), 'Dois terços copiados.'),
      say(8, 6, who('p6', 'revisor'), 'Aplico a migração 0042 em produção?'),
      say(9, 4, who('p5', 'migra'), 'Cópia terminada: contagens iguais nas duas tabelas.'),
    ],
  }

  const tree = (): TreeAnswer => (o.appClosed
    ? { input, live: false, asOf: t0 - 8 * MIN, sig: 'bench' }
    : { input, live: true, sig: 'bench' })

  return {
    tree: async () => tree(),
    marks: async () => marks,
    page: async (channelId, before): Promise<PageAnswer> => {
      const all = pages[channelId]
      if (!all) throw new Error('unknown-channel')
      const upTo = before === undefined ? all : all.filter(l => l.seq < before)
      const lines = upTo.slice(-50)
      const first = lines[0]?.seq
      return {
        channel: { id: channelId, name: channelId, title: channelId },
        lines, reactions: channelId === 'obra' ? [{ seq: 3, tallies: [{ emoji: '👍', name: 'agree', by: [{ id: 'p2', name: 'bancada' }, { id: 'user', name: 'usuário' }] }] }] : [],
        polls: [], last: all[all.length - 1]?.seq ?? 0, members: members[channelId] ?? [], moderator,
        ...(first !== undefined && first > 1 ? { before: first } : {}),
      }
    },
    members: async channelId => members[channelId] ?? [],
    onNotice: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } },
    notify: n => { for (const l of [...listeners]) l(n) },
  }
}
