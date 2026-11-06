// `tether doctor`: checks the machine the way tether will use it and prints one line per check, in Portuguese:
// OK / AVISO / ERRO plus a hint. The pure parts (`check*`, `formatReport`) take their facts as arguments so
// the unit tests cover them without a real node/claude/soul; `runDoctor` gathers the core's facts and runs the checks
// the daemon extensions contribute (TetherDaemon.doctor: claude's and soul's live in extensions/claude and
// extensions/soul, which call the probes below).
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { cleanEnv, resolveClaudeCommand } from './agents/claude.ts'
import { ENV_SOUL_REPORT, resolveSoulCommand } from './agents/soul.ts'
import { contributedChecks } from './agents/load.ts'
import { inspectRenamedNode, isNodeExecutable, type ExeStatus } from './core/exe.ts'
import { processStartTime, startTimeMethod, type StartTimeMethod } from './core/liveness.ts'
import { parseEventLine } from './core/store.ts'
import { tetherHome } from './core/paths.ts'
import { pingDaemon, type Hello } from './daemon/client.ts'
import { pipePath } from './daemon/protocol.ts'

export type Level = 'OK' | 'AVISO' | 'ERRO'

export interface CheckResult {
  level: Level
  /** What was checked, short ("node", "claude", "hook do claude"). */
  name: string
  /** The finding, one line. */
  detail: string
  /** How to fix it (AVISO/ERRO). */
  hint?: string
}

/** The reporter script. Read on use: Electron main bundles this module as CommonJS (through the claude extension), where import.meta.dirname is undefined. */
function hookPath(): string {
  return resolve(import.meta.dirname, 'report', 'claude-hook.mjs')
}
export const MIN_NODE_MAJOR = 24

// ---- pure checks ------------------------------------------------------------------------------

export function checkNode(version: string): CheckResult {
  const major = parseInt(version.replace(/^v/, ''), 10)
  if (Number.isNaN(major)) return { level: 'ERRO', name: 'node', detail: `versão irreconhecível: ${version}`, hint: `instale o Node ${MIN_NODE_MAJOR} ou mais novo` }
  if (major < MIN_NODE_MAJOR) return { level: 'ERRO', name: 'node', detail: `${version} (o tether precisa de ${MIN_NODE_MAJOR}+: roda .ts direto)`, hint: `instale o Node ${MIN_NODE_MAJOR} ou mais novo e ponha-o antes no PATH` }
  return { level: 'OK', name: 'node', detail: version }
}

/** `claude --version` prints "2.1.312 (Claude Code)". */
export function parseClaudeVersion(output: string | undefined): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output ?? '')?.[1]
}

export function checkClaude(command: string, found: boolean, versionOutput: string | undefined): CheckResult {
  if (!found) return { level: 'ERRO', name: 'claude', detail: 'não encontrado no PATH', hint: 'instale o Claude Code (npm i -g @anthropic-ai/claude-code) ou ponha o executável no PATH' }
  const version = parseClaudeVersion(versionOutput)
  if (!version) return { level: 'ERRO', name: 'claude', detail: `${command} não respondeu a --version`, hint: 'rode `claude --version` à mão e veja o erro' }
  return { level: 'OK', name: 'claude', detail: `${version} (${command})` }
}

export interface HookProbe {
  /** Lines the hook appended to <home>/slots/<slot>.jsonl. */
  lines: string[]
  sessionId: string
  slotId: string
  ms: number
  stdout: string
  exitCode: number | null
  /** `node` resolvable on PATH (the hook command Claude runs is `node "<script>" <event>`). */
  nodeOnPath: boolean
}

