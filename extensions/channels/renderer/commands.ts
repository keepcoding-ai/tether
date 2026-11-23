// The channel commands in the app (U2). Each one with an argument acts at once (no picker); without it, it asks: a picker of
// channels (the desk's own on top, with the members' count) and, for the gestures on an agent, a second step (join: agents
// outside the channel; remove, mute, unmute: its members). Remove, mute and close say their consequence in a dialog first.
// Every act is a request of the moderator to tetherd (`join`, `remove`...); a refusal comes back as a dialog in plain words.
import type { Disposable, PickSpec, TetherUi } from '../../../app/renderer/ext-api.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import { CMD } from '../manifest.ts'
import {
  PICK, agentLabel, channelPick, closeDialog, failedDialog, findChannel, joinItems, memberItems, muteDialog, needsNameDialog, removeDialog,
  type AgentChoice, type ChannelScope, type MemberGesture,
} from './texts.ts'
import type { MembersAnswer } from './view-model.ts'

/** What a command takes as its argument: a channel (id or name) and an agent (slot id or name); `confirmed` skips the dialog. */
export interface ChannelArg {
  channel?: string
  agent?: string
  name?: string
  title?: string
  confirmed?: boolean
}

/** The arguments as given by whoever runs the command: a bare text is the channel. */
export function argOf(raw: unknown): ChannelArg {
  if (typeof raw === 'string') return raw === '' ? {} : { channel: raw }
  if (raw === null || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const text = (k: string): string | undefined => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : undefined)
  const channel = text('channel'), agent = text('agent'), name = text('name'), title = text('title')
  return {
    ...(channel !== undefined ? { channel } : {}), ...(agent !== undefined ? { agent } : {}),
    ...(name !== undefined ? { name } : {}), ...(title !== undefined ? { title } : {}), ...(o.confirmed === true ? { confirmed: true } : {}),
  }
}

/** The channels the app knows, kept from the daemon's `list` (closed ones too) and refreshed when a channel changes. */
export interface Directory {
  /** What is held now (menus read it at once). */
  list(): readonly ChannelSummary[]
  /** Asks the daemon again. */
  refresh(): Promise<readonly ChannelSummary[]>
  disposables: Disposable[]
}

const REFRESH_DELAY_MS = 200

