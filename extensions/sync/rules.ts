// The sync extension's pure rules (no DOM, no fs; unit-tested in test/unit/ext.sync-rules.test.ts): what the status icon
// shows (visible, state, tooltip), what the popover says, when each palette command serves, what a typed remote must look
// like, when the tray carries a notice, and the `tether doctor` line. Read by all three hosts.
import type { DialogSpec } from '../../app/shared/dialog.ts'

/** The engine's report as the CLI prints it (src/core/sync/engine.ts SyncReport), every field optional: it crosses a process. */
export interface SyncReportShape {
  connect?: { remoteEmpty?: boolean }
  applied?: Partial<Record<string, boolean>>
  written?: string[]
  removed?: string[]
  pushed?: boolean
  behind?: boolean
  conflicts?: { path: string; trashed: boolean }[]
  pending?: { slotId: string; place: string }[]
  unmappedPlaces?: string[]
  missingEnv?: Record<string, string[]>
  arrivedDesks?: string[]
}

/** The last cycle (the runner's, else <home>/sync-last.json). */
export interface SyncLastView {
  at: string
  ok: boolean
  error?: { code: string; message: string }
  report: SyncReportShape | null
}

/** What main sends the renderer: no credential ever (the remote is masked). */
export interface SyncView {
  /** <home>/sync.json exists. */
  connected: boolean
  /** A cycle (or a connect) is running now. */
  running: boolean
  /** The remote, credentials masked. */
  remote?: string
  machine?: string
  last: SyncLastView | null
  /** Where a conflict's local version went (<home>/sync-trash). */
  trashDir?: string
  /** Profile id → name, for the missing env line. */
  profileNames?: Record<string, string>
}

export type SyncStatusState = 'idle' | 'normal' | 'busy' | 'warn' | 'error'

export const EMPTY_VIEW: SyncView = { connected: false, running: false, last: null }

/** Credentials in any URL become `***` (the same rule as src/core/sync/providers/git.ts maskUrl; main must not import the engine). */
export function maskUrl(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1***@')
}

// ---- the status icon ----

/** The icon is on the bar only while there is a link (or a connect is running): a function that is off takes no room. */
export const statusVisible = (v: SyncView): boolean => v.connected || v.running

/** Errors the person must act on (red); the rest come back on their own or are transient (amber). */
const PERSON_ERRORS = new Set(['auth', 'git-missing'])
const TRANSIENT_ERRORS = new Set(['network', 'timeout'])

export function errorTone(code: string | undefined): 'warn' | 'error' {
  return code !== undefined && TRANSIENT_ERRORS.has(code) ? 'warn' : 'error'
}

export function stateOf(v: SyncView): SyncStatusState {
  if (v.running) return 'busy'
  if (!v.connected) return 'idle'
  if (v.last && !v.last.ok) return errorTone(v.last.error?.code)
  return 'normal'
}

/** "agora", "há 8 s", "há 3 min", "há 2 h", "há 3 d". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 3) return 'agora'
  if (s < 60) return `há ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} d`
}

const atOf = (last: SyncLastView): number | undefined => { const t = Date.parse(last.at); return Number.isFinite(t) ? t : undefined }

export function titleOf(v: SyncView, now: number): string {
  if (v.running) return v.connected ? 'Sincronização: sincronizando…' : 'Sincronização: conectando…'
  if (!v.connected) return 'Sincronização: desligada'
  if (!v.last) return 'Sincronização: conectada'
  const at = atOf(v.last)
  const when = at === undefined ? '' : ` ${ago(at, now)}`
  return v.last.ok ? `Sincronização: em dia (última${when})` : `Sincronização: falhou${when}: ${maskUrl(v.last.error?.message ?? 'erro desconhecido')}`
}

// ---- the popover ----

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const APPLIED_WORDS: readonly [string, string][] = [['profiles', 'perfis'], ['layout', 'mesas'], ['slots', 'terminais'], ['settings', 'preferências'], ['keybindings', 'atalhos']]

/** "Chegou: perfis, mesas (2 novas) · Subiram 3 itens" in one line. */
export function headlineOf(r: SyncReportShape): string {
  const got: string[] = []
  for (const [key, word] of APPLIED_WORDS) {
    if (!r.applied?.[key]) continue
    const arrived = key === 'layout' ? r.arrivedDesks?.length ?? 0 : 0
    got.push(arrived ? `${word} (${plural(arrived, 'nova', 'novas')})` : word)
  }
  const arrivedText = got.length ? `Chegou: ${got.join(', ')}` : 'Nada novo chegou'
  const sent = (r.written?.length ?? 0) + (r.removed?.length ?? 0)
  const sentText = r.pushed ? (sent === 1 ? 'Subiu 1 item' : `Subiram ${plural(sent, 'item', 'itens')}`) : sent > 0 ? 'Nada subiu ainda' : 'Nada a enviar'
  const first = r.connect ? (r.connect.remoteEmpty ? 'Conectado: o remoto estava vazio e recebeu o seu perfil · ' : 'Conectado · ') : ''
  return `${first}${arrivedText} · ${sentText}`
}