export function checkHook(p: HookProbe): CheckResult {
  const name = 'hook do claude'
  if (p.exitCode !== 0) return { level: 'ERRO', name, detail: `saiu com código ${p.exitCode}`, hint: `rode node "${hookPath()}" SessionStart à mão com um JSON no stdin` }
  if (p.stdout !== '') return { level: 'ERRO', name, detail: 'escreveu no stdout (vai parar no contexto do Claude)', hint: 'o hook só pode escrever no jsonl do slot' }
  const ev = p.lines.map(parseEventLine).find((e) => e !== undefined)
  if (!ev) return { level: 'ERRO', name, detail: 'rodou mas não gravou o evento no jsonl do slot', hint: 'veja <TETHER_HOME>/tether.log; o hook grava em <TETHER_HOME>/slots/<slot>.jsonl' }
  if (ev.sessionId !== p.sessionId || ev.slotId !== p.slotId) return { level: 'ERRO', name, detail: `gravou outro evento (sessão ${ev.sessionId}, slot ${ev.slotId})`, hint: 'o hook está desatualizado: confira src/report/claude-hook.mjs' }
  if (!p.nodeOnPath) return { level: 'AVISO', name, detail: `grava o evento (${p.ms} ms), mas \`node\` não está no PATH`, hint: 'o Claude roda o hook como `node "<script>"` pelo Git Bash: ponha o node no PATH do bash' }
  return { level: 'OK', name, detail: `grava o evento em ${p.ms} ms` }
}

export function checkHome(home: string, writable: boolean, error?: string): CheckResult {
  if (writable) return { level: 'OK', name: 'TETHER_HOME', detail: `${home} (gravável)` }
  return { level: 'ERRO', name: 'TETHER_HOME', detail: `${home} não é gravável${error ? `: ${error}` : ''}`, hint: 'aponte TETHER_HOME para uma pasta sua ou corrija as permissões' }
}

export function checkDaemon(pipe: string, hello: Hello | undefined): CheckResult {
  if (hello) return { level: 'OK', name: 'tetherd', detail: `em execução (pid ${hello.pid}, versão ${hello.version}, protocolo v${hello.v}) em ${pipe}` }
  return { level: 'AVISO', name: 'tetherd', detail: `não está em execução (${pipe})`, hint: 'sobe sozinho quando o app ou a CLI conectam; à mão: npm run daemon' }
}

export interface SoulProbe {
  command: string
  found: boolean
  versionOutput: string | undefined
  /** Text of the soul's source files (bin + dist) that could be read; undefined when none was found. */
  sourceText: string | undefined
}

export function checkSoul(p: SoulProbe): CheckResult {
  if (!p.found) return { level: 'AVISO', name: 'soul', detail: 'não encontrado no PATH', hint: 'só importa se você usa o soul-cli: instale-o ou aponte TETHER_SOUL_CMD' }
  const version = /(\d+\.\d+\.\d+)/.exec(p.versionOutput ?? '')?.[1]
  if (!version) return { level: 'ERRO', name: 'soul', detail: `${p.command} não respondeu a --version`, hint: 'rode `soul --version` à mão e veja o erro' }
  const base = `${version} (${p.command})`
  if (p.sourceText === undefined) return { level: 'AVISO', name: 'soul', detail: `${base}; suporte a ${ENV_SOUL_REPORT} não verificável sem conversa`, hint: 'abra o soul por um slot do tether e veja se o vínculo aparece' }
  if (p.sourceText.includes(ENV_SOUL_REPORT)) return { level: 'OK', name: 'soul', detail: `${base}, com ${ENV_SOUL_REPORT}` }
  return { level: 'AVISO', name: 'soul', detail: `${base} sem ${ENV_SOUL_REPORT}: o tether não saberá qual sessão está na tela`, hint: 'instale o soul com a mudança feat/session-report (bun run build + reinstalar)' }
}

export interface ExeFacts {
  tetherd: ExeStatus
  soul: ExeStatus
  /** What the running daemon says it runs as (hello.exec); undefined when no daemon answers. */
  daemonExec: string | undefined
  /** The soul command as resolved now (undefined when the soul is not a node at all, e.g. soul.exe or bash). */
  soulIsNode: boolean
  /** Where the check runs; macOS names its processes by argv0 over the real node (core/exe.ts). */
  platform?: NodeJS.Platform
}

/**
 * The executables tether's long-lived processes run under. OK when the daemon runs as tetherd.exe and the
 * soul's copy is in place (or not needed); AVISO when something runs as the plain node (a `killall node`
 * would take it) or a copy is out of date / missing.
 */
