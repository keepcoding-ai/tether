// The Claude Code login, read from where the platform keeps it. In memory only: the token is returned to the one
// caller that puts it in the request header, and no message, error or log in this module ever carries it.
//   1. env CLAUDE_CODE_OAUTH_TOKEN (any platform)
//   2. Windows and Linux: <claude config dir>/.credentials.json  (default ~/.claude)
//   3. macOS: the login Keychain, service "Claude Code-credentials" (`security find-generic-password -s <service> -w`)
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** A credential that is missing, unreadable or expired. `message` is fixed text: safe to print. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

/** Runs `security` with an argument array (no shell) and returns its stdout. Throws on any failure. */
export type SecurityRunner = (args: string[]) => Promise<string>

export interface CredentialDeps {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  home: string
  now: number
  security: SecurityRunner
}

const runSecurity: SecurityRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('security', args, { timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
      // Never forward `error`: its message repeats the command line. Callers only learn that it failed.
      if (error) reject(new Error('security failed'))
      else resolve(stdout)
    })
  })

export function defaultCredentialDeps(): CredentialDeps {
  return { env: process.env, platform: process.platform, home: homedir(), now: Date.now(), security: runSecurity }
}

/** The Keychain item holds the same JSON as .credentials.json; some `security` builds print it hex-encoded. */
function decodeKeychain(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('{')) return text
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex').toString('utf8')
  return text
}

/** Pulls the access token out of the credentials JSON; checks expiry. Throws CredentialError with fixed text. */
export function tokenFromCredentialsJson(text: string, now: number): string {
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined
  try {
    oauth = (JSON.parse(text) as { claudeAiOauth?: typeof oauth })?.claudeAiOauth
  } catch {
    throw new CredentialError('credenciais ilegíveis')
  }
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) throw new CredentialError('sem token OAuth do Claude Code')
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) throw new CredentialError('token OAuth expirado — abra o Claude Code para renovar')
  return oauth.accessToken
}

/** Returns the token or throws CredentialError. */
export async function readClaudeToken(deps: CredentialDeps = defaultCredentialDeps()): Promise<string> {
  const fromEnv = deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (fromEnv) return fromEnv

  if (deps.platform === 'darwin') {
    let raw: string
    try {
      raw = await deps.security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
    } catch {
      throw new CredentialError('login do Claude Code não encontrado no Keychain do macOS (ou acesso negado)')
    }
    return tokenFromCredentialsJson(decodeKeychain(raw), deps.now)
  }

  const dir = deps.env.CLAUDE_CONFIG_DIR?.trim() || join(deps.home, '.claude')
  const file = join(dir, '.credentials.json')
  if (!existsSync(file)) throw new CredentialError('credenciais do Claude Code não encontradas')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new CredentialError('credenciais ilegíveis')
  }
  return tokenFromCredentialsJson(text, deps.now)
}
