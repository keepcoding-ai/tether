// Launch arguments, made safe to show: option names stay, the values of options that look like a key, token or password do not.
// Pure and free of node imports (the renderer uses it). The same idea that keeps an env value out of a view: what is shown is
// only what does not look like a secret.
const SECRET_NAME = /(token|secret|key|passw(or)?d|passwd|auth|credential|cookie|bearer)/i
const MASK = '[redacted]'
const TOKEN_SHAPE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_\w{10,}|github_pat_\w+|xox[a-z]-[\w-]+|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w.-]+)/g
const LONG_BLOB = /\b[A-Za-z0-9+/_-]{40,}\b/g

/**
 * A value on its own (a positional, or the value of an option that is not secret by name): `NAME=value` with a secret NAME,
 * or a credential shape. A value that is itself a command line (`-c "API_KEY=x run --password y"`) gets the same rules
 * inside it: a secret-named `NAME=value` or `--flag value` / `--flag=value` keeps the name, loses the value.
 */
function redactValue(v: string): string {
  const named = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(v)
  if (named && SECRET_NAME.test(named[1]!) && !/\s/.test(named[2]!)) return `${named[1]}=${MASK}`
  return v
    .replace(/\b(Bearer|Basic)\s+\S+/gi, `$1 ${MASK}`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s"']+)/g, (m, name: string) => (SECRET_NAME.test(name) ? `${name}=${MASK}` : m))
    .replace(/(^|\s)(--?[A-Za-z][\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g, (m, lead: string, flag: string, sep: string) => (SECRET_NAME.test(flag) ? `${lead}${flag}${sep}${MASK}` : m))
    .replace(TOKEN_SHAPE, MASK)
    .replace(LONG_BLOB, MASK)
}

/** The args as a view may show them. A secret-looking option keeps its name, its value (`--k=v` or the next word) is masked. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = []
  let maskNext = false
  for (const a of args) {
    if (maskNext && !a.startsWith('-')) { out.push(MASK); maskNext = false; continue }
    maskNext = false
    if (!a.startsWith('-')) { out.push(redactValue(a)); continue }
    const eq = a.indexOf('=')
    if (eq < 0) { out.push(a); maskNext = SECRET_NAME.test(a); continue }
    const flag = a.slice(0, eq)
    out.push(SECRET_NAME.test(flag) ? `${flag}=${MASK}` : `${flag}=${redactValue(a.slice(eq + 1))}`)
  }
  return out
}
