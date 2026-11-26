// Wire protocol between the coordinator (the tetherd loop) and the executor workers, plus the closed list of
// operations. Pure types and constants: no node:fs here, so the coordinator may import this file freely. The
// implementations live in ops-*.ts (the only place where `*Sync` is allowed) and are never imported by the loop.

import type { ExeName, ExeResult } from '../core/exe.ts'
import type { ProcRow } from '../daemon/memory.ts'
import type { Listener } from '../daemon/ports.ts'
import type { ProcPlan } from '../procd/protocol.ts'

/** `io`: short, ordered operations (state, log, config), strictly FIFO. `work`: long ones (hashing, scans), no ordering promise. */
export type Lane = 'io' | 'work'

/** An environment as the adapters see it (values may be missing). */
export type EnvMap = Record<string, string | undefined>
export interface CommandLine { command: string; args: string[] }
export interface CodexCmd { command: string; prefix: string[] }
export interface SkillRef { name: string; description: string; dir: string; text: string }
export interface SkillsLoad { skills: SkillRef[]; version: string; logs: string[] }
/** How to write an agent's copy of the skills: a Claude plugin (plugin.json + skills/) or a plain shared folder (skills/). */
export interface MaterializeSpec { target: string; version: string; layout: 'claude-plugin' | 'shared'; skills: { name: string; dir: string }[]; pluginJson?: string }
export type StartTimeMethod = 'helper' | 'one-shot' | 'ps' | 'none'
export interface StartTimeInfo { method: StartTimeMethod; stats: { helper: number; oneShot: number; helperRestarts: number }; helperPid: number | null }
export interface ProcPlanRecipe { command: string; args: string[]; cwd: string; env: Record<string, string> }
export interface RenamedNodeReply { result: ExeResult; logs: string[] }

export interface FileStat { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }
export interface DirEntry { name: string; isFile: boolean; isDirectory: boolean }

/** Argument tuple and result of every operation. Extend together with OP_META and the table in table.ts. */
export interface OpTypes {
  readText: { args: [path: string]; value: string }
  writeTextAtomic: { args: [path: string, text: string]; value: null }
  appendText: { args: [path: string, text: string]; value: null }
  rename: { args: [from: string, to: string]; value: null }
  rm: { args: [path: string]; value: null }
  mkdirp: { args: [path: string]; value: null }
  stat: { args: [path: string]; value: FileStat }
  readdir: { args: [path: string]; value: DirEntry[] }
  exists: { args: [path: string]; value: boolean }
  hashFile: { args: [path: string]; value: string }
  resolveClaude: { args: [env: EnvMap]; value: string }
  resolveCodex: { args: [env: EnvMap]; value: CodexCmd }
  ensureSettingsFile: { args: [file: string, content: string]; value: string }
  userNotify: { args: [home: string]; value: string[] | undefined }
  resolveShell: { args: [slotArgs: string[], profileArgs: string[] | undefined, env: EnvMap]; value: CommandLine }
  resolveSoul: { args: [env: EnvMap]; value: CommandLine }
  soulLaunch: { args: [env: EnvMap, home: string]; value: { command: CommandLine; logs: string[] } }
  resolveHands: { args: [env: EnvMap]; value: CommandLine }
  handsLaunch: { args: [env: EnvMap, home: string]; value: { command: CommandLine; logs: string[] } }
  renamedNode: { args: [home: string, name: ExeName, source: string, platform: NodeJS.Platform]; value: RenamedNodeReply }
  loadSkills: { args: [library: string]; value: SkillsLoad }
  materializeSkills: { args: [spec: MaterializeSpec]; value: string }
  writeTextAtomicDir: { args: [path: string, text: string]; value: null }
  killTree: { args: [pid: number]; value: null }
  sampleProcessTable: { args: []; value: ProcRow[] }
  listListeners: { args: []; value: Listener[] }
  startTime: { args: [pid: number]; value: string | null }
  startTimeInfo: { args: []; value: StartTimeInfo }
  stopStartTimeHelper: { args: []; value: null }
  ensurePrivateDir: { args: [dir: string]; value: null }
  procPlan: { args: [recipe: ProcPlanRecipe, base: EnvMap, platform: NodeJS.Platform]; value: ProcPlan }
  identifyProcess: { args: [pid: number]; value: { pid: number; name?: string; cmd?: string } | null }
  listeningOwner: { args: [port: number]; value: number | null }
  restrictKeyFile: { args: [path: string]; value: null }
  isPrivateFolder: { args: [dir: string]; value: boolean }
}

