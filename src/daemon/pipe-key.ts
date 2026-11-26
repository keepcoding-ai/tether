// The pipe's key: who may speak to tetherd. Each tetherd draws a fresh 256-bit key once it owns the pipe and writes it to
// <home>/tetherd.key, readable only by the user who runs it (Windows: an explicit DACL with that user and SYSTEM, no
// inheritance; elsewhere: mode 0600 in a 0700 home). When the file cannot be made private, the key goes in only if the
// folder is private already; otherwise tetherd refuses to start (prepareKeyFile). A client proves it read the file without sending it, by a
// challenge-response over HMAC-SHA256, and tetherd proves the same to the client, so a program that took the pipe's name
// first (the pipe namespace is global to the machine) cannot pass for it:
//
//   client -> { t:'auth', nonce: cn }                     cn: 32 random bytes, hex
//   daemon -> { ok, auth: { nonce: sn, proof: Sd } }      Sd = HMAC(key, "tetherd-daemon\n" + cn + "\n" + sn)
//   client checks Sd, then
//   client -> { t:'hello', ..., proof: Sc }               Sc = HMAC(key, "tetherd-client\n" + sn + "\n" + cn)
//
// The two labels keep one side's answer from ever serving as the other's. The key is a secret: it never goes into a log
// line, an error message, a reply or stdout; only its path does.
import { execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PIPE_KEY_FILE = 'tetherd.key'
const NONCE_BYTES = 32
const NONCE_RE = /^[0-9a-f]{64}$/

export function pipeKeyPath(home: string): string {
  return join(home, PIPE_KEY_FILE)
}

/** The pipes a tetherd in THIS process serves, with their home: a client in the same process finds the key without being told the home. */
const servedHomes = new Map<string, string>()

export function servePipeHome(pipe: string, home: string): void {
  servedHomes.set(pipe, home)
}

export function unservePipeHome(pipe: string, home: string): void {
  if (servedHomes.get(pipe) === home) servedHomes.delete(pipe)
}

/** The home of a pipe served in this process, if any. */
export function servedHome(pipe: string): string | undefined {
  return servedHomes.get(pipe)
}

export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

export function isNonce(x: unknown): x is string {
  return typeof x === 'string' && NONCE_RE.test(x)
}

function mac(key: Buffer, label: string, a: string, b: string): string {
  return createHmac('sha256', key).update(`${label}\n${a}\n${b}`).digest('hex')
}

/** What tetherd answers to the client's nonce. */
export function daemonProof(key: Buffer, clientNonce: string, daemonNonce: string): string {
  return mac(key, 'tetherd-daemon', clientNonce, daemonNonce)
}

/** What the client sends in its hello. */
export function clientProof(key: Buffer, clientNonce: string, daemonNonce: string): string {
  return mac(key, 'tetherd-client', daemonNonce, clientNonce)
}

/** Constant-time comparison of a proof from the wire with the expected one. */
export function sameProof(got: unknown, want: string): boolean {
  if (typeof got !== 'string' || got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'))
}

/** The key a client presents: read fresh at every connection (a restarted tetherd draws a new one). */
export async function readPipeKey(home: string): Promise<Buffer | undefined> {
  try {
    const text = (await readFile(pipeKeyPath(home), 'utf8')).trim()
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined
  } catch {
    return undefined
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

const system32 = (): string => join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')

/** The SID of the user this process runs as (whoami.exe from System32, never one found on the PATH). */
async function ownSid(): Promise<string> {
  const out = await run(join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1]
  if (!sid) throw new Error('whoami não deu o SID do usuário')
  return sid
}

/** Bench only: TETHER_TEST_KEY_ACL_FAIL=1 makes restricting the key file fail, to prove what happens then. */
const ENV_TEST_ACL_FAIL = 'TETHER_TEST_KEY_ACL_FAIL'

/** Windows: the file's DACL becomes exactly the user and SYSTEM, inheritance removed (the home may inherit "Users: read"). */
async function restrictWindows(path: string): Promise<void> {
  if (process.env[ENV_TEST_ACL_FAIL] === '1') throw new Error(`falha simulada (${ENV_TEST_ACL_FAIL}=1)`)
  const sid = await ownSid()
  await run(join(system32(), 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'])
}

/** SIDs that may hold access to a private folder besides the user: SYSTEM, Administrators, CREATOR OWNER (a placeholder for inheritance). */
const TRUSTED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0'])

/**
 * Whether only the user (and SYSTEM / Administrators) can read the folder: Windows, every Allow entry of its DACL goes to one
 * of those SIDs (read through Get-Acl, by SID, never by localized name); elsewhere, no permission bit for group or others.
 * Anything that cannot be checked counts as not private.
 */
export async function folderIsPrivate(dir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform !== 'win32') return ((await stat(dir)).mode & 0o077) === 0
    const ps = `$a = Get-Acl -LiteralPath '${dir.replace(/'/g, "''")}'; `
      + `$a.Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { 'ACE=' + $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }; `
      + `'ME=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`
    const out = await run(join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps])
    const me = /ME=(S-1-[0-9-]+)/.exec(out)?.[1]
    const aces = [...out.matchAll(/ACE=(S-1-[0-9-]+)/g)].map((m) => m[1]!)
    return me !== undefined && aces.length > 0 && aces.every((sid) => sid === me || TRUSTED_SIDS.has(sid))
  } catch {
    return false
  }
}

/** The key file could not be made private and its folder is not private either: the process refuses to serve. */
export class KeyNotPrivateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyNotPrivateError'
  }
}

/**
 * Makes `path` (in `home`) ready to hold a key: created when missing (an existing key is left as it is) and made private to
 * the user. When that fails, it is accepted only if the folder is private to the user already (the default home is);
 * otherwise KeyNotPrivateError, with what to do. Runs before the process serves anything, so a refusal leaves nothing behind.
 */
export async function prepareKeyFile(home: string, path: string, log: (msg: string) => void, platform: NodeJS.Platform = process.platform): Promise<void> {
  const fh = await open(path, 'a', 0o600)
  await fh.close()
  try {
    if (platform === 'win32') await restrictWindows(path)
    else await chmod(path, 0o600)
  } catch (e) {
    const why = (e as Error).message
    if (!(await folderIsPrivate(home, platform))) {
      throw new KeyNotPrivateError(`não consegui deixar ${path} legível só por você (${why}), e a pasta ${home} não é privada: `
        + 'recusei subir, porque outra conta da máquina poderia ler a chave. Corrija as permissões da pasta ou aponte TETHER_HOME para uma pasta só sua')
    }
    log(`key: could not restrict ${path} (${why}); the folder ${home} is private to the user, so the key is written there`)
  }
}

/** Draws a key into a file prepareKeyFile made ready. Called once the process owns its pipe: one that lost the race never replaces the winner's key. */
export async function fillKeyFile(path: string): Promise<Buffer> {
  const key = randomBytes(32)
  await writeFile(path, key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  return key
}
