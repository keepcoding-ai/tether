// `tether doctor`, the hands' checks (contributed by extensions/hands): the program and its report variable, and the copy of
// node its panels run as (tether-hands). The pure parts (`checkHands`, `checkHandsExe`) take their facts as arguments for the
// unit tests; the probes gather them. Derived from the soul's checks in doctor.ts and kept apart: each program evolves alone.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { cleanEnv } from './agents/claude.ts'
import { ENV_HANDS_REPORT, ENV_HANDS_SLOT, resolveHandsCommand } from './agents/hands.ts'
import { inspectRenamedNode, isNodeExecutable, type ExeStatus } from './core/exe-sync.ts'
import { tetherHome } from './core/paths.ts'
import type { CheckResult } from './doctor.ts'

export interface HandsProbe {
  command: string
  found: boolean
  versionOutput: string | undefined
  /** Text of the hands' own files (bin/hands and the dist/hands.mjs it imports); undefined when none was found. */
  sourceText: string | undefined
}

export function checkHands(p: HandsProbe): CheckResult {
  if (!p.found) return { level: 'AVISO', name: 'hands', detail: 'não encontrado no PATH', hint: 'só importa se você usa o hands: instale-o ou aponte TETHER_HANDS_CMD' }
  const version = /(\d+\.\d+\.\d+)/.exec(p.versionOutput ?? '')?.[1]
  if (!version) return { level: 'ERRO', name: 'hands', detail: `${p.command} não respondeu a --version`, hint: 'rode `hands --version` à mão e veja o erro' }
  const base = `${version} (${p.command})`
  if (p.sourceText === undefined) return { level: 'AVISO', name: 'hands', detail: `${base}; suporte a ${ENV_HANDS_REPORT} não verificável sem conversa`, hint: 'abra o hands por um slot do tether e veja se o vínculo aparece' }
  if (p.sourceText.includes(ENV_HANDS_REPORT)) return { level: 'OK', name: 'hands', detail: `${base}, com ${ENV_HANDS_REPORT}` }
  return { level: 'AVISO', name: 'hands', detail: `${base} sem ${ENV_HANDS_REPORT}: o tether não saberá qual sessão está na tela`, hint: 'atualize o hands para uma versão que reporte a sessão' }
}

/** The copy of node the hands' panels run as; nothing to say when the hands command is not a node (an .exe, a bash launcher). */
export function checkHandsExe(s: ExeStatus, handsIsNode: boolean, platform: NodeJS.Platform = process.platform): CheckResult {
  const name = 'executável do hands'
  if (!handsIsNode) return { level: 'OK', name, detail: 'o comando do hands não é um node: nada a renomear' }
  if (platform === 'darwin') {
    if (s.present) return { level: 'AVISO', name, detail: `resíduo que o dyld recusa: ${s.path}`, hint: 'apague o arquivo em <TETHER_HOME>/bin (o link/cópia do node não roda no macOS)' }
    return { level: 'OK', name, detail: 'tether-hands roda pelo node real com o nome por exec -a' }
  }
  if (s.stamp?.method === 'fallback') return { level: 'AVISO', name, detail: `tether-hands: node original (${s.stamp.reason ?? 'sem motivo registrado'})`, hint: 'o hands roda com o node original até a cópia funcionar: confira permissões e espaço em <TETHER_HOME>/bin' }
  if (!s.present) return { level: 'OK', name, detail: 'tether-hands: ainda não criado (nasce no primeiro painel do hands)' }
  const how = s.stamp?.method === 'hardlink' ? 'link' : 'cópia'
  return { level: 'OK', name, detail: `tether-hands: ${how} de ${s.stamp?.source ?? '?'}${s.outdated ? ', desatualizada' : ''}` }
}

/** An executable on PATH (Windows: with .exe/.cmd/.bat). Kept here: tetherd imports this file, never shell-sync.ts. */
function onPath(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n)
  }
  return undefined
}

/** bin/hands and the bundle it imports (bin/hands → ../dist/hands.mjs). */
function handsSourceText(command: string, args: string[]): string | undefined {
  const script = args[0] && (isAbsolute(args[0]) || existsSync(args[0])) ? args[0] : command
  if (!existsSync(script)) return undefined
  const parts: string[] = []
  try { parts.push(readFileSync(script, 'utf8')) } catch { return undefined }
  try { parts.push(readFileSync(resolve(dirname(script), '..', 'dist', 'hands.mjs'), 'utf8')) } catch { /* no bundle next to it: the script alone decides */ }
  return parts.join('\n')
}

export async function probeHands(): Promise<CheckResult> {
  let command: string, args: string[]
  try { ({ command, args } = await resolveHandsCommand()) } catch (e) { return { level: 'ERRO', name: 'hands', detail: (e as Error).message, hint: 'corrija TETHER_HANDS_CMD' } }
  const found = command !== 'hands' && (existsSync(command) || onPath(command) !== undefined)
  if (!found) return checkHands({ command, found: false, versionOutput: undefined, sourceText: undefined })
  const env = cleanEnv()
  delete env[ENV_HANDS_REPORT]
  delete env[ENV_HANDS_SLOT]
  const r = spawnSync(command, [...args, '--version'], { encoding: 'utf8', env, timeout: 20_000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) })
  return checkHands({ command: args[0] ?? command, found: true, versionOutput: `${r.stdout ?? ''}${r.stderr ?? ''}`, sourceText: handsSourceText(command, args) })
}

export async function probeHandsExe(): Promise<CheckResult> {
  let handsIsNode = false
  try { handsIsNode = isNodeExecutable((await resolveHandsCommand()).command) } catch { /* reported by probeHands */ }
  return checkHandsExe(inspectRenamedNode(tetherHome(), 'tether-hands'), handsIsNode)
}