export function createDirectory(ui: TetherUi): Directory {
  let held: readonly ChannelSummary[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async (): Promise<readonly ChannelSummary[]> => {
    const r = await ui.daemon.request<{ channels: ChannelSummary[] }>('list', { closed: true })
    held = r.channels
    return held
  }
  const soon = (): void => {
    if (timer) return
    timer = setTimeout(() => { timer = undefined; void refresh().catch(() => {}) }, REFRESH_DELAY_MS)
  }
  void refresh().catch(() => {})
  return {
    list: () => held,
    refresh,
    disposables: [
      ui.daemon.onEvent('channel', soon),
      { dispose: () => { if (timer) { clearTimeout(timer); timer = undefined } } },
    ],
  }
}

const codeOf = (e: unknown): string => (e !== null && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'unknown')

export interface CommandDeps {
  /** Opens the channel's pane or brings the one that exists forward (P3). */
  open(channelId: string, name?: string): void
  directory: Directory
}

export function createCommands(ui: TetherUi, deps: CommandDeps): Disposable[] {
  const dir = deps.directory

  /** A request of the moderator; a refusal is told to the person and the answer is undefined. */
  const act = async <T>(what: string, name: string, args: object): Promise<T | undefined> => {
    try { return await ui.daemon.request<T>(name, args) } catch (e) {
      await ui.dialogs.ask(failedDialog(what, codeOf(e))).catch(() => undefined)
      return undefined
    }
  }
  const membersOf = (channel: string): Promise<MembersAnswer> => ui.daemon.request<MembersAnswer>('members', { channel })

  const agents = (): AgentChoice[] => ui.agents.list().map(a => ({
    slotId: a.slotId, kind: a.kind, name: a.name, alive: a.alive,
    ...(a.deskId !== undefined ? { deskId: a.deskId } : {}), ...(a.deskTitle !== undefined ? { deskTitle: a.deskTitle } : {}),
  }))
  /** An agent the person named: the slot id, or the name its tab shows. */
  const agentId = (ref: string): string => {
    const all = agents()
    return all.find(a => a.slotId === ref)?.slotId ?? all.find(a => a.name === ref || agentLabel(a) === ref)?.slotId ?? ref
  }

  const channelSpec = (list: readonly ChannelSummary[], scope: ChannelScope, text: { title: string; placeholder: string; empty: string }): PickSpec<string> => {
    const p = channelPick(list, scope, ui.desks.activeId())
    return { title: text.title, placeholder: text.placeholder, emptyText: text.empty, ...(p.featured ? { featured: p.featured } : {}), items: p.items }
  }

  /** The channel of the argument, or the person's pick; undefined when she closed the picker (or the channel is not there). */
  async function channelFor(arg: ChannelArg, scope: ChannelScope, text: { title: string; placeholder: string; empty: string }, what: string): Promise<ChannelSummary | undefined> {
    const list = await dir.refresh().catch(() => dir.list())
    if (arg.channel !== undefined) {
      const found = findChannel(list, arg.channel)
      if (!found) await ui.dialogs.ask(failedDialog(what, 'unknown-channel')).catch(() => undefined)
      return found
    }
    const id = await ui.pick.list(channelSpec(list, scope, text))
    return id === undefined ? undefined : list.find(c => c.id === id)
  }

  // ---------- open and create ----------

  const open = async (arg: ChannelArg): Promise<void> => {
    const ch = await channelFor(arg, 'all', PICK.open, 'Abrir canal')
    if (ch) deps.open(ch.id, ch.name)
  }

  const create = async (arg: ChannelArg): Promise<void> => {
    if (arg.name === undefined) { await ui.dialogs.ask(needsNameDialog()).catch(() => undefined); return }
    const r = await act<{ channel: ChannelSummary }>('Criar canal', 'create', { name: arg.name, ...(arg.title !== undefined ? { title: arg.title } : {}) })
    if (r) { await dir.refresh().catch(() => {}); deps.open(r.channel.id, r.channel.name) }
  }

  // ---------- the gestures on an agent: channel, then agent ----------

  const SCOPE_TEXT = { join: PICK.join, remove: PICK.remove, mute: PICK.mute, unmute: PICK.unmute } as const
  const AGENT_TEXT = { join: PICK.agentJoin, remove: PICK.agentRemove, mute: PICK.agentMute, unmute: PICK.agentUnmute } as const
  const WHAT = { join: 'Juntar agente', remove: 'Tirar agente', mute: 'Calar agente', unmute: 'Devolver a voz' } as const

  const agentSpec = (kind: keyof typeof AGENT_TEXT, channel: ChannelSummary): PickSpec<string> => {
    const text = AGENT_TEXT[kind](channel.name)
    return {
      title: text.title, placeholder: text.placeholder, emptyText: text.empty,
      items: async () => {
        const a = await membersOf(channel.id)
        if (kind === 'join') return joinItems(agents(), new Set(a.members.map(m => m.id)), ui.desks.activeId())
        const ownerId = a.channel.owner.kind === 'agent' ? a.channel.owner.id : undefined
        return memberItems(a.members, ownerId, kind as MemberGesture)
      },
    }
  }

  async function gesture(kind: keyof typeof AGENT_TEXT, arg: ChannelArg): Promise<void> {
    const what = WHAT[kind]
    const list = await dir.refresh().catch(() => dir.list())
    let channel = arg.channel !== undefined ? findChannel(list, arg.channel) : undefined
    if (arg.channel !== undefined && !channel) { await ui.dialogs.ask(failedDialog(what, 'unknown-channel')).catch(() => undefined); return }
    let agent = arg.agent !== undefined ? agentId(arg.agent) : undefined
    if (!channel && agent === undefined) {
      const spec = channelSpec(list, 'open', SCOPE_TEXT[kind])
      const r = await ui.pick.steps(spec, id => agentSpec(kind, list.find(c => c.id === id)!))
      if (!r) return
      channel = list.find(c => c.id === r.first)
      agent = r.second
    } else if (!channel) {
      const id = await ui.pick.list(channelSpec(list, 'open', SCOPE_TEXT[kind]))
      if (id === undefined) return
      channel = list.find(c => c.id === id)
    } else if (agent === undefined) {
      agent = await ui.pick.list(agentSpec(kind, channel))
    }
    if (!channel || agent === undefined) return

    if ((kind === 'remove' || kind === 'mute') && arg.confirmed !== true) {
      const answer = await memberText(channel, agent)
      if (!answer) return
      const dialog = kind === 'remove' ? removeDialog(answer) : muteDialog(answer)
      const a = await ui.dialogs.ask(dialog).catch(() => undefined)
      if (a?.choice !== kind) return
    }
    await act(what, kind, { channel: channel.id, agent })
    await dir.refresh().catch(() => {})
  }

  /** The words of the confirmation: the member's name and whether it came by the desk. */
  async function memberText(channel: ChannelSummary, agent: string): Promise<{ channel: string; member: string; fromDesk: boolean } | undefined> {
    try {
      const a = await membersOf(channel.id)
      const m = a.members.find(x => x.id === agent)
      return { channel: channel.name, member: m?.name ?? ui.agents.get(agent)?.name ?? agent, fromDesk: m?.by === 'desk' }
    } catch (e) {
      await ui.dialogs.ask(failedDialog('Não foi possível ler o canal', codeOf(e))).catch(() => undefined)
      return undefined
    }
  }

  // ---------- close and reopen ----------

  async function close(arg: ChannelArg): Promise<void> {
    const ch = await channelFor(arg, 'common-open', PICK.close, 'Encerrar canal')
    if (!ch) return
    if (arg.confirmed !== true) {
      const a = await ui.dialogs.ask(closeDialog({ channel: ch.name, members: ch.members })).catch(() => undefined)
      if (a?.choice !== 'close') return
    }
    await act('Encerrar canal', 'close', { channel: ch.id })
    await dir.refresh().catch(() => {})
  }

  async function reopen(arg: ChannelArg): Promise<void> {
    const ch = await channelFor(arg, 'closed', PICK.reopen, 'Reabrir canal')
    if (!ch) return
    await act('Reabrir canal', 'reopen', { channel: ch.id })
    await dir.refresh().catch(() => {})
  }

  const handlers: Array<[string, (arg: ChannelArg) => Promise<void>]> = [
    [CMD.open, open], [CMD.create, create],
    [CMD.join, a => gesture('join', a)], [CMD.remove, a => gesture('remove', a)],
    [CMD.mute, a => gesture('mute', a)], [CMD.unmute, a => gesture('unmute', a)],
    [CMD.close, close], [CMD.reopen, reopen],
  ]
  const disposables: Disposable[] = handlers.map(([id, fn]) =>
    ui.commands.registerCommand(id, (_source, raw) => { void fn(argOf(raw)).catch(e => console.error(id, e)) }))

  // Test hook: fires a command as a menu does (a picker waits for the person, so it never resolves with the flow).
  ui.test.expose('run', (id: string, raw?: unknown): void => { void ui.commands.run(id, raw) })
  return disposables
}
