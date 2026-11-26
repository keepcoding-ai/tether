// The rules of the Regency's "Sistema" column, pure: the model of its five sections (Processos, Ronda, Perfis, Projetos, Ajustes),
// the red dot (`systemDot`), the Portuguese sentences of each state and each refusal, a stable order and a signature to repaint
// only on a change. No DOM, no `ui`, nothing from the app or the daemon but shapes: everything in and out is JSON (the app's
// screen paints it today; a remote interface reads the same model), so there are no classes, no functions inside the data and no
// `undefined` values (an absent field is an absent key). Time is an input (`now`), never read here.
//
// Secrets: the model never carries a value of an environment variable, of a process or of a profile. A profile shows the NAMES
// of its variables; a process card's `env` is not read at all.
import { foldText } from './model.ts'

export type SystemSection = 'processes' | 'ronda' | 'profiles' | 'projects' | 'settings'

export const SYSTEM_SECTIONS: readonly { id: SystemSection; label: string }[] = [
  { id: 'processes', label: 'Processos' },
  { id: 'ronda', label: 'Ronda' },
  { id: 'profiles', label: 'Perfis' },
  { id: 'projects', label: 'Projetos' },
  { id: 'settings', label: 'Ajustes' },
]

export const DEFAULT_SYSTEM_SECTION: SystemSection = 'processes'

export const isSystemSection = (x: unknown): x is SystemSection => SYSTEM_SECTIONS.some(s => s.id === x)

// ---------------------------------------------------------------- inputs (structural: the daemon's and the app's types fit)

export interface SystemAuthorInput { kind: 'agent' | 'shell' | 'app' | 'external'; name?: string; user?: string; label?: string }
export interface SystemUseInput { by: SystemAuthorInput; until: string; purpose: string }

/** The part of a `ProcState` the model reads. `card.env` is deliberately not here. */
export interface SystemProcInput {
  name: string
  status: 'running' | 'stopping' | 'stopped' | 'exited' | 'host-lost' | 'failed'
  card: { cwd: string; description?: string }
  pid?: number
  startedBy?: SystemAuthorInput
  exit?: { code?: number; at: string; cause: string }
  attention?: boolean
  error?: string
  ports?: { port: number; listening: boolean }[]
  uses?: SystemUseInput[]
  external?: boolean
}

export interface SystemAgentInput {
  id: string
  name: string
  /** The slot kind ('claude', 'codex', 'shell', ...). */
  kind: string
  alive: boolean
  profileId?: string
  ronda?: { intervalMs: number; nextAt: string; lastAt?: string; criterion?: string; due?: boolean; channel?: 'listening' | 'none' }
}

export interface SystemProfileInput {
  id: string
  name: string
  agent: string
  args?: string[]
  /** Read only for its keys. */
  env?: Record<string, string>
  default?: boolean
}

export interface SystemFolderInput { path: string; name: string; pinned: boolean; agents: readonly string[]; missing?: boolean }

/** The icons of the top bar (Bridge, Sync): the state is the sentence the extension gives. */
export interface SystemStatusInput { state?: string; badge?: string }

export interface SystemInput {
  now: number
  procs: readonly SystemProcInput[]
  agents: readonly SystemAgentInput[]
  profiles: readonly SystemProfileInput[]
  folders: readonly SystemFolderInput[]
  status?: { bridge?: SystemStatusInput; sync?: SystemStatusInput }
}

// ---------------------------------------------------------------- model

export interface ProcRow {
  name: string
  status: SystemProcInput['status']
  /** "Rodando", "Parado", "Caiu (código 1) há 4 min"... */
  stateText: string
  attention: boolean
  pid?: number
  ports: { port: number; listening: boolean }[]
  /** "Rodando em 3000, 5173 parada"... one phrase for the ports, absent without ports. */
  portsText?: string
  /** "Iniciado por Maria". */
  startedByText?: string
  uses: { byName: string; mine: boolean; untilText: string; purpose: string; text: string }[]
  /** What the person may do now. */
  can: { start: boolean; stop: boolean; restart: boolean; hold: boolean; release: boolean; log: boolean }
  cwd: string
}

