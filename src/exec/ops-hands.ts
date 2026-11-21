// Operations of the hands adapter (src/agents/hands.ts): walking PATH, reading the installed launcher, asking a login shell,
// copying node to tether-hands. Synchronous on purpose: they run inside an executor worker (lane `work`). Exempt area of the
// sync ratchet, like every ops-*.ts. Derived from the soul's operations in ops-agents.ts and kept apart: each evolves alone.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ensureRenamedNode as ensureRenamedNodeSync, fileSig, isNodeExecutable, isRenamedNode } from '../core/exe-sync.ts'
import { findOnPath } from '../agents/shell-sync.ts'
import { ENV_HANDS_CMD, fromMsysPath, splitCommandLine, type HandsCommand } from '../agents/hands.ts'
import type { EnvMap } from './protocol.ts'

const BIN = 'hands'

function isScript(file: string): boolean {
  try {
    return readFileSync(file).subarray(0, 2).toString('latin1') === '#!'
  } catch {
    return false
  }
}

/** `NAME="value"` or `NAME=value` at the start of a line of a shell script. */
function scriptVar(text: string, name: string): string | undefined {
  const m = new RegExp(`^${name}=(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`, 'm').exec(text)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** Turns the installed bash launcher (`NODE=` / `CLI=` lines) into something ConPTY can spawn. */
export function handsCommandFromScript(script: string, env: EnvMap): HandsCommand {
  const text = readFileSync(script, 'utf8')
  const cli = scriptVar(text, 'CLI')
  if (cli) {
    const node = scriptVar(text, 'NODE')
    const nodePath = node ? fromMsysPath(node) : undefined
    return { command: nodePath && existsSync(nodePath) ? nodePath : process.execPath, args: [cli] }
  }
  return { command: gitBash(env) ?? 'bash', args: [script] }
}

/** Git for Windows' bash.exe (never WSL's System32 bash.exe). */
function gitBash(env: EnvMap): string | undefined {
  const candidates: string[] = []
  const git = findOnPath('git', env)
  if (git) candidates.push(join(dirname(git), '..', 'bin', 'bash.exe'), join(dirname(git), 'bash.exe'))
  const onPath = findOnPath('bash', env)
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) candidates.push(onPath)
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
  }
  return candidates.find((c) => existsSync(c))
}

