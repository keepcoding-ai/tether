// The executor of the Regency's "+ Novo": each act of `planOf` (create-rules.ts) done by the seams the core and the feeds
// already have (ui.create, ui.desks.create, the browser's and the channels' feeds, for-agents' give, ui.panes.moveToDesk).
// No DOM and no `ui` here: the renderer hands the seams in, so the unit test runs it on fake ones. Nothing it calls switches
// desk or takes the keyboard; the person stays on the Regency.
import type { ActResult, CreateAct } from '../create-rules.ts'
import { REF_PANE } from '../create-rules.ts'

/** Why a browser tab was not made (the browser feed's `why`). */
export type TabRefusal = 'no-browser' | 'no-desk' | 'no-agent' | 'full' | 'failed'
export type TabOutcome = { ok: true; tabId: string } | { ok: false; why: TabRefusal }
/** A feed's act: done, or refused in plain words (the channels feed). */
export type FeedAct<T = object> = ({ ok: true } & T) | { refusal: string }

export interface CreateSeams {
  slot(spec: { deskId: string; kind: string; cwd: string; profileId?: string; name?: string; front?: boolean }): Promise<{ paneId: string; deskId: string } | { error: string }>
  item(spec: { deskId: string; itemId: string; cwd: string; destination?: string; front?: boolean }): Promise<{ paneId: string; deskId: string } | { error: string } | undefined>
  /** A queue desk the person does not switch to; its id. */
  desk(spec: { name: string; color?: string; after?: string }): string
  /** A tab of the person's on `deskId`. */
  tab(opts: { url?: string; deskId: string }): Promise<TabOutcome>
  /** A tab born the agent's on `deskId` (its shield up before anything navigates). */
  tabFor(agent: string, opts: { deskId: string }): Promise<TabOutcome>
  /** The pane id of a browser tab. */
  tabPane(tabId: string): string
  channel(name: string): Promise<FeedAct<{ id: string }>>
  join(channelId: string, agent: string): Promise<FeedAct>
  /** The channel in the Regency's centre (P3: not a tab). */
  show(channelId: string): void
  /** Gives a pane or a desk to an agent; the refusal in plain words, or undefined when it took. */
  give(kind: 'pane' | 'desk', id: string, to: string): Promise<string | undefined>
  move(pane: string, deskId: string): boolean
  /** An agent's name, for a refusal of the channel. */
  nameOf(agent: string): string
}

const TAB_WORDS: Readonly<Record<TabRefusal, string>> = {
  'no-browser': 'o navegador está desligado',
  'no-desk': 'essa mesa não existe mais',
  'no-agent': 'esse agente não existe mais',
  full: 'há abas demais abertas',
  failed: 'o navegador não abriu a aba',
}

/** The field of the card a sentence of validation (create-rules.ts `stepError`) belongs to: the sentence goes beside it. */
export function errorField(error: string): string {
  if (/^Escolha (o que criar|o agente)/.test(error) || /agente que recebe/.test(error)) return 'what'
  if (/nome à mesa|nome da mesa/.test(error)) return 'desk-name'
  if (/mesa/i.test(error)) return 'desk'
  if (/pasta/.test(error)) return 'cwd'
  if (/^Esse canal/.test(error)) return 'join'
  if (/endereço/.test(error)) return 'url'
  if (/canal/.test(error)) return 'channel-name'
  return 'step'
}

/** What the run made, in order of making: the Regency lights the last desk or pane of it. */
export interface Made { deskId?: string; paneId?: string; channelId?: string }

export interface ActRunner {
  exec(act: CreateAct): Promise<ActResult>
  readonly made: Made
}

/**
 * The runner of one plan. A browser tab for an agent is born the agent's (`tabFor`: the shield goes up before anything
 * navigates), so the plan's `give` of that tab, which `planOf` puts after it, is already done and is not asked again.
 */
export function createRunner(acts: readonly CreateAct[], seams: CreateSeams): ActRunner {
  const tabTo = acts.find((a): a is Extract<CreateAct, { act: 'give' }> => a.act === 'give' && a.kind === 'pane' && a.id === REF_PANE)?.to
  const bornFor = new Map<string, string>()
  const made: Made = {}
  const exec = async (act: CreateAct): Promise<ActResult> => {
    switch (act.act) {
      case 'desk': {
        const deskId = seams.desk({ name: act.name, ...(act.color !== undefined ? { color: act.color } : {}), ...(act.after !== undefined ? { after: act.after } : {}) })
        if (!deskId) return { ok: false, error: 'a mesa não nasceu' }
        made.deskId = deskId
        return { ok: true, deskId }
      }
      case 'slot': {
        const r = await seams.slot({
          deskId: act.deskId, kind: act.kind, cwd: act.cwd, front: act.front,
          ...(act.profileId !== undefined ? { profileId: act.profileId } : {}), ...(act.name !== undefined ? { name: act.name } : {}),
        })
        if ('error' in r) return { ok: false, error: r.error }
        made.deskId = r.deskId
        made.paneId = r.paneId
        return { ok: true, deskId: r.deskId, paneId: r.paneId }
      }
      case 'item': {
        const r = await seams.item({ deskId: act.deskId, itemId: act.itemId, cwd: act.cwd, front: act.front, ...(act.destination !== undefined ? { destination: act.destination } : {}) })
        if (r === undefined) return { ok: false, error: 'a criação foi cancelada' }
        if ('error' in r) return { ok: false, error: r.error }
        made.deskId = r.deskId
        made.paneId = r.paneId
        return { ok: true, deskId: r.deskId, paneId: r.paneId }
      }
      case 'browser': {
        const r = tabTo !== undefined
          ? await seams.tabFor(tabTo, { deskId: act.deskId })
          : await seams.tab({ deskId: act.deskId, ...(act.url !== undefined ? { url: act.url } : {}) })
        if (!r.ok) return { ok: false, error: TAB_WORDS[r.why] }
        const paneId = seams.tabPane(r.tabId)
        if (tabTo !== undefined) bornFor.set(paneId, tabTo)
        made.deskId = act.deskId
        made.paneId = paneId
        return { ok: true, deskId: act.deskId, paneId }
      }
      case 'channel': {
        const r = await seams.channel(act.name)
        if ('refusal' in r) return { ok: false, error: r.refusal }
        made.channelId = r.id
        return { ok: true, channelId: r.id }
      }
      case 'join': {
        const refused: string[] = []
        let joined = 0
        for (const agent of act.agents) {
          const r = await seams.join(act.channel, agent)
          if ('refusal' in r) refused.push(`${seams.nameOf(agent)} (${r.refusal.replace(/[.\s]+$/, '')})`)
          else joined++
        }
        if (joined === 0 && refused.length > 0) return { ok: false, error: `não entraram: ${refused.join(', ')}` }
        return { ok: true, ...(refused.length > 0 ? { refused } : {}) }
      }
      case 'show': {
        seams.show(act.channel)
        return { ok: true }
      }
      case 'give': {
        if (act.kind === 'pane' && bornFor.get(act.id) === act.to) return { ok: true }
        const refusal = await seams.give(act.kind, act.id, act.to)
        return refusal === undefined ? { ok: true } : { ok: false, error: refusal }
      }
      case 'move': {
        return seams.move(act.pane, act.deskId) ? { ok: true } : { ok: false, error: 'o tether recusou a mudança de mesa' }
      }
    }
  }
  return { exec, made }
}
