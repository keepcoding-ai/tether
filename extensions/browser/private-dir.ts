// A folder only its owner reaches (Tether Browser E7c, review M4): `<home>/browser` and `keys/` hold the agents' keys, and the
// gatekeeper trusts any well-formed key file in `keys/`. Under the profile the home inherits an owner-only ACL; anywhere else
// (TETHER_HOME on another drive) it inherits the drive's, where "Users" read and "Authenticated Users" write: another user of
// the machine would read the keys and could plant one.
//   - Windows: the folder's DACL is made protected (no inheritance) with one entry, the current user's SID with full control
//     inherited by files and subfolders (`icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F`); any other allow entry is
//     removed (`/remove:g`). Then it is read back as SDDL (`icacls /save`, the same in every system language) and checked:
//     protected, and every allow entry is the owner's. Anything else throws, and the caller does not serve.
//   - Elsewhere: mode 0700, checked the same way.
// The check runs once per folder per process (a folder found right is not touched).
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const done = new Set<string>()
/** SDDL's short names for well-known accounts, as the SIDs `icacls /remove:g` takes. */
const WELL_KNOWN: Record<string, string> = {
  WD: 'S-1-1-0', CO: 'S-1-3-0', OW: 'S-1-3-4', AN: 'S-1-5-7', AU: 'S-1-5-11', IU: 'S-1-5-4', NU: 'S-1-5-2', SY: 'S-1-5-18',
  LS: 'S-1-5-19', NS: 'S-1-5-20', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547', AC: 'S-1-15-2-1',
}
let sid: string | undefined

/** System tools by their full path (a `whoami` of Git or MSYS earlier on the PATH answers something else). */
const system32 = (exe: string): string => join(process.env.SystemRoot ?? 'C:/Windows', 'System32', exe)
const run = (args: string[]): string => execFileSync(system32('icacls.exe'), args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** The current user's SID (`whoami /user`, CSV: "domain\\user","S-1-5-..."). */
export function currentUserSid(): string {
  if (sid) return sid
  const out = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' })
  const m = /"(S-1-[\d-]+)"/.exec(out)
  if (!m) throw new Error('não consegui ler o SID do usuário atual')
  sid = m[1]!
  return sid
}

/** The folder's DACL as SDDL (`D:...`), read with `icacls /save` into a temp file (UTF-16LE). */
export function daclOf(dir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'tether-acl-'))
  try {
    const file = join(tmp, 'acl')
    run([dir, '/save', file, '/q'])
    const text = readFileSync(file).toString('utf16le').replace(/^﻿/, '')
    const sddl = text.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('D:'))
    if (!sddl) throw new Error('ACL ilegível')
    return sddl
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

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

/**
 * Whether `dir` is reachable by its owner only, without changing anything: protected and owner-only (`inherited`: owner-only,
 * its entries may come from a private parent). Any failure to read counts as not private.
 */
export function isPrivateDir(dir: string, opts: { inherited?: boolean } = {}): boolean {
  try {
    if (process.platform !== 'win32') return (statSync(dir).mode & 0o077) === 0
    const c = checkDacl(daclOf(dir), currentUserSid())
    return c.others.length === 0 && (opts.inherited === true || c.protected)
  } catch { return false }
}

/** Creates `dir` if needed and leaves it reachable by its owner only; throws when that cannot be made true. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  if (done.has(dir)) return
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700)
    if ((statSync(dir).mode & 0o077) !== 0) throw new Error(`${basename(dir)}: a pasta continua aberta a outros usuários`)
    done.add(dir)
    return
  }
  const owner = currentUserSid()
  let c = checkDacl(daclOf(dir), owner)
  if (!c.protected || c.others.length > 0) {
    run([dir, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`, '/q'])
    for (const other of checkDacl(daclOf(dir), owner).others) run([dir, '/remove:g', `*${WELL_KNOWN[other] ?? other}`, '/q'])
    c = checkDacl(daclOf(dir), owner)
    if (!c.protected || c.others.length > 0) throw new Error(`${basename(dir)}: a pasta concede acesso a outros (${c.others.join(', ')}); o navegador não serve`)
  }
  done.add(dir)
}

// ---- warm-up: the same check, without blocking the loop ----
// The first ensurePrivateDir of a folder costs a `whoami` and several `icacls` as synchronous spawns (hundreds of ms on
// Windows) inside the launch of an agent. warmPrivateDirs does that work off the loop at boot and fills the same `done` set,
// so a launch finds the folder checked. A launch that comes before the warm-up ends keeps the synchronous path above.

const execFileAsync = promisify(execFile)
const runAsync = async (args: string[]): Promise<string> => (await execFileAsync(system32('icacls.exe'), args, { windowsHide: true, encoding: 'utf8' })).stdout
let sidPending: Promise<string> | undefined

async function currentUserSidAsync(): Promise<string> {
  if (sid) return sid
  sidPending ??= (async () => {
    const { stdout } = await execFileAsync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' })
    const m = /"(S-1-[\d-]+)"/.exec(stdout)
    if (!m) throw new Error('não consegui ler o SID do usuário atual')
    sid = m[1]!
    return sid
  })().finally(() => { sidPending = undefined })
  return sidPending
}

async function daclOfAsync(dir: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'tether-acl-'))
  try {
    const file = join(tmp, 'acl')
    await runAsync([dir, '/save', file, '/q'])
    const text = (await readFile(file)).toString('utf16le').replace(/^﻿/, '')
    const sddl = text.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('D:'))
    if (!sddl) throw new Error('ACL ilegível')
    return sddl
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** ensurePrivateDir without blocking the event loop; same checks and repairs, same `done` memory. Throws like it. */
export async function ensurePrivateDirAsync(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (done.has(dir)) return
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700)
    if (((await stat(dir)).mode & 0o077) !== 0) throw new Error(`${basename(dir)}: a pasta continua aberta a outros usuários`)
    done.add(dir)
    return
  }
  const owner = await currentUserSidAsync()
  let c = checkDacl(await daclOfAsync(dir), owner)
  if (!c.protected || c.others.length > 0) {
    await runAsync([dir, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`, '/q'])
    for (const other of checkDacl(await daclOfAsync(dir), owner).others) await runAsync([dir, '/remove:g', `*${WELL_KNOWN[other] ?? other}`, '/q'])
    c = checkDacl(await daclOfAsync(dir), owner)
    if (!c.protected || c.others.length > 0) throw new Error(`${basename(dir)}: a pasta concede acesso a outros (${c.others.join(', ')}); o navegador não serve`)
  }
  done.add(dir)
}

/** Checks the folders one after another at boot; a failure is reported to `log` and left for the launch's own check to raise. */
export async function warmPrivateDirs(dirs: readonly string[], log: (msg: string) => void = () => {}): Promise<void> {
  for (const dir of dirs) {
    try { await ensurePrivateDirAsync(dir) } catch (e) { log(`aquecimento de ${basename(dir)}: ${(e as Error).message}`) }
  }
}

/** Test seam: forgets what was checked. */
export function resetPrivateDirMemory(): void { done.clear(); sid = undefined }
