// Launch arguments, made safe to show: option names stay, the values of options that look like a key, token or password do not.
// Pure and free of node imports (the renderer uses it). The same idea that keeps an env value out of a view: what is shown is
// only what does not look like a secret.
//
// Ambiguities, decided (a mask hides from a view, never changes what runs, so the rule leans to masking where a secret is the
// usual reading, and to keeping where an ordinary value is):
//   - `-p <value>` apart is a port (`serve -p 3000`), a project (`tsc -p tsconfig.json`) or mysql's database name: kept.
//     `-p<value>` glued is mysql's password, masked unless it is a number or a port mapping (`-p3000`, `-p8080:80`) or
//     a word of lowercase letters (find's `-print`, gcc's `-pthread`, `-pedantic`).
//   - `/p:<value>` is msbuild's property (`/p:Configuration=Release`, kept unless the property's name is secret) or a
//     password (`/p:hunter2`, no `=`: masked).
//   - `-u` / `--user` with `name:password` (curl) loses the part after the colon; `uid:gid` numbers (docker) stay.
//   - After an option with a secret name, the next word is its value even when it starts with `-`; a `--long-option` is not.
//   - `PWD` exactly is the working folder on Unix, not a password; any other `pwd` (`--pwd`, `MYSQL_PWD`) is.
//   - A URL is a secret only when it carries one (`scheme://user:password@`): the name `*_URL` alone says nothing.

/** Words that mark a secret anywhere in a name (`API_TOKEN`, `apikey`, `--client-secret`, `PGPASSWORD`). */
const SECRET_PART = /(token|secret|key|passw(or)?d|passwd|passphrase|pgpass|auth|credential|cookie|bearer|signing|privkey)/i
/** Whole words of a name that mark a secret (`DB_PASS`, `--pwd`, `SENTRY_DSN`, `PIN`), not inside another (`BYPASS`, `SPINNER`). */
const SECRET_WORDS = new Set(['pass', 'pwd', 'pin', 'salt', 'dsn', 'pem', 'cert', 'otp', 'session', 'cred', 'creds', 'private', 'sig', 'hmac'])

export const MASK = '[redacted]'
const TOKEN_SHAPE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_\w{10,}|github_pat_\w+|xox[a-z]-[\w-]+|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w.-]+)/g
const LONG_BLOB = /\b[A-Za-z0-9+/_-]{40,}\b/g
/** `scheme://user:password@`: the password part (group 2) of a URL's userinfo. */
const URL_USERINFO = /([A-Za-z][\w+.-]*:\/\/[^/@\s:]*:)([^@\s/]+)@/g
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----/

/** The words of a name: `--clientSecret` → client, secret; `DB_PASS` → db, pass. */
function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== '')
}

/** A name (an option, a `NAME=value`, an environment variable) that looks like it holds a secret: the one rule of this file. */
export function looksSecretName(name: string): boolean {
  if (name === 'PWD') return false
  return SECRET_PART.test(name) || nameWords(name).some(w => SECRET_WORDS.has(w))
}

/** Bits per character of `s` (Shannon): a random key is near 5 or 6, a word or a path much lower. */
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}

/**
 * A value that has the shape of a credential whatever its name: a URL with a password in it, a PEM block, a known token
 * prefix (`sk-`, `ghp_`, `xox?-`, `AKIA`, a JWT), or a long random word (32+ characters of letters and digits mixed, with
 * the entropy of a key). Says yes or no only; the value is never part of an answer.
 */
export function looksSecretValue(v: string): boolean {
  URL_USERINFO.lastIndex = 0
  TOKEN_SHAPE.lastIndex = 0
  if (URL_USERINFO.test(v) || PEM_BLOCK.test(v) || TOKEN_SHAPE.test(v)) return true
  const s = v.trim()
  return s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && entropy(s) >= 4
}

/** A header (`Name: value`) whose name says secret, or whose value is a scheme and a credential (`Bearer …`). */
function redactHeader(v: string): string | undefined {
  const h = /^([A-Za-z][\w-]*):(\s*)([\s\S]+)$/.exec(v)
  if (!h || /^[A-Za-z]$/.test(h[1]!) || h[3]!.startsWith('/')) return undefined // `C:\…`, `scheme:/…`
  return looksSecretName(h[1]!) ? `${h[1]}:${h[2]}${MASK}` : undefined
}