export interface RondaRow {
  agentId: string
  name: string
  on: boolean
  intervalText?: string
  nextText?: string
  criterion?: string
  noChannel: boolean
  /** The whole line in one sentence. */
  text: string
  can: { on: boolean; remount: boolean; off: boolean }
}

export interface ProfileRow {
  id: string
  name: string
  engine: string
  isDefault: boolean
  users: number
  usersText: string
  /** The NAMES of the variables, sorted; never the values. */
  envNames: string[]
}

export interface ProjectRow {
  path: string
  name: string
  pinned: boolean
  missing: boolean
  agents: number
  procs: number
  text: string
  can: { agentHere: boolean; terminalHere: boolean; pin: boolean; unpin: boolean }
}

export type SettingsItem =
  | { id: 'settings' | 'extensions' | 'keybindings'; label: string; kind: 'screen'; screenType: string }
  | { id: 'bridge' | 'sync'; label: string; kind: 'status'; sentence: string; badge?: string }

/** `text`: the words shown beside the dot ("1 processo caiu"); `tooltip`: the same with the process's name when it is one. */
export interface SystemDot { show: boolean; count: number; text: string; tooltip: string; places: ('foot' | 'edge')[] }

export interface SystemSectionRow { id: SystemSection; label: string; count: number; dot: boolean }

export interface SystemModel {
  sections: SystemSectionRow[]
  processes: ProcRow[]
  ronda: RondaRow[]
  profiles: ProfileRow[]
  projects: ProjectRow[]
  settings: SettingsItem[]
  dot: SystemDot
  /** The foot of the Processos section. */
  procFoot: string
}

// ---------------------------------------------------------------- words

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byName = (a: string, b: string): number => cmp(foldText(a), foldText(b)) || cmp(a, b)

