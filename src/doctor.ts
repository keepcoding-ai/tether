// `tether doctor`: checks the machine the way tether will use it and prints one line per check, in Portuguese:
// OK / AVISO / ERRO plus a hint. The pure parts (`check*`, `formatReport`) take their facts as arguments so
// the unit tests cover them without a real node/claude/soul; `runDoctor` gathers the facts.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { cleanEnv, resolveClaudeCommand } from './agents/claude.ts'
import { ENV_SOUL_REPORT, resolveSoulCommand } from './agents/soul.ts'
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

const HOOK_PATH = resolve(import.meta.dirname, 'report', 'claude-hook.mjs')
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
  if (p.exitCode !== 0) return { level: 'ERRO', name, detail: `saiu com código ${p.exitCode}`, hint: `rode node "${HOOK_PATH}" SessionStart à mão com um JSON no stdin` }
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
    const r = spawnSync(process.execPath, [HOOK_PATH, 'SessionStart'], {
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

function probeSoul(): CheckResult {
  let command: string, args: string[]
  try { ({ command, args } = resolveSoulCommand()) } catch (e) { return { level: 'ERRO', name: 'soul', detail: (e as Error).message, hint: 'corrija TETHER_SOUL_CMD' } }
  const found = command !== 'soul' && (existsSync(command) || onPath(command) !== undefined)
  if (!found) return checkSoul({ command, found: false, versionOutput: undefined, sourceText: undefined })
  const env = cleanEnv()
  delete env[ENV_SOUL_REPORT]
  const { stdout } = run(command, [...args, '--version'], env)
  return checkSoul({ command: args[0] ?? command, found: true, versionOutput: stdout, sourceText: soulSourceText(command, args) })
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  results.push(checkNode(process.version))

  const claudeCmd = resolveClaudeCommand()
  const claudeFound = existsSync(claudeCmd) || onPath('claude') !== undefined
  results.push(checkClaude(claudeCmd, claudeFound, claudeFound ? run(claudeCmd, ['--version'], cleanEnv()).stdout : undefined))

  try { results.push(checkHook(probeHook())) } catch (e) { results.push({ level: 'ERRO', name: 'hook do claude', detail: (e as Error).message }) }

  const home = tetherHome()
  results.push(probeHome(home))

  const pipe = pipePath(home, userInfo().username)
  results.push(checkDaemon(pipe, await pingDaemon(pipe)))

  results.push(probeSoul())
  results.push(checkClaudeEnv(process.env))
  results.push(checkTerminal({ env: process.env, stdoutIsTTY: process.stdout.isTTY === true, winptyOnPath: onPath('winpty') !== undefined }))
  return results
}