export type OpName = keyof OpTypes
export type OpArgs<K extends OpName> = OpTypes[K]['args']
export type OpValue<K extends OpName> = OpTypes[K]['value']

/** Lane of each operation and whether running it twice is harmless (a dead worker's pending request is retried once only then). */
export const OP_META = {
  readText: { lane: 'io', idempotent: true },
  writeTextAtomic: { lane: 'io', idempotent: true },
  appendText: { lane: 'io', idempotent: false },
  rename: { lane: 'io', idempotent: false },
  rm: { lane: 'io', idempotent: true },
  mkdirp: { lane: 'io', idempotent: true },
  stat: { lane: 'io', idempotent: true },
  readdir: { lane: 'io', idempotent: true },
  exists: { lane: 'io', idempotent: true },
  hashFile: { lane: 'work', idempotent: true },
  resolveClaude: { lane: 'work', idempotent: true },
  resolveCodex: { lane: 'io', idempotent: true },
  ensureSettingsFile: { lane: 'io', idempotent: true },
  userNotify: { lane: 'io', idempotent: true },
  resolveShell: { lane: 'io', idempotent: true },
  resolveSoul: { lane: 'work', idempotent: true },
  soulLaunch: { lane: 'work', idempotent: true },
  resolveHands: { lane: 'work', idempotent: true },
  handsLaunch: { lane: 'work', idempotent: true },
  renamedNode: { lane: 'work', idempotent: true },
  loadSkills: { lane: 'work', idempotent: true },
  materializeSkills: { lane: 'work', idempotent: true },
  writeTextAtomicDir: { lane: 'io', idempotent: true },
  killTree: { lane: 'work', idempotent: true },
  sampleProcessTable: { lane: 'work', idempotent: true },
  listListeners: { lane: 'work', idempotent: true },
  startTime: { lane: 'work', idempotent: true },
  startTimeInfo: { lane: 'work', idempotent: true },
  stopStartTimeHelper: { lane: 'work', idempotent: true },
  ensurePrivateDir: { lane: 'work', idempotent: true },
  procPlan: { lane: 'work', idempotent: true },
  identifyProcess: { lane: 'work', idempotent: true },
  listeningOwner: { lane: 'work', idempotent: true },
  restrictKeyFile: { lane: 'work', idempotent: true },
  isPrivateFolder: { lane: 'work', idempotent: true },
} as const satisfies Record<OpName, { lane: Lane; idempotent: boolean }>

export interface ExecRequest { id: number; op: string; args: unknown[] }
export interface SerializedError { name: string; message: string; code?: string }
export type ExecReply =
  | { id: number; ok: true; value: unknown; ms: number }
  | { id: number; ok: false; error: SerializedError; ms: number }

/** An error that crossed the worker boundary: keeps name, message and errno `code` (ENOENT...) of the original. */
export class ExecError extends Error {
  code: string | undefined
  constructor(e: SerializedError) {
    super(e.message)
    this.name = e.name
    this.code = e.code
  }
}

/** The worker died (or the executor was closed) while the request was pending and it was not safe to repeat. */
export class ExecutorDown extends Error {
  constructor(message = 'executor worker died') { super(message); this.name = 'ExecutorDown' }
}

/** `run` waited longer than its `timeoutMs`. The operation itself may still finish in the worker; its reply is dropped. */
export class ExecTimeout extends Error {
  constructor(op: string, ms: number) { super(`exec ${op} timed out after ${ms} ms`); this.name = 'ExecTimeout' }
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code === undefined ? { name: e.name, message: e.message } : { name: e.name, message: e.message, code: String(code) }
  }
  return { name: 'Error', message: String(e) }
}