/** A span in words: "menos de 1 min", "5 min", "2 h", "3 d". */
export function spanWords(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000)
  if (min < 1) return 'menos de 1 min'
  if (min < 60) return `${min} min`
  if (min < 24 * 60) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 1440)} d`
}

export const agoWords = (iso: string, now: number): string => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : `há ${spanWords(now - t)}`
}

export const inWords = (iso: string, now: number): string => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : `em ${spanWords(t - now)}`
}

/** The interval as the ronda chip says it: "30 s", "20 min", "2 h". */
export function intervalWords(ms: number): string {
  if (ms % 60_000 !== 0) return `${Math.round(ms / 1000)} s`
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  return `${ms / 60_000} min`
}

export function authorName(a: SystemAuthorInput): string {
  if (a.kind === 'app') return 'Você'
  const n = a.name ?? a.label ?? a.user
  if (n !== undefined && n !== '') return n
  return a.kind === 'agent' ? 'um agente' : a.kind === 'shell' ? 'um terminal' : 'alguém de fora'
}

export function procStateText(p: SystemProcInput, now: number): string {
  switch (p.status) {
    case 'running': return 'Rodando'
    case 'stopping': return 'Parando…'
    case 'stopped': return 'Parado'
    case 'exited': {
      const code = p.exit?.code
      const when = p.exit !== undefined ? agoWords(p.exit.at, now) : ''
      const tail = when !== '' ? ` ${when}` : ''
      if (code === 0) return `Terminou (código 0)${tail}`
      return code !== undefined ? `Caiu (código ${code})${tail}` : `Caiu${tail}`
    }
    case 'host-lost': return 'Perdido: o servidor de processos caiu com ele'
    case 'failed': return p.error !== undefined && p.error !== '' ? `Não subiu: ${p.error}` : 'Não subiu'
  }
}

// ---------------------------------------------------------------- the model

const liveUses = (p: SystemProcInput, now: number): SystemUseInput[] =>
  (p.uses ?? []).filter(u => Date.parse(u.until) > now)

function procRow(p: SystemProcInput, now: number): ProcRow {
  const ports = (p.ports ?? []).map(x => ({ port: x.port, listening: x.listening }))
  const uses = liveUses(p, now).map(u => {
    const name = authorName(u.by)
    const untilText = `até ${inWords(u.until, now).replace(/^em /, 'daqui a ')}`
    return { byName: name, mine: u.by.kind === 'app', untilText, purpose: u.purpose, text: `${name} usa ${untilText}, para: ${u.purpose}` }
  })
  const ended = p.status === 'stopped' || p.status === 'exited' || p.status === 'host-lost' || p.status === 'failed'
  const row: ProcRow = {
    name: p.name, status: p.status, stateText: procStateText(p, now), attention: p.attention === true,
    ports, uses, cwd: p.card.cwd,
    can: {
      start: ended,
      stop: p.status === 'running',
      restart: p.status !== 'stopping',
      hold: p.status === 'running',
      release: uses.some(u => u.mine),
      log: p.external !== true,
    },
  }
  if (p.pid !== undefined && (p.status === 'running' || p.status === 'stopping')) row.pid = p.pid
  if (ports.length > 0) row.portsText = portsWords(ports, p.status)
  if (p.startedBy !== undefined) row.startedByText = `Iniciado por ${authorName(p.startedBy)}`
  return row
}

/**
 * The ports in words: "porta 3000", "portas 3000 e 5173". A port that does not answer is said only while the process runs
 * ("porta 3000 ainda sem resposta"): beside "Rodando" a word like "parada" would read as the process's state.
 */
export function portsWords(ports: readonly { port: number; listening: boolean }[], status: SystemProcInput['status']): string {
  const running = status === 'running'
  const silent = running ? ports.filter(p => !p.listening).map(p => p.port) : []
  const list = (ns: number[]): string => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} e ${ns[ns.length - 1]}`)
  const all = ports.map(p => p.port)
  const head = `${all.length === 1 ? 'porta' : 'portas'} ${list(all)}`
  if (silent.length === 0) return head
  if (silent.length === all.length) return `${head} ainda sem resposta`
  return `${head} (${list(silent)} ainda sem resposta)`
}

const procRank = (r: ProcRow): number => (r.attention ? 0 : r.status === 'running' || r.status === 'stopping' ? 1 : 2)

/** A row's colour by intent: running is ok, a fall or a failure is bad, stopping is a warning, the rest is quiet. */
export function procIntent(r: ProcRow): 'ok' | 'warn' | 'bad' | 'off' {
  if (r.status === 'running') return 'ok'
  if (r.status === 'stopping') return 'warn'
  if (r.attention || r.status === 'failed' || r.status === 'host-lost') return 'bad'
  if (r.status === 'exited' && !/código 0/.test(r.stateText)) return 'bad'
  return 'off'
}

/** The TV's rail of "Sistema" at a glance: each process with its state, the notice of a fall, the rondas that are on. */
export interface SystemSummary {
  procs: { name: string; state: string; intent: 'ok' | 'warn' | 'bad' | 'off' }[]
  /** "1 processo caiu" (the red dot's words), absent while nothing fell. */
  fell?: string
  /** The words when there is no process. */
  procsEmpty?: string
  rondas: { name: string; text: string }[]
  /** The words when no ronda is on. */
  rondasEmpty?: string
}

/** The summary from the model the sections paint (same order: what needs attention first). */
export function systemSummary(model: SystemModel): SystemSummary {
  const procs = model.processes.map(p => ({ name: p.name, state: p.stateText, intent: procIntent(p) }))
  const rondas = model.ronda.filter(r => r.on).map(r => ({ name: r.name, text: [r.intervalText, r.nextText ? `próxima ${r.nextText}` : undefined].filter(Boolean).join(' · ') }))
  return {
    procs,
    ...(model.dot.show ? { fell: model.dot.text } : {}),
    ...(procs.length === 0 ? { procsEmpty: 'Nenhum processo' } : {}),
    rondas,
    ...(rondas.length === 0 ? { rondasEmpty: 'Nenhuma ronda ligada' } : {}),
  }
}