/** Windows: `hands` where Git Bash finds it (~/bin, or its login shell's PATH and aliases). Undefined when it cannot tell. */
export function handsFromGitBash(env: EnvMap): HandsCommand | undefined {
  const home = env.USERPROFILE || env.HOME
  if (home) {
    const inHomeBin = join(home, 'bin', BIN)
    if (existsSync(inHomeBin)) return fromFound(inHomeBin)
  }
  const bash = gitBash(env)
  if (!bash) return undefined
  try {
    const out = execFileSync(bash, ['-lic', `command -v ${BIN}`], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const line = out.trim().split('\n').pop()?.trim()
    if (!line) return undefined
    const found = fromMsysPath(line)
    if (isAbsolute(found) && existsSync(found)) return fromFound(found)
    return { command: bash, args: ['-lic', `${BIN} "$@"`, BIN] } // alias or shell function
  } catch {
    return undefined
  }

  function fromFound(file: string): HandsCommand {
    if (!/\.(exe|cmd|bat)$/i.test(file) && isScript(file)) return handsCommandFromScript(file, env)
    return { command: file, args: [] }
  }
}

const loginShellCache = new Map<string, HandsCommand | undefined>()

/** macOS: `hands` as the user's interactive login shell sees it (rc files, aliases). Undefined when it cannot tell. */
export function handsFromLoginShell(env: EnvMap): HandsCommand | undefined {
  const shell = env.SHELL
  if (!shell) return undefined
  if (loginShellCache.has(shell)) return loginShellCache.get(shell)
  let found: HandsCommand | undefined
  try {
    const out = execFileSync(shell, ['-lic', `command -v ${BIN}`], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.trim().split('\n').pop()?.trim()
    if (line) found = isAbsolute(line) && existsSync(line) ? { command: line, args: [] } : { command: shell, args: ['-lic', `${BIN} "$@"`, BIN] }
  } catch { /* not found */ }
  if (found) loginShellCache.set(shell, found) // a miss is not cached: the hands may get installed meanwhile
  return found
}

const RESOLVE_TTL_MS = 60_000
const resolved = new Map<string, { value: HandsCommand; paths: string[]; sigs: (string | undefined)[]; at: number }>()
/** Drops the memoized resolution (tests). */
export function clearHandsResolveCache(): void { resolved.clear() }

export function resolveHandsCommand(env: EnvMap = process.env): HandsCommand {
  // Memoized by the inputs that decide it; a hit costs one stat per absolute path of the command.
  const key = [process.platform, env[ENV_HANDS_CMD] ?? '', env.PATH ?? env.Path ?? '', env.USERPROFILE ?? '', env.HOME ?? '', env.SHELL ?? ''].join('|')
  const hit = resolved.get(key)
  const now = Date.now()
  const pathsOf = (c: HandsCommand): string[] => [c.command, ...c.args].filter((a) => isAbsolute(a))
  if (hit && now - hit.at < RESOLVE_TTL_MS && hit.sigs.every((s, i) => s !== undefined && s === fileSig(hit.paths[i]!))) return { command: hit.value.command, args: [...hit.value.args] }
  const found = resolveUncached(env)
  const paths = pathsOf(found)
  const sigs = paths.map((p) => fileSig(p))
  if (paths.length && isAbsolute(found.command) && sigs.every((s) => s !== undefined)) {
    if (resolved.size >= 16) resolved.clear()
    resolved.set(key, { value: found, paths, sigs, at: now })
  } else resolved.delete(key)
  return found
}

function resolveUncached(env: EnvMap): HandsCommand {
  const custom = env[ENV_HANDS_CMD]?.trim()
  if (custom) {
    const [first, ...rest] = splitCommandLine(custom)
    if (!first) throw new Error(`${ENV_HANDS_CMD} vazio`)
    const command = existsSync(first) || isAbsolute(first) ? first : (findOnPath(first, env) ?? first)
    return { command, args: rest }
  }
  const found = findOnPath(BIN, env)
  if (!found) {
    const fallback = process.platform === 'darwin' ? handsFromLoginShell(env) : process.platform === 'win32' ? handsFromGitBash(env) : undefined
    return fallback ?? { command: BIN, args: [] }
  }
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(found) && isScript(found)) return handsCommandFromScript(found, env)
  return { command: found, args: [] }
}

/**
 * The command with its node replaced by <home>/bin/tether-hands.exe, when it is a node at all. The daemon may itself be a
 * renamed node (tetherd.exe): the node it was made from is in TETHER_NODE. On macOS the name goes through `exec -a`.
 */
export function withHandsNode(cmd: HandsCommand, home: string, env: EnvMap = process.env, log: (msg: string) => void = () => {}): HandsCommand {
  if (!isNodeExecutable(cmd.command)) return cmd
  const source = isRenamedNode(cmd.command) ? (env.TETHER_NODE?.trim() || cmd.command) : cmd.command
  const exe = ensureRenamedNodeSync(home, 'tether-hands', source, log)
  if (exe.argv0) return { command: '/bin/sh', args: ['-c', `exec -a ${exe.argv0} "$0" "$@"`, exe.path, ...cmd.args] }
  return { command: exe.path, args: cmd.args }
}

/** The hands command of a launch: resolved on `env`, its node renamed for `home`. The log lines come back for the caller. */
export function handsLaunch(env: EnvMap, home: string): { command: HandsCommand; logs: string[] } {
  const logs: string[] = []
  return { command: withHandsNode(resolveHandsCommand(env), home, env, (m) => logs.push(m)), logs }
}

export const handsOps = {
  resolveHands: (env: EnvMap): HandsCommand => resolveHandsCommand(env),
  handsLaunch: (env: EnvMap, home: string): { command: HandsCommand; logs: string[] } => handsLaunch(env, home),
}
