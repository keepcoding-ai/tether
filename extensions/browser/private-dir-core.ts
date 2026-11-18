// The private-folder check without any synchronous disk or process call (the tetherd-side half of private-dir.ts): the pure
// SDDL rules, the memory of what was checked, and the asynchronous check that the launch path and the boot warm-up use. The
// `whoami` and `icacls` children are created by the executor's worker (ensurePrivateDir in src/exec/ops-os.ts), never by this loop.
// private-dir.ts keeps the synchronous twin for the CLI, the installer and Electron main.
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { agentExecutor } from '../../src/agents/agent-exec.ts'

/** Folders found right in this process (both the synchronous and the asynchronous check fill it). */
export const done = new Set<string>()
/** SDDL's short names for well-known accounts, as the SIDs `icacls /remove:g` takes. */
export const WELL_KNOWN: Record<string, string> = {
  WD: 'S-1-1-0', CO: 'S-1-3-0', OW: 'S-1-3-4', AN: 'S-1-5-7', AU: 'S-1-5-11', IU: 'S-1-5-4', NU: 'S-1-5-2', SY: 'S-1-5-18',
  LS: 'S-1-5-19', NS: 'S-1-5-20', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547', AC: 'S-1-15-2-1',
}
/** The current user's SID, once known (shared with the synchronous twin). */
export const sidMemory: { sid: string | undefined } = { sid: undefined }

/** System tools by their full path (a `whoami` of Git or MSYS earlier on the PATH answers something else). */
export const system32 = (exe: string): string => join(process.env.SystemRoot ?? 'C:/Windows', 'System32', exe)

export interface DaclCheck { protected: boolean; others: string[] }

/** Whether the DACL is protected and which SIDs other than `owner` it allows anything to. Pure. */
export function checkDacl(sddl: string, owner: string): DaclCheck {
  const flags = /^D:([A-Z]*)\(/.exec(sddl)?.[1] ?? /^D:([A-Z]*)$/.exec(sddl)?.[1] ?? ''
  const others = new Set<string>()
  for (const m of sddl.matchAll(/\(([^)]*)\)/g)) {
    const parts = m[1]!.split(';')
    const type = parts[0]
    const who = parts[5] ?? ''
    if (type !== 'A' && type !== 'OA') continue // deny and audit entries take nothing away from the owner
    if (who !== owner) others.add(who)
  }
  return { protected: flags.includes('P'), others: [...others] }
}

// ---- warm-up: the same check, without blocking the loop ----
// The first ensurePrivateDir of a folder costs a `whoami` and several `icacls` (hundreds of ms on Windows) inside the launch of
// an agent. warmPrivateDirs does that work on the executor at boot and fills the same `done` set, so a launch finds the
// folder checked. A launch that comes before the warm-up ends keeps the synchronous path of private-dir.ts.

/** ensurePrivateDir on the executor: same checks and repairs, same `done` memory (the worker keeps its own too). Throws like it. */
export async function ensurePrivateDirAsync(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (done.has(dir)) return
  await agentExecutor().run('ensurePrivateDir', [dir])
  done.add(dir)
}

/** Checks the folders one after another at boot; a failure is reported to `log` and left for the launch's own check to raise. */
export async function warmPrivateDirs(dirs: readonly string[], log: (msg: string) => void = () => {}): Promise<void> {
  for (const dir of dirs) {
    try { await ensurePrivateDirAsync(dir) } catch (e) { log(`aquecimento de ${basename(dir)}: ${(e as Error).message}`) }
  }
}

/** Test seam: forgets what was checked. */
export function resetPrivateDirMemory(): void { done.clear(); sidMemory.sid = undefined }