/** Needs attention first, then the live ones, then the rest; by name inside each. */
export function procRowsOf(procs: readonly SystemProcInput[], now: number): ProcRow[] {
  return procs.map(p => procRow(p, now)).sort((a, b) => procRank(a) - procRank(b) || byName(a.name, b.name))
}

function rondaRow(a: SystemAgentInput, now: number): RondaRow {
  const r = a.ronda
  if (r === undefined) {
    return { agentId: a.id, name: a.name, on: false, noChannel: false, text: `${a.name}: sem ronda`, can: { on: true, remount: false, off: false } }
  }
  const noChannel = r.channel === 'none'
  const intervalText = `a cada ${intervalWords(r.intervalMs)}`
  const nextText = r.due === true ? 'assim que ficar parado' : noChannel ? 'espera o canal' : inWords(r.nextAt, now)
  const row: RondaRow = {
    agentId: a.id, name: a.name, on: true, intervalText, nextText, noChannel, text: '',
    can: { on: false, remount: true, off: true },
  }
  if (r.criterion !== undefined && r.criterion !== '') row.criterion = r.criterion
  const parts = [`${a.name}: ronda ${intervalText}`, `próxima ${nextText}`]
  if (noChannel) parts.push('sem canal')
  if (row.criterion !== undefined) parts.push(`critério: ${row.criterion}`)
  row.text = parts.join(' · ')
  return row
}

/** One line per living agent: rondas on first, then by name. */
export function rondaRowsOf(agents: readonly SystemAgentInput[], now: number): RondaRow[] {
  return agents.filter(a => a.alive).map(a => rondaRow(a, now))
    .sort((a, b) => Number(b.on) - Number(a.on) || byName(a.name, b.name) || cmp(a.agentId, b.agentId))
}

const ENGINE_LABELS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', shell: 'Terminal', soul: 'Soul' }
export const engineLabel = (agent: string): string => ENGINE_LABELS[agent] ?? agent

export function profileRowsOf(profiles: readonly SystemProfileInput[], agents: readonly SystemAgentInput[]): ProfileRow[] {
  const used = new Map<string, number>()
  for (const a of agents) if (a.profileId !== undefined) used.set(a.profileId, (used.get(a.profileId) ?? 0) + 1)
  // "Nenhum agente usa" informs only beside a profile that is used: when none is, no line says it (usersText '').
  const anyUsed = profiles.some(p => (used.get(p.id) ?? 0) > 0)
  return profiles.map((p): ProfileRow => {
    const users = used.get(p.id) ?? 0
    return {
      id: p.id, name: p.name, engine: engineLabel(p.agent), isDefault: p.default === true, users,
      usersText: users === 0 ? (anyUsed ? 'Nenhum agente usa' : '') : users === 1 ? '1 agente usa' : `${users} agentes usam`,
      envNames: Object.keys(p.env ?? {}).sort(cmp),
    }
  }).sort((a, b) => cmp(a.engine, b.engine) || Number(b.isDefault) - Number(a.isDefault) || byName(a.name, b.name) || cmp(a.id, b.id))
}

/** A path as a comparison key: separators and case folded (Windows), no trailing slash. */
const pathKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function projectRowsOf(folders: readonly SystemFolderInput[], procs: readonly SystemProcInput[]): ProjectRow[] {
  const cwds = procs.map(p => pathKey(p.card.cwd))
  return folders.map((f): ProjectRow => {
    const k = pathKey(f.path)
    const procCount = cwds.filter(c => c === k || c.startsWith(`${k}/`)).length
    const missing = f.missing === true
    return {
      path: f.path, name: f.name, pinned: f.pinned, missing, agents: f.agents.length, procs: procCount,
      text: `${plural(f.agents.length, 'guia', 'guias')} · ${plural(procCount, 'processo', 'processos')}${missing ? ' · a pasta não existe mais' : ''}`,
      can: { agentHere: !missing, terminalHere: !missing, pin: !f.pinned, unpin: f.pinned },
    }
  }).map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.pinned) - Number(a.r.pinned) || a.i - b.i).map(x => x.r)
}

