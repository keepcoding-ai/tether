// The pipe's key: who may speak to tetherd. Each tetherd draws a fresh 256-bit key once it owns the pipe and writes it to
// <home>/tetherd.key, readable only by the user who runs it (Windows: an explicit DACL with that user and SYSTEM, no
// inheritance; elsewhere: mode 0600 in a 0700 home). A client proves it read the file without sending it, by a
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
import { chmod, open, readFile, writeFile } from 'node:fs/promises'
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

/** Windows: the file's DACL becomes exactly the user and SYSTEM, inheritance removed (the home may inherit "Users: read"). */
async function restrictWindows(path: string): Promise<void> {
  const sid = await ownSid()
  await run(join(system32(), 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'])
}

/**
 * Draws a key and writes it to <home>/tetherd.key, private to the user. Called once tetherd owns the pipe, so a second
 * tetherd that loses the race never replaces the winner's key. The file is created empty and made private BEFORE the key
 * goes in. A failure to restrict the ACL is reported through `log` (the key is still written: the default home is
 * private to the user already) and returned as a warning.
 */
export async function writePipeKey(home: string, log: (msg: string) => void, platform: NodeJS.Platform = process.platform): Promise<Buffer> {
  const key = randomBytes(32)
  const path = pipeKeyPath(home)
  const fh = await open(path, 'a', 0o600)
  await fh.close()
  try {
    if (platform === 'win32') await restrictWindows(path)
    else await chmod(path, 0o600)
  } catch (e) {
    log(`pipe key: could not make ${path} private to the user (${(e as Error).message}); it keeps the home folder's permissions`)
  }
  await writeFile(path, key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  return key
}
