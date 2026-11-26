// The rules of the Regency's "Novo processo" form, pure: the checks of each field (name, command, folder, ports, variables),
// the secret-looking variable names (the repo's one rule, core/redact-args.ts), the question that asks before creating with
// one, the request the form sends (the same `proc-start` with a recipe that `tether proc start <nome> … -- <comando…>` sends)
// and the daemon's refusal in plain words with every typed value masked. No DOM, no `ui`.
//
// Secrets: a variable's VALUE goes only into the request this file builds; nothing here keeps it, logs it or puts it in a
// sentence. `maskEcho` takes the values out of any text that might echo the recipe before it is shown.
import { parseArgs } from '../../app/renderer/args.ts'
import { looksSecretName, looksSecretValue } from '../../src/core/redact-args.ts'

/** The process name tetherd accepts: the same as PROC_NAME_RE (src/daemon/procs.ts, a node module the renderer does not load). */
export const PROC_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A variable name the form takes (letters, digits and _, not starting with a digit). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The fixed line beside the variables. */
export const ENV_WARNING = 'Aqui não é lugar de senha nem chave.'
/** What stands for a value in a shown text. */
export const VALUE_MASK = '•••'
/** A value shorter than this is not masked inside a text (a "1" would eat every digit of a sentence; it is no secret). */
export const MASK_MIN = 4

export interface NewProcEnvRow { name: string; value: string }

/** What the form holds when the person presses "Criar". */
export interface NewProcForm {
  name: string
  command: string
  cwd: string
  /** "3000, 5173" or "3000 5173"; empty: no port. */
  ports: string
  description: string
  env: readonly NewProcEnvRow[]
}

export type NewProcField = 'name' | 'command' | 'cwd' | 'ports' | 'description' | 'env'

/** The recipe as the daemon takes it (`ProcRecipe` of src/daemon/procs.ts, structurally). */
export interface NewProcRecipe {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  ports: number[]
  description?: string
}

export interface NewProcRequest { name: string; recipe: NewProcRecipe }

export type NewProcCheck =
  | { ok: true; request: NewProcRequest; secretNames: string[] }
  | { ok: false; field: NewProcField; error: string; envIndex?: number }

// ---------------------------------------------------------------- the fields

/** The name: tetherd's rule, and not one the list already has (starting a known name with a recipe would change its recipe). */
export function procNameError(name: string, existing: readonly string[]): string | undefined {
  const n = name.trim()
  if (n === '') return 'Dê um nome ao processo.'
  if (!PROC_NAME.test(n)) return 'Use letras minúsculas, dígitos, - e _ (até 64), começando por letra ou dígito. Ex.: atrium-web.'
  if (existing.includes(n)) return `Já existe um processo "${n}": escolha outro nome (ou inicie o que existe pela lista).`
  return undefined
}

/** The command line in argv (quotes group words); an empty line is an error. */
export function splitCommand(text: string): { command: string; args: string[] } | { error: string } {
  const argv = parseArgs(text)
  if (argv.length === 0 || argv[0]!.trim() === '') return { error: 'Diga o comando que o processo roda. Ex.: npm run dev' }
  return { command: argv[0]!, args: argv.slice(1) }
}

/** An absolute folder (C:\…, \\server\…, or /…): tetherd takes only those. */
export function isAbsoluteFolder(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) || path.startsWith('/')
}

/** Zero or more ports, by comma or space; each one from 1 to 65535; repeated ones once. */
export function parsePorts(text: string): { ports: number[] } | { error: string } {
  const words = text.split(/[\s,;]+/).filter(w => w !== '')
  const ports: number[] = []
  for (const w of words) {
    const n = /^\d+$/.test(w) ? Number(w) : NaN
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: `"${w}" não é uma porta: use números de 1 a 65535, separados por vírgula.` }
    if (!ports.includes(n)) ports.push(n)
  }
  return { ports }
}

/** The rows that count: a row with neither name nor value is left out. */
export function filledRows(rows: readonly NewProcEnvRow[]): { row: NewProcEnvRow; index: number }[] {
  return rows.map((row, index) => ({ row, index })).filter(x => x.row.name.trim() !== '' || x.row.value !== '')
}

/** The first bad variable row: no name, a bad name, or a name already used (Windows reads names in any case). */
export function envError(rows: readonly NewProcEnvRow[]): { index: number; error: string } | undefined {
  const seen = new Set<string>()
  for (const { row, index } of filledRows(rows)) {
    const n = row.name.trim()
    if (n === '') return { index, error: 'Dê um nome à variável (ou apague a linha).' }
    if (!ENV_NAME.test(n)) return { index, error: `"${n}" não serve de nome de variável: use letras, dígitos e _, sem começar por dígito.` }
    const k = n.toUpperCase()
    if (seen.has(k)) return { index, error: `A variável ${n} aparece duas vezes.` }
    seen.add(k)
  }
  return undefined
}