export const SETTINGS_SCREENS: readonly { id: 'settings' | 'extensions' | 'keybindings'; label: string; screenType: string }[] = [
  { id: 'settings', label: 'Configurações', screenType: 'settings' },
  { id: 'extensions', label: 'Extensões', screenType: 'extensions' },
  { id: 'keybindings', label: 'Atalhos', screenType: 'keybindings' },
]

const oneSentence = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

export function settingsOf(status: SystemInput['status']): SettingsItem[] {
  const icon = (id: 'bridge' | 'sync', label: string): SettingsItem => {
    const s = status?.[id]
    const sentence = s?.state !== undefined && s.state.trim() !== '' ? oneSentence(s.state) : 'Sem informação agora'
    return { id, label, kind: 'status', sentence, ...(s?.badge !== undefined && s.badge !== '' ? { badge: s.badge } : {}) }
  }
  return [
    ...SETTINGS_SCREENS.map((x): SettingsItem => ({ id: x.id, label: x.label, kind: 'screen', screenType: x.screenType })),
    icon('bridge', 'Bridge'), icon('sync', 'Sync'),
  ]
}

// ---------------------------------------------------------------- the dot

/**
 * The red dot: a process that fell or asks for attention (the daemon's `attention` mark, the same as the pad's badge). It shows on
 * the foot "Sistema" and on the immersion's edge, never on the Regency's pill (that one carries the orange of "esperam você").
 */
export function systemDot(input: { procs: readonly { name: string; attention?: boolean; status?: SystemProcInput['status'] }[] }): SystemDot {
  const marked = input.procs.filter(p => p.attention === true)
  const count = marked.length
  const text = dotText(marked)
  const tooltip = count === 0 ? ''
    : count === 1 ? `O processo "${marked[0]!.name}" ${isDown(marked[0]!.status) ? 'caiu' : 'pede atenção'}`
      : text
  return { show: count > 0, count, text, tooltip, places: count > 0 ? ['foot', 'edge'] : [] }
}

/** A marked process that is down (it fell, did not start, or was lost with the process server). */
const isDown = (status: SystemProcInput['status'] | undefined): boolean => status === 'exited' || status === 'failed' || status === 'host-lost'

/**
 * The words beside the red dot, everywhere the Regency shows it: "1 processo caiu", "2 processos caíram"; a mark on a process
 * that is not down says "pede atenção". '' when none is marked.
 */
export function dotText(marked: readonly { status?: SystemProcInput['status'] }[]): string {
  const n = marked.length
  if (n === 0) return ''
  if (marked.every(p => isDown(p.status))) return n === 1 ? '1 processo caiu' : `${n} processos caíram`
  return n === 1 ? '1 processo pede atenção' : `${n} processos pedem atenção`
}

export const procFootText = (procs: readonly SystemProcInput[]): string => {
  const marked = procs.filter(p => p.attention === true)
  if (marked.length > 0) return dotText(marked)
  const running = procs.filter(p => p.status === 'running').length
  return procs.length === 0 ? 'Nenhum processo' : `${running} rodando de ${procs.length}`
}

export function systemModelOf(input: SystemInput): SystemModel {
  const processes = procRowsOf(input.procs, input.now)
  const ronda = rondaRowsOf(input.agents, input.now)
  const profiles = profileRowsOf(input.profiles, input.agents)
  const projects = projectRowsOf(input.folders, input.procs)
  const settings = settingsOf(input.status)
  const dot = systemDot({ procs: input.procs })
  const counts: Record<SystemSection, number> = {
    processes: processes.length, ronda: ronda.filter(r => r.on).length, profiles: profiles.length, projects: projects.length, settings: settings.length,
  }
  return {
    sections: SYSTEM_SECTIONS.map(s => ({ id: s.id, label: s.label, count: counts[s.id], dot: s.id === 'processes' && dot.show })),
    processes, ronda, profiles, projects, settings, dot, procFoot: procFootText(input.procs),
  }
}

