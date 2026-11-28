// "+ Novo" from afar (RR5 5.3, fio-spec 18), the pure rules of the web: which tiles the device's scopes allow, the choices
// of `create.options` as the app's card reads them (profiles as its items, folders by their id and label), and each act of
// the card's plan (create-rules.ts planOf) as the portal's op and body, its ceilings checked before anything goes. No DOM.
import type { CreateItem } from '../../../app/renderer/ext-api.ts'
import type { CreateAct, CreateWhat } from '../../../extensions/regency/create-rules.ts'
import { CREATE_NAME_MAX, FOLDER_ID_RE, type CreateOptions } from '../../../src/remote/create.ts'
import { DESK_COLORS } from '../../../src/remote/app-acts.ts'
import type { OpName } from '../../../src/remote/scopes.ts'
import type { Caps } from './manage-rules.ts'

/** The tiles of the card this device may make: an agent is `manage:agents`; a pane and a desk `manage:desks`; a channel `channels`. */
export function tilesOf(caps: Caps): CreateWhat[] {
  return [
    ...(caps.agents ? ['agent' as const] : []),
    ...(caps.desks ? ['terminal' as const, 'note' as const, 'browser' as const, 'desk' as const] : []),
    ...(caps.channels ? ['channel' as const] : []),
  ]
}

/** Whether "+ Novo" has anything to offer this device (else its button is not drawn). */
export const createsAny = (caps: Caps): boolean => tilesOf(caps).length > 0

/** A profile's id in the card: its engine and its name (the portal names a profile by its name within its engine). */
const SEP = '\u001f'
export const profileIdOf = (engine: string, name: string): string => `${engine}${SEP}${name}`
export function profileOfId(id: string | undefined): { engine: string; name: string } | undefined {
  if (id === undefined) return undefined
  const i = id.indexOf(SEP)
  return i > 0 ? { engine: id.slice(0, i), name: id.slice(i + 1) } : undefined
}

/** The profiles of `create.options` as the card's items: agents by engine, the shells for "Terminal". */
export function itemsOf(o: CreateOptions): CreateItem[] {
  return o.profiles.map(p => ({
    id: profileIdOf(p.engine, p.name), kind: 'profile' as const, group: p.engine, name: p.name, engine: p.engine,
    icon: p.engine === 'shell' ? 'terminal-window' : 'robot', needsFolder: true, ...(p.default ? { default: true } : {}),
    ...(p.unsafe ? { unsafe: true } : {}),
  }))
}

/**
 * Whether the agent of this engine and profile is born "sem restrições" (RR5 M-3): the profile of that name, or with none
 * the engine's default, as the app opens and badges it.
 */
export function unsafeChoice(o: CreateOptions, engine: string, profile: string | undefined): boolean {
  const p = o.profiles.find(x => x.engine === engine && (profile === undefined ? x.default === true : x.name === profile))
  return p?.unsafe === true
}

/** The folders the tether knows, projects first, as the card's list (the value is the tether's id; never a path). */
export function foldersOf(o: CreateOptions): { value: string; label: string; recent: boolean }[] {
  return [...o.folders.filter(f => f.kind === 'project'), ...o.folders.filter(f => f.kind === 'recent')].map(f => ({ value: f.id, label: f.label, recent: f.kind === 'recent' }))
}

/** The folder a new pane starts in when the person chose none: the first project the tether knows. */
export const defaultFolderOf = (o: CreateOptions): string | undefined => o.folders.find(f => f.kind === 'project')?.id

/** One act of the plan as the portal takes it, or why it cannot go (the person's words). */
export type AfarCall = { op: OpName; body: Record<string, unknown> } | { error: string }

const tooLong = (what: string): { error: string } => ({ error: `${what} passa de ${CREATE_NAME_MAX} letras` })

/**
 * The op and the body of an act of the plan (create-rules.ts CreateAct), with the portal's ceilings checked here first.
 * `join` is one call per agent (the caller runs them in order). What only the machine's screen does (`show`, `give`,
 * `move`) has no op: the caller does `show` itself, and the card from afar never plans the others.
 */
export function callsOf(act: CreateAct): AfarCall[] { return callsWith(act, undefined) }

/** callsOf with the choices of `create.options`: an agent "sem restrições" (unsafeChoice) is `create.agent-unrestricted`, proven per act. */
export function callsWith(act: CreateAct, options: CreateOptions | undefined): AfarCall[] {
  switch (act.act) {
    case 'desk': {
      if (act.name.length > CREATE_NAME_MAX) return [tooLong('O nome da mesa')]
      const color = (DESK_COLORS as readonly string[]).includes(act.color ?? '') ? act.color! : 'blue'
      return [{ op: 'desks.create', body: { name: act.name, color } }]
    }
    case 'slot': {
      if (!FOLDER_ID_RE.test(act.cwd)) return [{ error: 'Escolha a pasta na lista do tether' }]
      if ((act.name ?? '').length > CREATE_NAME_MAX) return [tooLong('O nome')]
      const profile = profileOfId(act.profileId)
      const named = { deskId: act.deskId, folder: act.cwd, ...(profile ? { profile: profile.name } : {}), ...(act.name ? { name: act.name } : {}) }
      if (act.kind === 'shell') return [{ op: 'create.terminal', body: named }]
      const unrestricted = options !== undefined && unsafeChoice(options, act.kind, profile?.name)
      return [{ op: unrestricted ? 'create.agent-unrestricted' : 'create.agent', body: { engine: act.kind, ...named } }]
    }
    case 'item':
      if (!FOLDER_ID_RE.test(act.cwd)) return [{ error: 'Escolha a pasta na lista do tether' }]
      return [{ op: 'create.note', body: { deskId: act.deskId, folder: act.cwd } }]
    case 'browser': return [{ op: 'create.browser', body: { deskId: act.deskId } }]
    case 'channel': return [{ op: 'channels.create', body: { name: act.name } }]
    case 'join': return act.agents.map(agent => ({ op: 'channels.join' as const, body: { channel: act.channel, agent } }))
    default: return [{ error: 'Isso se faz na máquina' }]
  }
}