/**
 * The names of the variables that look like a secret, by the same rules that mask arguments and names (core/redact-args.ts):
 * the name (`DB_PASS`), or the shape of the value (`postgres://u:senha@…`, a PEM block, `sk-…`, a long random word). Only the
 * names come out; the value is looked at here and nowhere said.
 */
export function secretNames(rows: readonly NewProcEnvRow[]): string[] {
  return filledRows(rows).filter(x => x.row.name.trim() !== '' && (looksSecretName(x.row.name.trim()) || looksSecretValue(x.row.value))).map(x => x.row.name.trim())
}

/** The question before creating with secret-looking names; the default answer is going back. */
export function secretQuestion(names: readonly string[]): string {
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
  const verb = names.length < 2 ? 'parece um segredo' : 'parecem segredos'
  return `${list} ${verb}. Segredo vai no próprio comando, por exemplo \`dotenvx run -- …\`. Criar mesmo assim?`
}

// ---------------------------------------------------------------- the whole form

/** Checks the form field by field (in the order they are drawn) and builds the request. */
export function checkNewProc(form: NewProcForm, existing: readonly string[]): NewProcCheck {
  const nameErr = procNameError(form.name, existing)
  if (nameErr) return { ok: false, field: 'name', error: nameErr }
  const cmd = splitCommand(form.command)
  if ('error' in cmd) return { ok: false, field: 'command', error: cmd.error }
  const cwd = form.cwd.trim()
  if (cwd === '') return { ok: false, field: 'cwd', error: 'Escolha a pasta em que o processo roda.' }
  if (!isAbsoluteFolder(cwd)) return { ok: false, field: 'cwd', error: 'A pasta precisa ser um caminho completo (ex.: C:\\projetos\\web).' }
  const ports = parsePorts(form.ports)
  if ('error' in ports) return { ok: false, field: 'ports', error: ports.error }
  const bad = envError(form.env)
  if (bad) return { ok: false, field: 'env', error: bad.error, envIndex: bad.index }
  const env: Record<string, string> = {}
  for (const { row } of filledRows(form.env)) env[row.name.trim()] = row.value
  const description = form.description.replace(/\s+/g, ' ').trim()
  return {
    ok: true,
    request: { name: form.name.trim(), recipe: { command: cmd.command, args: cmd.args, cwd, env, ports: ports.ports, ...(description ? { description } : {}) } },
    secretNames: secretNames(form.env),
  }
}

// ---------------------------------------------------------------- the daemon's answer, shown

/** `text` with every value of `values` (long enough to matter) replaced by the mask; the longest first. */
export function maskEcho(text: string, values: readonly string[]): string {
  const vs = [...new Set(values.filter(v => v.length >= MASK_MIN))].sort((a, b) => b.length - a.length)
  let out = text
  for (const v of vs) out = out.split(v).join(VALUE_MASK)
  return out
}

/** The field a refusal belongs to (where the form shows it). */
export function refusalField(code: string): NewProcField | undefined {
  if (code === 'port-busy') return 'ports'
  if (code === 'proc-running' || code === 'unknown-proc') return 'name'
  return undefined
}

/**
 * tetherd's refusal in plain words, the values masked. The port's sentence keeps who holds it ("a porta 3000 já está ocupada
 * por node (pid 12)") and drops the CLI's advice (`tether proc ports`, `--force`), which the form has no use for.
 */
export function createRefusalText(code: string, message: string | undefined, values: readonly string[]): string {
  const m = maskEcho((message ?? '').replace(/\s+/g, ' ').trim(), values)
  switch (code) {
    case 'port-busy': {
      const who = /^não iniciei [^:]+: (.*?)(?:\. Escolha outra porta.*)?$/.exec(m)?.[1] ?? m
      return who ? `Não iniciei: ${who}. Escolha outra porta ou pare quem a ocupa.` : 'Uma das portas já está ocupada. Escolha outra porta.'
    }
    case 'proc-running': return 'Já existe um processo com esse nome rodando: escolha outro nome.'
    case 'bad-request': return m ? `O tether recusou: ${m}.`.replace(/\.\.$/, '.') : 'O tether recusou o pedido.'
    case 'proc-host': return 'O servidor de processos não respondeu. Tente de novo em instantes.'
    default: return m ? (/[.!?]$/.test(m) ? m : `${m}.`) : 'Não deu certo.'
  }
}
