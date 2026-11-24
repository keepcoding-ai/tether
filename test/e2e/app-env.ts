// The one place that decides the environment of a test app. A tether pane exports the person's own state (TETHER_USER_DIR, the
// real home and pipe, slot keys): an app launched from such a shell must never see it, or it reads (and writes) the real settings.
// `electron.ts` applies `guardAppEnv` to every `_electron.launch`, so no test has to remember it.
import { isAbsolute, resolve, sep } from 'node:path'
import { userDir } from '../../src/core/paths.ts'
import { testTmpBases } from '../kill.ts'

/** Variables a tether pane exports that name real state or a real pane: dropped when the test only inherited them. */
const PANE_VARS = new Set(['TETHER_USER_DIR', 'TETHER_SLOT_ID', 'TETHER_TAB_URL', 'TETHER_OPEN_CWD', 'TETHER_CLI', 'TETHER_AGENT', 'TETHER_NODE', 'TETHER_CLAUDE_ARGS'])
/** Variables every test app must override with a private value. */
const MUST_OVERRIDE = ['TETHER_HOME', 'TETHER_PIPE'] as const

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

/** True when `dir` is a test temp base or lies inside one. */
export function underTestTmp(dir: string): boolean {
  if (!isAbsolute(dir)) return false
  const d = norm(dir)
  return testTmpBases().some(b => d.startsWith(norm(b) + sep))
}

/**
 * The environment a test app may start with: inherited pane variables removed, then checked. Throws (the app never opens) when
 * TETHER_HOME or TETHER_PIPE is still the inherited real one, or when the preferences folder the app would resolve is not
 * inside a test temp folder.
 */
export function guardAppEnv(env: Record<string, string | undefined>, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const inherited = parent[k] === v
    if (inherited && k.startsWith('TETHER_') && (PANE_VARS.has(k) || k.endsWith('_KEY'))) continue
    out[k] = v
  }
  for (const k of MUST_OVERRIDE) {
    if (out[k] === undefined || out[k] === parent[k]) throw new Error(`test app refused: ${k} is not a private test value`)
  }
  const prefs = userDir(out)
  if (!underTestTmp(prefs)) throw new Error(`test app refused: its preferences folder ${prefs} is not inside a test temp folder`)
  return out
}
