// Wire protocol between the coordinator (the tetherd loop) and the executor workers, plus the closed list of
// operations. Pure types and constants: no node:fs here, so the coordinator may import this file freely. The
// implementations live in ops-*.ts (the only place where `*Sync` is allowed) and are never imported by the loop.

/** `io`: short, ordered operations (state, log, config), strictly FIFO. `work`: long ones (hashing, scans), no ordering promise. */
export type Lane = 'io' | 'work'

export interface FileStat { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }
export interface DirEntry { name: string; isFile: boolean; isDirectory: boolean }

/** Argument tuple and result of every operation. Extend together with OP_META and the table in table.ts. */
export interface OpTypes {
  readText: { args: [path: string]; value: string }
  writeTextAtomic: { args: [path: string, text: string]; value: null }
  appendText: { args: [path: string, text: string]; value: null }
  rm: { args: [path: string]; value: null }
  mkdirp: { args: [path: string]; value: null }
  stat: { args: [path: string]; value: FileStat }
  readdir: { args: [path: string]; value: DirEntry[] }
  exists: { args: [path: string]; value: boolean }
  hashFile: { args: [path: string]; value: string }
}

export type OpName = keyof OpTypes
export type OpArgs<K extends OpName> = OpTypes[K]['args']
export type OpValue<K extends OpName> = OpTypes[K]['value']

/** Lane of each operation and whether running it twice is harmless (a dead worker's pending request is retried once only then). */
export const OP_META = {
  readText: { lane: 'io', idempotent: true },
  writeTextAtomic: { lane: 'io', idempotent: true },
  appendText: { lane: 'io', idempotent: false },
  rm: { lane: 'io', idempotent: true },
  mkdirp: { lane: 'io', idempotent: true },
  stat: { lane: 'io', idempotent: true },
  readdir: { lane: 'io', idempotent: true },
  exists: { lane: 'io', idempotent: true },
  hashFile: { lane: 'work', idempotent: true },
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
