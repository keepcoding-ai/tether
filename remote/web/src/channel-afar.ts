// Managing a channel from afar (RR5, fio-spec 18), on screen: what the app's channel commands do (extensions/channels/
// renderer/commands.ts), over the portal's ops instead of the daemon's requests, with the app's own pickers, words and
// questions (texts.ts) on the web's box (sheet.ts). The channel's view asks it by the commands' ids (`run`), by its dialogs
// (`ask`, closing a poll) and by `poll-close`; nothing is drawn as done before the house says so: the view reads the
// channel again at the house's notice. The result goes to the Regency's brief notice (read aloud by its live region).
import type { DialogAnswer, DialogSpec } from '../../../app/shared/dialog.ts'
import { CMD } from '../../../extensions/channels/manifest.ts'
import {
  closeDialog, joinItems, joinResultDialog, memberItems, muteDialog, PICK, removeDialog, reopenDialog, type JoinOutcome, type MemberGesture,
} from '../../../extensions/channels/renderer/texts.ts'
import type { MemberInfo, PollState } from '../../../extensions/channels/daemon/requests.ts'
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import type { OpName } from '../../../src/remote/scopes.ts'
import { agentChoicesOf, channelAfarOf, doneText, failedAfar, joinedText, questionOf } from './channel-afar-rules.ts'
import type { RemoteHouse } from './host.ts'
import type { ActOutcome, Manager } from './manage.ts'
import { PROVING } from './manage-rules.ts'
import { ask, pickList, pickMany } from './sheet.ts'

export interface ChannelAfarDeps {
  house: RemoteHouse
  manager: Manager
  tier(): Tier
  /** The Regency's brief notice. */
  say(text: string): void
}