/**
 * A value on its own (a positional, or the value of an option that is not secret by name): `NAME=value` with a secret NAME,
 * a header with a secret name, or a credential shape. A value that is itself a command line (`-c "API_KEY=x run --password y"`)
 * gets the same rules inside it: a secret-named `NAME=value` or `--flag value` / `--flag=value` keeps the name, loses the value.
 */
function redactValue(v: string): string {
  const named = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(v)
  if (named && looksSecretName(named[1]!) && !/\s/.test(named[2]!)) return `${named[1]}=${MASK}`
  const header = redactHeader(v)
  if (header !== undefined) return header
  return v
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(/\b(Bearer|Basic)\s+\S+/gi, `$1 ${MASK}`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s"'&|;]+)/g, (m, name: string) => (looksSecretName(name) ? `${name}=${MASK}` : m))
    .replace(/(^|\s)(--?[A-Za-z][\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g, (m, lead: string, flag: string, sep: string) => (looksSecretName(flag) ? `${lead}${flag}${sep}${MASK}` : m))
    .replace(TOKEN_SHAPE, MASK)
    .replace(LONG_BLOB, MASK)
}

/** `name:password` of curl's `-u` / `--user`: the part after the colon goes; `uid:gid` numbers and drive paths stay. */
function redactUserPass(v: string): string {
  const m = /^([^:\s/\\]+):(.+)$/.exec(v)
  if (!m || /^\d+:\d+$/.test(v) || /^[A-Za-z]$/.test(m[1]!)) return redactValue(v)
  return `${m[1]}:${MASK}`
}

/** `-p<value>` glued (mysql's password): masked unless a number, a port mapping or a lowercase word (`-print`, `-pthread`). */
function gluedPassword(a: string): boolean {
  const m = /^-p(.+)$/.exec(a)
  return m !== null && !/^[\d.:,/-]+$/.test(m[1]!) && !/^[a-z]+\d?$/.test(m[1]!)
}

/** `/name:value` (Windows style): masked when the name is secret, or for `/p:` when the value is not a `Property=value`. */
function redactSlash(a: string): string | undefined {
  const m = /^\/([A-Za-z][\w-]*):([\s\S]+)$/.exec(a)
  if (!m) return undefined
  const [, name, value] = m as unknown as [string, string, string]
  if (looksSecretName(name)) return `/${name}:${MASK}`
  if (name.toLowerCase() === 'p') {
    const prop = /^([A-Za-z_][\w.-]*)=/.exec(value)
    if (!prop) return `/${name}:${MASK}`
    return looksSecretName(prop[1]!) ? `/${name}:${prop[1]}=${MASK}` : a
  }
  return undefined
}

const USER_FLAGS = new Set(['-u', '--user'])

/** The args as a view may show them. A secret-looking option keeps its name, its value (`--k=v` or the next word) is masked. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = []
  let next: 'secret' | 'user' | undefined
  for (const a of args) {
    const was = next
    next = undefined
    if (was === 'secret' && !/^--[A-Za-z]/.test(a)) { out.push(MASK); continue }
    if (was === 'user' && !a.startsWith('-')) { out.push(redactUserPass(a)); continue }
    if (!a.startsWith('-')) { out.push(redactSlash(a) ?? redactValue(a)); continue }
    if (gluedPassword(a)) { out.push(`-p${MASK}`); continue }
    const eq = a.indexOf('=')
    if (eq < 0) {
      out.push(a)
      next = looksSecretName(a) ? 'secret' : USER_FLAGS.has(a) ? 'user' : undefined
      continue
    }
    const flag = a.slice(0, eq)
    const value = a.slice(eq + 1)
    out.push(looksSecretName(flag) ? `${flag}=${MASK}` : `${flag}=${USER_FLAGS.has(flag) ? redactUserPass(value) : redactValue(value)}`)
  }
  return out
}