export interface DetailLine { kind: 'conflict' | 'place' | 'env' | 'behind'; text: string }

/** What needs a look after a good cycle: conflicts (where the local version went), places without a folder, missing env. */
export function detailsOf(r: SyncReportShape, v: Pick<SyncView, 'trashDir' | 'profileNames'>): DetailLine[] {
  const out: DetailLine[] = []
  for (const c of r.conflicts ?? []) {
    out.push({ kind: 'conflict', text: `Conflito em ${c.path}: valeu a versão do remoto${c.trashed ? `; a sua ficou em ${v.trashDir ?? 'sync-trash'}` : ''}.` })
  }
  const places = [...new Set([...(r.pending ?? []).map(p => p.place), ...(r.unmappedPlaces ?? [])])]
  if (places.length) {
    const panes = r.pending?.length ?? 0
    out.push({ kind: 'place', text: `${places.length === 1 ? 'A pasta' : 'As pastas'} ${places.join(', ')} ${places.length === 1 ? 'não está mapeada' : 'não estão mapeadas'} nesta máquina${panes ? ` (${plural(panes, 'painel espera', 'painéis esperam')})` : ''}.` })
  }
  for (const [id, names] of Object.entries(r.missingEnv ?? {})) {
    if (names.length) out.push({ kind: 'env', text: `O perfil "${v.profileNames?.[id] ?? id}" precisa das variáveis de ambiente: ${names.join(', ')}.` })
  }
  if (r.behind) out.push({ kind: 'behind', text: 'O remoto continuou mudando durante o envio; sincronize de novo.' })
  return out
}

export interface PopoverModel {
  state: SyncStatusState
  remote: string
  machine: string
  /** "Última sincronização há 3 min", "Sincronizando…", "Ainda não sincronizou nesta máquina". */
  when: string
  /** The result in one line: what came, what went; or the failure's one line. */
  headline: string
  tone: 'ok' | 'warn' | 'error' | 'none'
  details: DetailLine[]
}

export function popoverOf(v: SyncView, now: number): PopoverModel {
  const state = stateOf(v)
  const base = { state, remote: v.remote ? maskUrl(v.remote) : '—', machine: v.machine ?? '—' }
  const at = v.last ? atOf(v.last) : undefined
  const lastWhen = at === undefined ? 'Ainda não sincronizou nesta máquina' : `Última sincronização ${ago(at, now)}`
  const when = v.running ? 'Sincronizando…' : lastWhen
  if (!v.last) return { ...base, when, headline: '', tone: 'none', details: [] }
  if (!v.last.ok) return { ...base, when, headline: maskUrl(v.last.error?.message ?? 'a sincronização falhou'), tone: errorTone(v.last.error?.code), details: [] }
  const r = v.last.report ?? {}
  const details = detailsOf(r, v)
  return { ...base, when, headline: headlineOf(r), tone: details.length ? 'warn' : 'ok', details }
}

// ---- the palette ----

/** "Conectar a um repositório…": only without a link (and not while one is being made). */
export const connectAvailable = (v: SyncView): boolean => !v.connected && !v.running
/** "Sincronizar agora": only with a link (a request during a cycle merges into the next one). */
export const nowAvailable = (v: SyncView): boolean => v.connected

/** Does the text look like a git remote: a URL (https, http, ssh, git, file) or scp-like `user@host:path`. No spaces. */
export function looksLikeGitUrl(text: string): boolean {
  const s = text.trim()
  // A leading '-' would reach the CLI as an option.
  if (!s || /\s/.test(s) || s.startsWith('-')) return false
  if (/^file:\/\/\/?.+/i.test(s)) return true
  if (/^(https?|ssh|git):\/\/([^/@]+@)?[a-z0-9.-]+(:\d+)?\/.+/i.test(s)) return true
  return /^[\w.-]+@[\w.-]+:.+$/.test(s)
}

/** Profile id → name from profiles.json's text (`{"v":1,"profiles":[...]}`); empty when unreadable. */
export function profileNamesOf(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (text === undefined) return out
  try {
    const doc = JSON.parse(text) as { profiles?: unknown }
    if (Array.isArray(doc.profiles)) {
      for (const p of doc.profiles as { id?: unknown; name?: unknown }[]) if (typeof p?.id === 'string' && typeof p.name === 'string') out[p.id] = p.name
    }
  } catch { /* the ids stand in */ }
  return out
}

/** The picker that asks for the remote (`ui.pick.list`): the row is made by the typed text. */
export const URL_PICK = { title: 'Conectar a um repositório', placeholder: 'Endereço do repositório git (https://… ou git@…:…)', empty: 'Cole o endereço de um repositório git vazio ou de outra máquina sua.' } as const