/** What the channel's host asks of it (host.ts `RemoteChannelAfar`). */
export interface ChannelAfarHost {
  manageAfar(): { close: boolean } | undefined
  run(command: string, args: Record<string, unknown>): Promise<undefined>
  ask(spec: DialogSpec): Promise<DialogAnswer>
  pollClose(channel: string, poll: number): Promise<{ result?: PollState['result']; closedAt?: string }>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export class ChannelAfar implements ChannelAfarHost {
  private readonly d: ChannelAfarDeps

  constructor(d: ChannelAfarDeps) { this.d = d }

  manageAfar(): { close: boolean } | undefined { return channelAfarOf(this.d.manager.caps) }

  async ask(spec: DialogSpec): Promise<DialogAnswer> {
    const a = await ask(this.d.tier(), questionOf(spec))
    return { choice: a?.choice ?? 'cancel', remember: false }
  }

  async pollClose(channel: string, poll: number): Promise<{ result?: PollState['result']; closedAt?: string }> {
    const r = await this.act('channels.poll-close', { channel, poll })
    if (!r.ok) {
      // The channels' own refusals the card says in its words; what the distance adds (no app, the session) the notice says.
      if (['poll-closed', 'unknown-poll', 'not-author', 'closed', 'unknown-channel'].includes(r.code)) throw Object.assign(new Error(r.code), { code: r.code })
      await this.failed('Encerrar enquete', r.code)
      return {}
    }
    const state = r.body.state && typeof r.body.state === 'object' ? r.body.state as { result?: PollState['result']; closedAt?: string } : {}
    return { ...(state.result ? { result: state.result } : {}), ...(state.closedAt ? { closedAt: state.closedAt } : {}) }
  }

  /** A command of the channel's view, by its id (the app's), with its arguments: the channel, and an agent when one is named. */
  async run(command: string, args: Record<string, unknown>): Promise<undefined> {
    const channel = str(args.channel)
    if (!channel || !this.manageAfar()) return undefined
    const agent = str(args.agent)
    switch (command) {
      case CMD.join: await this.join(channel); break
      case CMD.mute: await this.member('mute', channel, agent); break
      case CMD.unmute: await this.member('unmute', channel, agent); break
      case CMD.remove: await this.member('remove', channel, agent); break
      case CMD.close: await this.close(channel); break
      case CMD.reopen: await this.reopen(channel); break
    }
    return undefined
  }

  // ---------------------------------------------------------------- the facts of the house

  private summary(id: string) { return this.d.house.input().channels.find(c => c.id === id) }
  private nameOf(id: string): string { return this.summary(id)?.name ?? id }
  private agentName(id: string): string { return this.d.house.input().agents.find(a => a.id === id)?.name ?? id }

  /** The members as the app's `members` answer has them (the house says who, and who is muted; never how they came in). */
  private async members(channel: string): Promise<MemberInfo[]> {
    const list = await this.d.house.members(channel).catch(() => [])
    return list.map(m => ({ id: m.id, name: m.name, muted: m.muted === true, since: '', by: '', alive: true, path: 'inside' }))
  }

  /** The desk the person looks at from afar: none (the app's "Nesta mesa" is the desk in view on the machine). */
  private desks() { return this.d.house.input().desks.desks.filter(x => x.kind === 'queue').map(x => ({ id: x.id, asleep: x.asleep })) }

  // ---------------------------------------------------------------- the gestures

  /** "Chamar agente…": the agents outside the channel, by desk as in the app, several at once; one `join` each, in order. */
  private async join(channel: string): Promise<void> {
    const inside = new Set((await this.members(channel)).map(m => m.id))
    const name = this.nameOf(channel)
    const agents = agentChoicesOf(this.d.house.input())
    const text = PICK.agentJoin(name, agents.length === 0)
    const chosen = await pickMany<string>(this.d.tier(), {
      title: text.title, placeholder: text.placeholder, emptyText: text.empty, confirmLabel: 'Chamar', confirmHint: 'chama',
      items: joinItems(agents, inside, undefined, undefined, { desks: this.desks() }),
    })
    if (!chosen || chosen.length === 0) return
    const outcomes: JoinOutcome[] = []
    for (const id of chosen) {
      const r = await this.act('channels.join', { channel, agent: id })
      outcomes.push(r.ok ? { name: this.agentName(id) } : { name: this.agentName(id), code: r.code })
    }
    const failed = outcomes.filter(o => o.code !== undefined)
    if (failed.length === 1 && outcomes.length === 1) { await this.failed('Chamar agente', failed[0]!.code!); return }
    if (failed.length > 0) await ask(this.d.tier(), questionOf(joinResultDialog(outcomes)))
    const said = joinedText(outcomes.filter(o => o.code === undefined).map(o => o.name), name)
    if (said) this.d.say(said)
  }

  /** Calar, devolver a voz, tirar: the member (asked when the command named none), the app's question, then the act. */
  private async member(kind: MemberGesture, channel: string, agent: string | undefined): Promise<void> {
    const name = this.nameOf(channel)
    const members = await this.members(channel)
    const ch = this.summary(channel)
    const ownerId = ch?.owner.kind === 'agent' ? ch.owner.id : undefined
    const text = kind === 'remove' ? PICK.agentRemove(name) : kind === 'mute' ? PICK.agentMute(name) : PICK.agentUnmute(name)
    const id = agent ?? await pickList<string>(this.d.tier(), {
      title: text.title, placeholder: text.placeholder, emptyText: text.empty, items: memberItems(members, ownerId, kind),
    })
    if (id === undefined) return
    const member = members.find(m => m.id === id)?.name ?? this.agentName(id)
    if (kind !== 'unmute') {
      const t = { channel: name, member, fromDesk: false, isOwner: ownerId === id, desk: ch?.desk !== undefined }
      const a = await ask(this.d.tier(), questionOf(kind === 'remove' ? removeDialog(t) : muteDialog(t)))
      if (a?.choice !== kind) return
    }
    const op: OpName = kind === 'remove' ? 'channels.remove' : kind === 'mute' ? 'channels.mute' : 'channels.unmute'
    const r = await this.act(op, { channel, agent: id })
    if (!r.ok) { await this.failed(kind === 'remove' ? 'Tirar agente' : kind === 'mute' ? 'Calar agente' : 'Devolver a voz', r.code); return }
    this.d.say(doneText(kind, name, member))
  }

  /** "Encerrar canal…": the app's question, the line of the biometrics before its button, then the act with its proof. */
  private async close(channel: string): Promise<void> {
    if (this.manageAfar()?.close !== true) return
    const name = this.nameOf(channel)
    const members = this.summary(channel)?.members ?? (await this.members(channel)).length
    const a = await ask(this.d.tier(), questionOf(closeDialog({ channel: name, members }), ['close']))
    if (a?.choice !== 'close') return
    const r = await this.act('channels.close', { channel }, true)
    if (!r.ok) { await this.failed('Encerrar canal', r.code); return }
    this.d.say(doneText('close', name))
  }

  private async reopen(channel: string): Promise<void> {
    const name = this.nameOf(channel)
    const members = this.summary(channel)?.members ?? 0
    const a = await ask(this.d.tier(), questionOf(reopenDialog({ channel: name, members })))
    if (a?.choice !== 'reopen') return
    const r = await this.act('channels.reopen', { channel })
    if (!r.ok) { await this.failed('Reabrir canal', r.code); return }
    this.d.say(doneText('reopen', name))
  }

  // ---------------------------------------------------------------- the way of an act

  private act(op: OpName, body: Record<string, unknown>, proof = false): Promise<ActOutcome> {
    return this.d.manager.act(op, body, proof ? { proof: 'act', proving: () => this.d.say(PROVING) } : {})
  }

  /** A refusal in the app's dialog, the words of the channels or of the distance (never the code). */
  private async failed(what: string, code: string): Promise<void> {
    if (code === 'cancelled') { this.d.say('A biometria foi cancelada. Nada foi feito.'); return }
    await ask(this.d.tier(), questionOf(failedAfar(what, code)))
  }
}
