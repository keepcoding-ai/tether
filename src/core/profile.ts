// Launch profiles: a named set of args/env for an agent ("Claude", "Claude modo dev", "soul", "PowerShell"),
// kept in <home>/profiles.json. A slot references a profile by id (SlotMeta.profileId) and keeps a snapshot of
// its args/env (profileArgs/profileEnv) for the day the profile is deleted; while the profile exists, every
// launch (new session or resume) applies the profile as it is NOW, so an edit takes effect on the next start.
// Validation refuses whatever tether itself puts on the command line (session choice, settings, fork) and the
// env vars that carry the slot's identity. Reads are tolerant: a corrupt file is copied aside, never lost.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultShell } from '../agents/shell.ts'
import type { AgentName, SlotMeta } from './event.ts'
import { agentChoices, agentRegistry, isAgentName } from '../agents/registry.ts'
import '../agents/load.ts'

export type ProfileAgent = AgentName | 'shell'

export interface ShellCommand {
  /** The executable (absolute path or a name found on PATH). */
  command: string
  args: string[]
}

export interface Profile {
  /** Stable slug, derived from the name at creation and never changed by a rename. */
  id: string
  name: string
  agent: ProfileAgent
  /** Args added to every launch, before the slot's own args. For a shell profile: args after the shell's own. */
  args: string[]
  /** Env vars added to the launch (claude: after the CLAUDE* strip, so an explicit CLAUDE_CONFIG_DIR survives). */
  env?: Record<string, string>
  /** Folder suggested for new slots of this profile. */
  cwd?: string
  /** Shell profiles: the executable and its args (absent = tether's default shell). */
  shell?: ShellCommand
  /** The profile new slots of this agent get when none is chosen (at most one per agent). */
  default?: boolean
  /**
   * Per-extension options of this profile, by extension id (`extensions.browser.serveToAgents`). Opaque to the core: each
   * extension reads and validates its own keys; the editor writes what the extensions' `profiles.registerOption` declare.
   */
  extensions?: Record<string, Record<string, unknown>>
}

/** What a client sends to create or edit a profile: the id is optional (absent = new profile, derived from the name). */
export type ProfileInput = Omit<Profile, 'id'> & { id?: string }

export interface ProfilesFile {
  v: 1
  profiles: Profile[]
}

export interface ProfilesRead {
  profiles: Profile[]
  /** Something was wrong with the file (it was never silently dropped: see `backup`). Portuguese, for the user. */
  problem?: string
  /** Where the unusable file was copied to. */
  backup?: string
}

/** What a profile adds to one launch (the shape the adapters take). */
export interface ProfileLaunch {
  args: string[]
  env?: Record<string, string>
}

export const UNSAFE_ARG = '--dangerously-skip-permissions'

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export function profilesPath(home: string): string {
  return join(home, 'profiles.json')
}

// ---- defaults ------------------------------------------------------------

/** Git for Windows' bash, where its installer puts it (the profile exists only when the file does). */
export function gitBashPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
}

export function defaultProfiles(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Profile[] {
  // Each registered agent brings its own (claude, claude-dev and soul from the built-ins); the shells are the core's.
  const out: Profile[] = agentRegistry.all().flatMap((a) => a.defaultProfiles(env, platform))
  const shell = defaultShell(env, platform)
  if (platform === 'win32') {
    out.push({ id: 'powershell', name: 'PowerShell', agent: 'shell', args: [], shell, default: true })
    const bash = gitBashPath(env)
    if (existsSync(bash)) out.push({ id: 'git-bash', name: 'Git Bash', agent: 'shell', args: [], shell: { command: bash, args: ['--login', '-i'] } })
  } else {
    out.push({ id: 'shell', name: 'Shell', agent: 'shell', args: [], shell, default: true })
  }
  return out
}

// ---- reading and writing the file ----------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((a) => typeof a === 'string')
}

function isStringMap(x: unknown): x is Record<string, string> {
  return isObject(x) && Object.values(x).every((v) => typeof v === 'string')
}

function isExtensionsMap(x: unknown): x is Record<string, Record<string, unknown>> {
  return isObject(x) && Object.values(x).every(isObject)
}

/** One option a profile carries for an extension (undefined = unset). */
export function profileOption(p: Profile | undefined, extensionId: string, key: string): unknown {
  return p?.extensions?.[extensionId]?.[key]
}

