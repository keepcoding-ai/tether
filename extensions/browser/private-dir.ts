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
// This is the SYNCHRONOUS twin (CLI, installer, Electron main). The tetherd side uses private-dir-core.ts (no sync call).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { checkDacl, done, sidMemory, system32, WELL_KNOWN } from './private-dir-core.ts'

export * from './private-dir-core.ts'

const run = (args: string[]): string => execFileSync(system32('icacls.exe'), args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** The current user's SID (`whoami /user`, CSV: "domain\\user","S-1-5-..."). */
export function currentUserSid(): string {
  if (sidMemory.sid) return sidMemory.sid
  const out = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' })
  const m = /"(S-1-[\d-]+)"/.exec(out)
  if (!m) throw new Error('não consegui ler o SID do usuário atual')
  sidMemory.sid = m[1]!
  return sidMemory.sid
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