export function checkExecutables(f: ExeFacts): CheckResult {
  const name = 'executáveis'
  const platform = f.platform ?? process.platform
  if (platform === 'darwin') return checkExecutablesDarwin(f, name)
  const describe = (s: ExeStatus): string => {
    if (s.stamp?.method === 'fallback') return `${s.name}: node original (${s.stamp.reason ?? 'sem motivo registrado'})`
    if (!s.present) return `${s.name}: ainda não criado`
    const how = s.stamp?.method === 'hardlink' ? 'link' : 'cópia'
    return `${s.name}: ${how} de ${s.stamp?.source ?? '?'}${s.outdated ? ', desatualizada' : ''}`
  }
  const parts = [describe(f.tetherd)]
  if (f.soulIsNode) parts.push(describe(f.soul))
  const detail = parts.join('; ')
  if (f.daemonExec && isNodeExecutable(f.daemonExec) && !/tetherd(\.exe)?$/i.test(f.daemonExec)) {
    return { level: 'AVISO', name, detail: `tetherd em execução como ${f.daemonExec} (um "killall node" o derruba); ${detail}`, hint: 'veja <TETHER_HOME>/tetherd.log (linhas "tetherd: rodando com o node original"); reinicie o tetherd depois de corrigir' }
  }
  const broken = [f.tetherd, ...(f.soulIsNode ? [f.soul] : [])].filter((s) => s.stamp?.method === 'fallback')
  if (broken.length > 0) return { level: 'AVISO', name, detail, hint: 'o tether roda com o node original até a cópia funcionar: confira permissões e espaço em <TETHER_HOME>/bin' }
  const running = f.daemonExec ? ` (tetherd em execução como ${f.daemonExec})` : ''
  return { level: 'OK', name, detail: `${detail}${running}` }
}

/**
 * macOS: no renamed file is expected (dyld refuses a link/copy of Homebrew's node); the daemon runs the real
 * node named through argv0, and the soul the same through `exec -a`. A `<home>/bin/tetherd` or `tether-soul`
 * still on disk is a leftover from before and would abort at launch: AVISO naming it.
 */
function checkExecutablesDarwin(f: ExeFacts, name: string): CheckResult {
  const watched = [f.tetherd, ...(f.soulIsNode ? [f.soul] : [])]
  const residue = watched.filter((s) => s.present)
  const running = f.daemonExec ? `tetherd em execução pelo node real (${f.daemonExec}) com o nome por argv0` : 'tetherd roda pelo node real com o nome por argv0'
  const soul = f.soulIsNode ? '; tether-soul idem (exec -a)' : ''
  if (residue.length > 0) {
    return { level: 'AVISO', name, detail: `${running}${soul}; resíduo que o dyld recusa: ${residue.map((s) => s.path).join(', ')}`, hint: 'apague o(s) arquivo(s) em <TETHER_HOME>/bin (o link/cópia do node não roda no macOS: "Library not loaded: @rpath/libnode")' }
  }
  return { level: 'OK', name, detail: `${running}${soul}` }
}

export interface StartTimeFacts {
  method: StartTimeMethod
  /** Time of the second query (the first pays the helper's start-up). */
  ms: number
  answered: boolean
}

/** How the OS start time of a process is read (the orphan reaper and the CLI's liveness check depend on it). */
export function checkStartTime(f: StartTimeFacts): CheckResult {
  const name = 'horário de início de processo'
  if (!f.answered) return { level: 'ERRO', name, detail: 'nenhuma consulta respondeu', hint: 'o tether não consegue reconhecer processos pelo horário de início: confira se o powershell.exe está no PATH e funciona' }
  switch (f.method) {
    case 'helper': return { level: 'OK', name, detail: `ajudante PowerShell residente (${f.ms} ms por consulta)` }
    case 'one-shot': return { level: 'AVISO', name, detail: `um powershell.exe por consulta (${f.ms} ms): o ajudante residente não respondeu`, hint: 'funciona, mas lento e sujeito a falhar sob carga; confira se o powershell.exe sobe normalmente' }
    case 'ps': return { level: 'OK', name, detail: `ps (${f.ms} ms)` }
    default: return { level: 'AVISO', name, detail: 'método desconhecido', hint: 'rode de novo' }
  }
}