export function isProfileAgent(x: unknown): x is ProfileAgent {
  return x === 'shell' || isAgentName(x)
}

/** Shape check only (validateProfile judges the content). */
export function isProfile(x: unknown): x is Profile {
  if (!isObject(x)) return false
  if (typeof x.id !== 'string' || typeof x.name !== 'string' || !isProfileAgent(x.agent) || !isStringArray(x.args)) return false
  if (x.env !== undefined && !isStringMap(x.env)) return false
  if (x.cwd !== undefined && typeof x.cwd !== 'string') return false
  if (x.default !== undefined && typeof x.default !== 'boolean') return false
  if (x.extensions !== undefined && !isExtensionsMap(x.extensions)) return false
  if (x.shell !== undefined && !(isObject(x.shell) && typeof x.shell.command === 'string' && isStringArray(x.shell.args))) return false
  return true
}

/** Parses the file's text: ok with the well-formed profiles (malformed entries listed in `skipped`), or the reason it is unusable. */
export function parseProfilesFile(text: string): { ok: true; profiles: Profile[]; skipped: number } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${(e as Error).message}` }
  }
  if (!isObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.profiles)) return { ok: false, error: 'formato desconhecido (esperado {"v":1,"profiles":[...]})' }
  const profiles: Profile[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const entry of parsed.profiles) {
    if (!isProfile(entry) || seen.has(entry.id)) { skipped++; continue }
    seen.add(entry.id)
    profiles.push(entry)
  }
  return { ok: true, profiles, skipped }
}

/** Atomic: the whole file goes to a temp name first, then replaces the old one. */
export function writeProfiles(home: string, profiles: Profile[]): void {
  const path = profilesPath(home)
  mkdirSync(home, { recursive: true })
  const file: ProfilesFile = { v: 1, profiles }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n')
  renameSync(tmp, path)
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * The profiles on disk. A missing file is created with the defaults. A file that cannot be parsed is copied to
 * `profiles.json.corrompido-<time>` and replaced by the defaults (the copy fails → nothing is overwritten and the
 * defaults are used in memory only); either way `problem` says what happened, for the CLI/app to show.
 */
export function readProfiles(home: string): ProfilesRead {
  const path = profilesPath(home)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { profiles: defaultProfiles(), problem: `não consegui ler ${path} (${(e as Error).message}); usando os perfis padrão` }
    }
    const profiles = defaultProfiles()
    try { writeProfiles(home, profiles) } catch { /* read-only home: the defaults still work in memory */ }
    return { profiles }
  }
  const parsed = parseProfilesFile(text)
  if (parsed.ok) {
    if (parsed.skipped === 0) return { profiles: parsed.profiles }
    return { profiles: parsed.profiles, problem: `${path}: ${parsed.skipped} perfil(is) malformado(s) ignorado(s)` }
  }
  const backup = `${path}.corrompido-${stamp()}`
  try {
    copyFileSync(path, backup)
  } catch (e) {
    return { profiles: defaultProfiles(), problem: `${path} está inválido (${parsed.error}) e não consegui guardar uma cópia (${(e as Error).message}); usando os perfis padrão sem gravar` }
  }
  const profiles = defaultProfiles()
  writeProfiles(home, profiles)
  return { profiles, backup, problem: `${path} estava inválido (${parsed.error}); cópia guardada em ${backup}; perfis padrão recriados` }
}

// ---- validation ----------------------------------------------------------

export interface Validation {
  errors: string[]
  warnings: string[]
}

function reservedReason(agent: AgentName, arg: string): string | undefined {
  // Args tether decides per launch (AgentContribution.reservedArgs); matched as `--flag` and `--flag=value`.
  const table = agentRegistry.get(agent)?.reservedArgs ?? {}
  for (const [flag, reason] of Object.entries(table)) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return reason
  }
  return undefined
}

/** Env vars tether sets for the slot (claude's CLAUDE* are warned about, not refused: CLAUDE_CONFIG_DIR is a legitimate use). */
function reservedEnvReason(key: string): string | undefined {
  if (/^TETHER_/i.test(key)) return 'as variáveis TETHER_* identificam o slot para o tether'
  if (key === 'SOUL_SESSION_REPORT') return 'é por ela que o soul reporta a sessão ao tether'
  return undefined
}

export function validateProfile(p: ProfileInput): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  if (typeof p.name !== 'string' || !p.name.trim()) errors.push('o perfil precisa de um nome')
  // Saving consults the registry (reading profiles.json does not: a profile of an agent whose extension is off is kept).
  if (!isProfileAgent(p.agent) || (p.agent !== 'shell' && !agentRegistry.has(p.agent))) errors.push(`agente inválido: ${String(p.agent)} (use ${agentChoices()})`)
  if (p.id !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) errors.push(`id inválido: ${JSON.stringify(p.id)}`)
  if (!isStringArray(p.args)) errors.push('args precisa ser uma lista de textos')
  else if (p.agent !== 'shell' && isProfileAgent(p.agent)) {
    for (const arg of p.args) {
      const reason = reservedReason(p.agent, arg)
      if (reason) errors.push(`o argumento ${arg} não pode ficar no perfil: ${reason}`)
    }
  }
  if (p.env !== undefined) {
    if (!isStringMap(p.env)) errors.push('env precisa ser um mapa de texto para texto')
    else {
      for (const key of Object.keys(p.env)) {
        if (!key || /[=\s]/.test(key)) { errors.push(`nome de variável inválido: ${JSON.stringify(key)}`); continue }
        const reason = reservedEnvReason(key)
        if (reason) errors.push(`a variável ${key} não pode ficar no perfil: ${reason}`)
        else if (/^claude/i.test(key) && key !== 'CLAUDE_CONFIG_DIR') {
          warnings.push(`a variável ${key} pode impedir o Claude de gravar o transcript (o tether remove as CLAUDE* herdadas por isso)`)
        }
      }
    }
  }
  if (p.cwd !== undefined && typeof p.cwd !== 'string') errors.push('cwd precisa ser um texto')
  if (p.shell !== undefined) {
    if (p.agent !== 'shell') errors.push('shell só vale para perfis de shell')
    else if (!isObject(p.shell) || typeof p.shell.command !== 'string' || !p.shell.command.trim() || !isStringArray(p.shell.args)) {
      errors.push('shell precisa de um executável (command) e uma lista de args')
    }
  }
  if (p.default !== undefined && typeof p.default !== 'boolean') errors.push('default precisa ser true ou false')
  if (p.extensions !== undefined && !isExtensionsMap(p.extensions)) errors.push('extensions precisa ser um mapa de extensão para opções')
  return { errors, warnings }
}

// ---- ids -----------------------------------------------------------------

/** "Claude modo dev" → "claude-modo-dev" (accents dropped, anything else becomes '-'). */
export function slugify(name: string): string {
  const s = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 48) || 'perfil'
}

export function uniqueId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugify(name)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!used.has(id)) return id
  }
}

// ---- editing (pure, on a list) -------------------------------------------

function normalize(p: ProfileInput, id: string): Profile {
  const out: Profile = { id, name: p.name.trim(), agent: p.agent, args: [...p.args] }
  if (p.env && Object.keys(p.env).length) out.env = { ...p.env }
  if (p.cwd?.trim()) out.cwd = p.cwd.trim()
  if (p.shell && p.agent === 'shell') out.shell = { command: p.shell.command.trim(), args: [...p.shell.args] }
  if (p.default) out.default = true
  const ext = Object.entries(p.extensions ?? {}).filter(([, v]) => Object.keys(v).length)
  if (ext.length) out.extensions = Object.fromEntries(ext.map(([k, v]) => [k, { ...v }]))
  return out
}

/**
 * Inserts or replaces a profile in the list (by id; a missing id is derived from the name). Names are unique
 * (case-insensitive: the CLI and the dialog pick profiles by name). A new default clears the agent's previous
 * one. Throws ProfileError with every validation error; returns the warnings.
 */
export function upsertProfile(profiles: Profile[], input: ProfileInput): { profiles: Profile[]; profile: Profile; warnings: string[] } {
  const { errors, warnings } = validateProfile(input)
  if (errors.length) throw new ProfileError(errors.join('\n'))
  const id = input.id ?? uniqueId(input.name, profiles.map((p) => p.id))
  const name = input.name.trim().toLowerCase()
  const clash = profiles.find((p) => p.id !== id && p.name.trim().toLowerCase() === name)
  if (clash) throw new ProfileError(`já existe um perfil chamado "${clash.name}" (${clash.id})`)
  const profile = normalize(input, id)
  const idx = profiles.findIndex((p) => p.id === id)
  const next = profiles.map((p) => {
    if (profile.default && p.default && p.agent === profile.agent && p.id !== id) {
      const { default: _wasDefault, ...rest } = p
      return rest
    }
    return p
  })
  if (idx >= 0) next[idx] = profile
  else next.push(profile)
  return { profiles: next, profile, warnings }
}

export function removeProfile(profiles: Profile[], id: string): Profile[] {
  if (!profiles.some((p) => p.id === id)) throw new ProfileError(`perfil não encontrado: ${id}`)
  return profiles.filter((p) => p.id !== id)
}

/** Exact id, then a unique name (case-insensitive). */
export function findProfile(profiles: Profile[], ref: string): Profile | undefined {
  const byId = profiles.find((p) => p.id === ref)
  if (byId) return byId
  const name = ref.trim().toLowerCase()
  const byName = profiles.filter((p) => p.name.trim().toLowerCase() === name)
  return byName.length === 1 ? byName[0] : undefined
}

export function defaultProfileFor(profiles: Profile[], agent: ProfileAgent): Profile | undefined {
  return profiles.find((p) => p.agent === agent && p.default)
}

// ---- applying a profile to a slot ----------------------------------------

/** What the profile adds to a launch. A shell profile puts the shell first: the shell adapter reads args[0] as the executable. */
export function launchOf(p: Profile): ProfileLaunch {
  const args = p.agent === 'shell' && p.shell ? [p.shell.command, ...p.shell.args, ...p.args] : [...p.args]
  return p.env && Object.keys(p.env).length ? { args, env: { ...p.env } } : { args }
}

export interface SlotProfile {
  id?: string
  /** The current name; absent when the slot has no profile or its profile is gone. */
  name?: string
  launch?: ProfileLaunch
  /** The slot references a profile that no longer exists: `launch` is the snapshot taken when it last ran. */
  missing: boolean
}

/** The slot's profile as it applies to a launch now: the current profile while it exists, else the snapshot. */
export function slotProfile(meta: SlotMeta, profiles: Profile[]): SlotProfile {
  if (!meta.profileId) return { missing: false }
  const p = profiles.find((x) => x.id === meta.profileId)
  if (p) return { id: p.id, name: p.name, launch: launchOf(p), missing: false }
  const launch: ProfileLaunch = { args: meta.profileArgs ?? [] }
  if (meta.profileEnv && Object.keys(meta.profileEnv).length) launch.env = { ...meta.profileEnv }
  return { id: meta.profileId, launch, missing: true }
}

/** Records the profile on the slot (id + snapshot). Returns true when something changed. */
export function snapshotProfile(meta: SlotMeta, p: Profile): boolean {
  const launch = launchOf(p)
  const before = JSON.stringify([meta.profileId, meta.profileArgs, meta.profileEnv])
  meta.profileId = p.id
  meta.profileArgs = launch.args
  if (launch.env) meta.profileEnv = launch.env
  else delete meta.profileEnv
  return JSON.stringify([meta.profileId, meta.profileArgs, meta.profileEnv]) !== before
}

/** The launch skips Claude's permission prompts: the UI shows a badge for it. */
export function isUnsafe(args: string[]): boolean {
  return args.includes(UNSAFE_ARG)
}

// ---- a store with a cache keyed on the file's stat --------------------------

function statKey(path: string): string {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'missing'
  }
}

/** The profiles file as tetherd sees it: re-read whenever it changed on disk (the CLI may edit it while tetherd runs). */
export class ProfileStore {
  readonly home: string
  private cache: { key: string; read: ProfilesRead } | undefined

  constructor(home: string) {
    this.home = home
  }

  read(): ProfilesRead {
    const path = profilesPath(this.home)
    const key = statKey(path)
    if (this.cache && this.cache.key === key) return this.cache.read
    const read = readProfiles(this.home)
    this.cache = { key: statKey(path), read }
    return read
  }

  profiles(): Profile[] {
    return this.read().profiles
  }

  save(input: ProfileInput): { profile: Profile; warnings: string[] } {
    const { profiles, profile, warnings } = upsertProfile(this.profiles(), input)
    writeProfiles(this.home, profiles)
    this.cache = undefined
    return { profile, warnings }
  }

  delete(id: string): void {
    writeProfiles(this.home, removeProfile(this.profiles(), id))
    this.cache = undefined
  }
}
