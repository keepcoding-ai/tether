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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentExecutor } from '../agents/agent-exec.ts'

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

/** The pipe a tetherd in this process serves for `home` (what a helper it spawns must dial), if any. */
export function servedPipeOf(home: string): string | undefined {
  for (const [pipe, h] of servedHomes) if (h === home) return pipe
  return undefined
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

/**
 * Who the handshake is with: tetherd's pipe ('tetherd') or a host's (tether-procd, tether-ptyd: 'tether-host'). The scope
 * is part of every label, so a proof made for one kind of pipe never passes on another even if two keys were ever equal.
 */
export type KeyScope = 'tetherd' | 'tether-host'

/** What the server answers to the client's nonce. */
export function daemonProof(key: Buffer, clientNonce: string, daemonNonce: string, scope: KeyScope = 'tetherd'): string {
  return mac(key, `${scope}-daemon`, clientNonce, daemonNonce)
}

/** What the client sends in its hello. */
export function clientProof(key: Buffer, clientNonce: string, daemonNonce: string, scope: KeyScope = 'tetherd'): string {
  return mac(key, `${scope}-client`, daemonNonce, clientNonce)
}

/**
 * A host's own key (tether-procd, tether-ptyd), one file per pipe: <home>/host-<16 hex of sha256(pipe)>.key. Own keys,
 * not derived from tetherd's: a host outlives tetherd (the panes survive a tetherd restart) while tetherd draws a new key
 * at every start, so a derived key would lock tetherd out of the host it must re-adopt.
 */
export function hostKeyPath(home: string, pipe: string): string {
  return join(home, `host-${createHash('sha256').update(pipe).digest('hex').slice(0, 16)}.key`)
}

/** Reads a key file (64 hex); undefined when missing or malformed. */
export async function readKeyFile(path: string): Promise<Buffer | undefined> {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined
  } catch {
    return undefined
  }
}

/** Constant-time comparison of a proof from the wire with the expected one. */
export function sameProof(got: unknown, want: string): boolean {
  if (typeof got !== 'string' || got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'))
}

/** The key a client presents: read fresh at every connection (a restarted tetherd draws a new one). */
export function readPipeKey(home: string): Promise<Buffer | undefined> {
  return readKeyFile(pipeKeyPath(home))
}

// The whoami / icacls children are created by the executor (restrictKeyFile and isPrivateFolder in src/exec/ops-os.ts):
// CreateProcess runs on the calling thread, so tetherd's loop never does it (test/unit/arch.sync-ratchet.test.ts). tetherd
// registers its worker executor; the hosts (tether-procd, tether-ptyd) use the inline fallback, as they do for killTree.

/** Bench only: TETHER_TEST_KEY_ACL_FAIL=1 makes restricting the key file fail, to prove what happens then. */
const ENV_TEST_ACL_FAIL = 'TETHER_TEST_KEY_ACL_FAIL'

/** The key file's DACL becomes the user and SYSTEM, no inheritance (the home may inherit "Users: read"); 0600 elsewhere. */
async function restrictKeyFile(path: string): Promise<void> {
  if (process.env[ENV_TEST_ACL_FAIL] === '1') throw new Error(`falha simulada (${ENV_TEST_ACL_FAIL}=1)`)
  await agentExecutor().run('restrictKeyFile', [path])
}

/**
 * Whether only the user (and SYSTEM / Administrators) can reach the folder: Windows, every allow entry of its DACL, read as
 * SDDL (the same in every system language); elsewhere, no permission bit for group or others. Unreadable counts as not private.
 */
export async function folderIsPrivate(dir: string): Promise<boolean> {
  return agentExecutor().run('isPrivateFolder', [dir]).catch(() => false)
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
export async function prepareKeyFile(home: string, path: string, log: (msg: string) => void): Promise<void> {
  const fh = await open(path, 'a', 0o600)
  await fh.close()
  try {
    await restrictKeyFile(path)
  } catch (e) {
    const why = (e as Error).message
    if (!(await folderIsPrivate(home))) {
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