export function checkClaudeEnv(env: Record<string, string | undefined>): CheckResult {
  const vars = Object.keys(env).filter((k) => /^claude/i.test(k)).sort()
  if (vars.length === 0) return { level: 'OK', name: 'variáveis CLAUDE*', detail: 'nenhuma no ambiente' }
  return { level: 'AVISO', name: 'variáveis CLAUDE*', detail: `${vars.length} no ambiente (${vars.join(', ')})`, hint: 'o tether remove essas variáveis ao lançar o claude (herdadas, impedem a gravação do transcript); fora do tether, lance o claude de um terminal limpo' }
}

export interface TerminalFacts {
  env: Record<string, string | undefined>
  stdoutIsTTY: boolean
  winptyOnPath: boolean
}

/** mintty (Git Bash's own window) gives node a pipe, not a console: TUIs need winpty there. */
export function isMintty(f: Pick<TerminalFacts, 'env' | 'stdoutIsTTY'>): boolean {
  if (f.env.TERM_PROGRAM === 'mintty') return true
  return process.platform === 'win32' && !!f.env.MSYSTEM && !f.env.WT_SESSION && f.env.TERM_PROGRAM !== 'vscode' && !f.stdoutIsTTY
}

export function checkTerminal(f: TerminalFacts): CheckResult {
  if (!isMintty(f)) return { level: 'OK', name: 'terminal', detail: f.env.WT_SESSION ? 'Windows Terminal' : f.env.TERM_PROGRAM || 'console' }
  if (f.winptyOnPath) return { level: 'OK', name: 'terminal', detail: 'mintty com winpty disponível' }
  return { level: 'AVISO', name: 'terminal', detail: 'mintty sem winpty: claude e soul não terão console', hint: 'use o Windows Terminal, ou instale o winpty e lance com `winpty claude`' }
}

export function formatReport(results: CheckResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`${r.level.padEnd(5)}  ${r.name}: ${r.detail}`)
    if (r.hint && r.level !== 'OK') lines.push(`       → ${r.hint}`)
  }
  const errors = results.filter((r) => r.level === 'ERRO').length
  const warnings = results.filter((r) => r.level === 'AVISO').length
  lines.push('')
  lines.push(errors === 0 && warnings === 0 ? 'Tudo certo.' : `${errors} erro(s), ${warnings} aviso(s).`)
  return lines.join('\n') + '\n'
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.level === 'ERRO') ? 1 : 0
}

// ---- gathering the facts ---------------------------------------------------------------------

function onPath(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const candidate = join(dir, n)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function run(command: string, args: string[], env: Record<string, string>, timeout = 20_000): { stdout: string; ok: boolean } {
  const r = spawnSync(command, args, { encoding: 'utf8', env, timeout, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) })
  return { stdout: `${r.stdout ?? ''}${r.stderr ?? ''}`, ok: r.status === 0 }
}

