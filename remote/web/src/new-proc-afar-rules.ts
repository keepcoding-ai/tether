// "Novo processo" from afar (RR5 5.5, fio-spec 18 I8 and I9), the pure rules of the web's form: each field checked as the
// app's form checks it (extensions/regency/new-process-rules.ts, the repo's one rule of what looks like a secret) and
// within the portal's ceilings (src/remote/procs-new.ts), before anything is sent. From afar a secret is never taken:
// a variable whose name or value looks like one, or a command that carries one, is barred here with the advice to put
// the secret in the command itself (`dotenvx run -- …`), and there is no "create anyway". The body is built for the one
// call that sends it; nothing here keeps a value, and no sentence ever holds one.
import { ENV_WARNING, envError, filledRows, maskedCommand, parsePorts, procNameError, secretNames, splitCommand, type NewProcEnvRow } from '../../../extensions/regency/new-process-rules.ts'
import { parseArgs } from '../../../app/renderer/args.ts'
import {
  ENV_MAX, ENV_NAME_RE, ENV_VALUE_MAX, PORTS_MAX, PROC_ARGS_MAX, PROC_COMMAND_MAX, PROC_DESCRIPTION_MAX,
} from '../../../src/remote/procs-new.ts'
import { FOLDER_ID_RE } from '../../../src/remote/create.ts'

export { ENV_WARNING }

/** What the form holds when the person presses "Criar" (the values only in this call's hands). */
export interface AfarProcForm {
  name: string
  command: string
  /** The tether's id of the folder (create.options), never a path. */
  folder: string
  ports: string
  description: string
  env: readonly NewProcEnvRow[]
}

export type AfarProcField = 'name' | 'command' | 'cwd' | 'ports' | 'description' | 'env'

/** The body of `procs.new` (src/remote/procs-new.ts), exactly the portal's keys. */
export interface AfarProcBody {
  name: string
  command: string
  folder: string
  ports?: number[]
  description?: string
  env?: { name: string; value: string }[]
}

export type AfarProcCheck =
  | { ok: true; body: AfarProcBody }
  | { ok: false; field: AfarProcField; error: string; envIndex?: number }

const CONTROL = /[\u0000-\u001f\u007f]/

/** The advice where a secret was about to go: the names only (never a value, never a word of the command). */
export function secretBar(names: readonly string[], command: boolean): string {
  const tail = 'Segredo não vai por aqui: ponha-o no próprio comando, por exemplo `dotenvx run -- …`.'
  if (names.length === 0) return `O comando parece levar um segredo. ${tail}`
  const list = names.length < 2 ? names[0]! : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
  const verb = names.length < 2 ? 'parece um segredo' : 'parecem segredos'
  return `${list} ${verb}${command ? ', e o comando também parece levar um' : ''}. ${tail}`
}

/** Checks the form field by field, in the order drawn, and builds the body; a secret is barred, never asked. */
export function checkAfarProc(form: AfarProcForm, existing: readonly string[]): AfarProcCheck {
  const nameErr = procNameError(form.name, existing)
  if (nameErr) return { ok: false, field: 'name', error: nameErr }
  const line = form.command.trim()
  if (form.command.length > PROC_COMMAND_MAX) return { ok: false, field: 'command', error: `O comando passa de ${PROC_COMMAND_MAX} letras.` }
  if (/[\r\n]/.test(form.command)) return { ok: false, field: 'command', error: 'O comando é uma linha só.' }
  const split = splitCommand(line)
  if ('error' in split) return { ok: false, field: 'command', error: split.error }
  if (parseArgs(line).length > PROC_ARGS_MAX) return { ok: false, field: 'command', error: `O comando passa de ${PROC_ARGS_MAX} palavras.` }
  const commandSecret = maskedCommand(line) !== line
  if (!FOLDER_ID_RE.test(form.folder)) return { ok: false, field: 'cwd', error: 'Escolha a pasta em que o processo roda.' }
  const ports = parsePorts(form.ports)
  if ('error' in ports) return { ok: false, field: 'ports', error: ports.error }
  if (ports.ports.length > PORTS_MAX) return { ok: false, field: 'ports', error: `São até ${PORTS_MAX} portas.` }
  const description = form.description.replace(/\s+/g, ' ').trim()
  if (description.length > PROC_DESCRIPTION_MAX) return { ok: false, field: 'description', error: `A descrição passa de ${PROC_DESCRIPTION_MAX} letras.` }
  const bad = envError(form.env)
  if (bad) return { ok: false, field: 'env', error: bad.error, envIndex: bad.index }
  const rows = filledRows(form.env)
  if (rows.length > ENV_MAX) return { ok: false, field: 'env', error: `São até ${ENV_MAX} variáveis.`, envIndex: rows[ENV_MAX]!.index }
  for (const { row, index } of rows) {
    const n = row.name.trim()
    if (!ENV_NAME_RE.test(n)) return { ok: false, field: 'env', error: `O nome ${n.slice(0, 64)}… passa de 64 letras.`, envIndex: index }
    if (row.value.length > ENV_VALUE_MAX) return { ok: false, field: 'env', error: `O valor de ${n} passa de ${ENV_VALUE_MAX} letras.`, envIndex: index }
    if (CONTROL.test(row.value)) return { ok: false, field: 'env', error: `O valor de ${n} tem um caractere que não vai (uma quebra de linha, um controle).`, envIndex: index }
  }
  const secrets = secretNames(form.env)
  if (secrets.length > 0) {
    const index = rows.find(r => secrets.includes(r.row.name.trim()))?.index
    return { ok: false, field: 'env', error: secretBar(secrets, commandSecret), ...(index !== undefined ? { envIndex: index } : {}) }
  }
  if (commandSecret) return { ok: false, field: 'command', error: secretBar([], true) }
  const env = rows.map(({ row }) => ({ name: row.name.trim(), value: row.value }))
  return {
    ok: true,
    body: {
      name: form.name.trim(), command: line, folder: form.folder,
      ...(ports.ports.length > 0 ? { ports: ports.ports } : {}), ...(description ? { description } : {}), ...(env.length > 0 ? { env } : {}),
    },
  }
}

/** The sentence of what is going to run, said before the system asks for the biometrics (no value of a variable in it). */
export function runLine(body: Pick<AfarProcBody, 'name' | 'command' | 'env'>, folderLabel: string | undefined): string {
  const vars = body.env?.length ? ` com ${body.env.length === 1 ? '1 variável' : `${body.env.length} variáveis`} (${body.env.map(e => e.name).join(', ')})` : ''
  return `"${body.name}" vai rodar ${body.command}${folderLabel ? ` na pasta ${folderLabel}` : ''}${vars}.`
}

/** The portal's refusal of a new process, in the form's words and at its field. */
export function afarProcRefusal(code: string, body: Record<string, unknown> | undefined, words: (code: string) => string): { field?: AfarProcField; text: string } {
  const names = Array.isArray(body?.names) ? body!.names.filter((n): n is string => typeof n === 'string') : []
  switch (code) {
    case 'secret-env': return { field: 'env', text: secretBar(names, false) }
    case 'secret-command': return { field: 'command', text: secretBar([], true) }
    case 'proc-exists': return { field: 'name', text: 'Já existe um processo com esse nome: escolha outro nome (de longe uma receita nunca troca outra).' }
    case 'unknown-folder': return { field: 'cwd', text: 'Essa pasta não está mais na lista do tether: escolha outra.' }
    case 'port-busy': return { field: 'ports', text: 'Uma das portas já está ocupada na máquina. Escolha outra porta.' }
    default: return { text: words(code) }
  }
}