/** The row "Conectar a <url>"; a text that does not look like a remote says so under the row (and is refused if picked). */
export function urlRow(query: string): { value: string; label: string; icon: string; detail?: string } | undefined {
  const url = query.trim()
  if (!url) return undefined
  return { value: url, label: `Conectar a ${maskUrl(url)}`, icon: 'link', ...(looksLikeGitUrl(url) ? {} : { detail: 'Não parece um endereço git (https://, ssh://, git@servidor:caminho)' }) }
}

/** The dialog of a failed act: the CLI's one line. */
export function failedDialog(title: string, message: string): DialogSpec {
  return {
    situation: 'sync.failed', tone: 'warn', icon: 'warning', title, message: maskUrl(message),
    choices: [{ id: 'ok', icon: 'check', label: 'Entendi', consequence: 'Nada mais foi alterado.', tone: 'safe' }],
  }
}

/** "Desconectar…": the files stay, only the link goes. */
export function disconnectDialog(v: SyncView): DialogSpec {
  return {
    situation: 'sync.disconnect', tone: 'warn', icon: 'link-break', title: 'Desconectar a sincronização?',
    message: `Esta máquina deixa de sincronizar com ${v.remote ? maskUrl(v.remote) : 'o repositório'}. Os seus arquivos, perfis e mesas ficam como estão; só o vínculo sai.`,
    choices: [{ id: 'disconnect', icon: 'link-break', label: 'Desconectar', consequence: 'O vínculo sai; nada é apagado aqui nem no repositório.', tone: 'destructive' }],
    cancelLabel: 'Manter conectada',
  }
}

// ---- the tray ----

export type NoticeAction = { raise: string } | 'resolve' | 'keep'

/**
 * A notice only for what needs the person: authentication refused, git missing. A later good cycle (or the link gone)
 * resolves it; a network failure neither raises nor resolves (it comes back on its own).
 */
export function noticeAction(v: SyncView): NoticeAction {
  if (!v.connected) return 'resolve'
  if (!v.last || v.running) return 'keep'
  if (v.last.ok) return 'resolve'
  const code = v.last.error?.code
  if (code === 'auth') return { raise: 'Sincronização: o remoto recusou o acesso. Entre no git desta máquina (credencial ou chave SSH).' }
  if (code === 'git-missing') return { raise: 'Sincronização: o git não está instalado (ou não está no PATH).' }
  return 'keep'
}

// ---- tether doctor ----

export interface DoctorCheck { level: 'OK' | 'AVISO' | 'ERRO'; name: string; detail: string; hint?: string }

export const DOCTOR_NAME = 'sincronização'

const HINTS: Record<string, string> = {
  auth: 'entre no git desta máquina (credencial ou chave SSH) e rode: tether sync now',
  network: 'confira a conexão e a URL; o próximo ciclo tenta de novo (ou rode: tether sync now)',
  timeout: 'o remoto demorou demais; rode: tether sync now',
  'git-missing': 'instale o git e ponha-o no PATH',
}

/** The doctor's line from <home>/sync.json and <home>/sync-last.json (their text, undefined when absent) and git on PATH. */
export function doctorCheck(o: { configText: string | undefined; lastText: string | undefined; gitFound: boolean; now: number }): DoctorCheck {
  if (o.configText === undefined) return { level: 'OK', name: DOCTOR_NAME, detail: 'não configurada' }
  let cfg: { url?: unknown; machine?: unknown } = {}
  try { cfg = JSON.parse(o.configText) as typeof cfg } catch { /* shown as unreadable below */ }
  const remote = typeof cfg.url === 'string' ? maskUrl(cfg.url) : 'remoto ilegível em sync.json'
  const machine = typeof cfg.machine === 'string' ? ` como "${cfg.machine}"` : ''
  if (!o.gitFound) return { level: 'ERRO', name: DOCTOR_NAME, detail: `conectada a ${remote}, mas o git não está no PATH`, hint: HINTS['git-missing'] }
  let last: SyncLastView | undefined
  try { last = o.lastText === undefined ? undefined : JSON.parse(o.lastText) as SyncLastView } catch { last = undefined }
  if (!last || typeof last.ok !== 'boolean') return { level: 'OK', name: DOCTOR_NAME, detail: `conectada a ${remote}${machine}; nenhum ciclo registrado ainda` }
  const at = atOf(last)
  const when = at === undefined ? '' : ` ${ago(at, o.now)}`
  if (last.ok) return { level: 'OK', name: DOCTOR_NAME, detail: `conectada a ${remote}${machine}; última sincronização${when}` }
  const code = last.error?.code ?? 'error'
  return {
    level: 'AVISO', name: DOCTOR_NAME,
    detail: `o último ciclo falhou${when}: ${maskUrl(last.error?.message ?? 'erro desconhecido')}`,
    hint: HINTS[code] ?? 'rode: tether sync now (mostra o erro inteiro)',
  }
}