/** Runs the real hook with a sample SessionStart payload into a temp home and reads the line back. */
export function probeHook(): HookProbe {
  const home = mkdtempSync(join(tmpdir(), 'tether-doctor-'))
  const slotId = 'doctor'
  const sessionId = '00000000-0000-4000-8000-000000000d0c'
  try {
    const payload = JSON.stringify({ session_id: sessionId, cwd: home, hook_event_name: 'SessionStart', source: 'startup' })
    const t0 = performance.now()
    const r = spawnSync(process.execPath, [hookPath(), 'SessionStart'], {
      input: payload,
      encoding: 'utf8',
      env: { ...cleanEnv(), TETHER_HOME: home, TETHER_SLOT_ID: slotId },
      timeout: 20_000,
      windowsHide: true,
    })
    const ms = Math.round(performance.now() - t0)
    const file = join(home, 'slots', `${slotId}.jsonl`)
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
    return { lines, sessionId, slotId, ms, stdout: r.stdout ?? '', exitCode: r.status, nodeOnPath: onPath('node') !== undefined }
  } finally {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function probeHome(home: string): CheckResult {
  try {
    mkdirSync(home, { recursive: true })
    accessSync(home, constants.W_OK)
    const probe = join(home, `.doctor-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return checkHome(home, true)
  } catch (e) {
    return checkHome(home, false, (e as Error).message)
  }
}

/** The soul's own files: the bin script and the dist bundle next to it (bin/soul → ../dist/*.mjs). */
function soulSourceText(command: string, args: string[]): string | undefined {
  const script = args[0] && (isAbsolute(args[0]) || existsSync(args[0])) ? args[0] : command
  if (!existsSync(script)) return undefined
  const parts: string[] = []
  try { parts.push(readFileSync(script, 'utf8')) } catch { return undefined }
  const dist = resolve(dirname(script), '..', 'dist')
  try {
    for (const f of readdirSync(dist)) if (/\.(mjs|cjs|js)$/.test(f)) parts.push(readFileSync(join(dist, f), 'utf8'))
  } catch { /* no dist next to it: the script alone decides */ }
  return parts.join('\n')
}

export function probeSoul(): CheckResult {
  let command: string, args: string[]
  try { ({ command, args } = resolveSoulCommand()) } catch (e) { return { level: 'ERRO', name: 'soul', detail: (e as Error).message, hint: 'corrija TETHER_SOUL_CMD' } }
  const found = command !== 'soul' && (existsSync(command) || onPath(command) !== undefined)
  if (!found) return checkSoul({ command, found: false, versionOutput: undefined, sourceText: undefined })
  const env = cleanEnv()
  delete env[ENV_SOUL_REPORT]
  const { stdout } = run(command, [...args, '--version'], env)
  return checkSoul({ command: args[0] ?? command, found: true, versionOutput: stdout, sourceText: soulSourceText(command, args) })
}

/** `claude --version` through the resolved command (the claude extension's check). */
export function probeClaude(): CheckResult {
  const claudeCmd = resolveClaudeCommand()
  const claudeFound = existsSync(claudeCmd) || onPath('claude') !== undefined
  return checkClaude(claudeCmd, claudeFound, claudeFound ? run(claudeCmd, ['--version'], cleanEnv()).stdout : undefined)
}

/** The real hook writing a sample event (the claude extension's check). */
export function probeHookCheck(): CheckResult {
  try { return checkHook(probeHook()) } catch (e) { return { level: 'ERRO', name: 'hook do claude', detail: (e as Error).message } }
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  results.push(checkNode(process.version))

  const home = tetherHome()
  results.push(probeHome(home))

  const pipe = pipePath(home, userInfo().username)
  const hello = await pingDaemon(pipe)
  results.push(checkDaemon(pipe, hello))

  let soulIsNode = false
  try { soulIsNode = isNodeExecutable(resolveSoulCommand().command) } catch { /* reported by probeSoul */ }
  results.push(checkExecutables({ tetherd: inspectRenamedNode(home, 'tetherd'), soul: inspectRenamedNode(home, 'tether-soul'), daemonExec: hello?.exec, soulIsNode }))

  await processStartTime(process.pid) // the first query starts the helper
  const t0 = performance.now()
  const answered = (await processStartTime(process.pid)) !== undefined
  results.push(checkStartTime({ method: startTimeMethod(), ms: Math.round(performance.now() - t0), answered }))

  // The active agent extensions' checks (claude, its hook and CLAUDE* vars; soul), in activation order.
  for (const check of contributedChecks()) {
    try { results.push(await check()) } catch (e) { results.push({ level: 'ERRO', name: 'verificação de extensão', detail: (e as Error).message }) }
  }
  results.push(checkTerminal({ env: process.env, stdoutIsTTY: process.stdout.isTTY === true, winptyOnPath: onPath('winpty') !== undefined }))
  return results
}