/** Equal models give equal signatures (the builders write keys in a fixed order): the screen repaints only on a change. */
export const systemSignature = (model: SystemModel): string => JSON.stringify(model)

// ---------------------------------------------------------------- refusals

export type GuardedProcAct = 'stop' | 'restart' | 'forget'
const ACT_VERB: Readonly<Record<GuardedProcAct, string>> = { stop: 'parar', restart: 'reiniciar', forget: 'esquecer' }
export const MAX_FORCE_REASON = 200
/** The daemon holds an act for at most this long (`waitMs`). */
export const MAX_WAIT_MS = 5 * 60_000

export interface InUseExit { id: 'wait' | 'force' | 'cancel'; label: string; hint: string; needsReason?: boolean; waitMs?: number }
export interface InUseRefusal { sentence: string; lines: string[]; exits: InUseExit[] }

/**
 * "In use by another": who uses it, until when and for what, and the three ways out: wait, force with a reason, cancel.
 * `undefined` when nobody uses it (nothing to refuse).
 */
export function inUseRefusal(proc: Pick<SystemProcInput, 'name' | 'uses'>, act: GuardedProcAct, now: number): InUseRefusal | undefined {
  const uses = (proc.uses ?? []).filter(u => Date.parse(u.until) > now)
  if (uses.length === 0) return undefined
  const lines = uses.map(u => `${authorName(u.by)} usa até daqui a ${spanWords(Date.parse(u.until) - now)}, para: ${u.purpose}`)
  const last = Math.max(...uses.map(u => Date.parse(u.until)))
  const waitMs = Math.min(Math.max(0, last - now), MAX_WAIT_MS)
  return {
    sentence: `Não dá para ${ACT_VERB[act]} "${proc.name}" agora: ${uses.length === 1 ? 'outro o usa' : `${uses.length} o usam`}.`,
    lines,
    exits: [
      { id: 'wait', label: 'Esperar', hint: `Segura o pedido até acabar o uso (no máximo ${spanWords(MAX_WAIT_MS)}).`, waitMs },
      { id: 'force', label: 'Forçar', hint: 'Passa por cima de quem usa; fica registrado com o seu motivo.', needsReason: true },
      { id: 'cancel', label: 'Cancelar', hint: 'Não faz nada.' },
    ],
  }
}

/** Why "Forçar" cannot go yet (a sentence), or `undefined` when the reason is good. */
export function forceReasonError(reason: string): string | undefined {
  const r = reason.trim()
  if (r === '') return 'Diga o motivo para forçar.'
  if (r.length > MAX_FORCE_REASON) return `O motivo passa de ${MAX_FORCE_REASON} letras.`
  return undefined
}

/** The sentence of a refusal by the daemon's error code; `message` is the daemon's own words, used when it adds something. */
export function refusalText(code: string, message?: string): string {
  const extra = message !== undefined && message.trim() !== '' ? oneSentence(message) : ''
  switch (code) {
    case 'ronda-unavailable': return extra !== '' ? `Este agente não ouve a ronda: ${extra}` : 'Este agente não ouve a ronda.'
    case 'ronda-criterion': return 'Esta ronda tem um critério de parada: confirme para desligar assim mesmo.'
    case 'proc-in-use': return 'O processo está em uso por outro.'
    case 'unknown-proc': return 'Esse processo não existe mais.'
    case 'proc-running': return 'O processo já está rodando.'
    case 'proc-not-stopped': return 'O processo precisa estar parado antes.'
    case 'proc-host': return 'O servidor de processos não respondeu.'
    case 'port-busy': return 'Uma porta do processo está ocupada por outro.'
    case 'bad-request': return extra !== '' ? `Pedido inválido: ${extra}` : 'Pedido inválido.'
    default: return extra !== '' ? extra : 'Não deu certo.'
  }
}
