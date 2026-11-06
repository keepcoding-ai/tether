// Where the Atrium Bridge's SOURCE checkout is, for the two scripts that run its toolchain (`npm run bridge:build`,
// extensions/web-bridge/build.mjs; and the bridge step of `npm run brand:derive`, app/brand-derive.mjs). The bridge is
// not a dependency of the tether: the tether vendors the bridge's BUILD (vendor/), and only these scripts need the
// source. Resolution, first match wins:
//   1. `--bridge <dir>` on the command line;
//   2. TETHER_BRIDGE_SRC in the environment;
//   3. ../../chrome-extensions/bridge next to this repository (the atrium monorepo layout: workspace/tether and
//      chrome-extensions/bridge under the same root).
// Pure rules (no spawn), so the unit test covers them without a bridge checkout on the machine.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const BRIDGE_SRC_ENV = 'TETHER_BRIDGE_SRC'
export const BRIDGE_SRC_FLAG = '--bridge'

/** The monorepo location: <root>/../../chrome-extensions/bridge. */
export const defaultBridgeSource = (root: string): string => resolve(root, '..', '..', 'chrome-extensions', 'bridge')

export interface BridgeSource {
  dir: string
  origin: 'arg' | 'env' | 'default'
}

/** The bridge checkout the scripts use; `args` is process.argv.slice(2). */
export function resolveBridgeSource(root: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): BridgeSource {
  const i = args.indexOf(BRIDGE_SRC_FLAG)
  const arg = i !== -1 ? args[i + 1] : undefined
  if (arg) return { dir: resolve(arg), origin: 'arg' }
  const fromEnv = env[BRIDGE_SRC_ENV]?.trim()
  if (fromEnv) return { dir: resolve(fromEnv), origin: 'env' }
  return { dir: defaultBridgeSource(root), origin: 'default' }
}

/** The files a usable bridge checkout has: the two scripts and its installed dependencies (esbuild builds, playwright derives). */
export const BRIDGE_SRC_MARKERS = ['scripts/build.ts', 'scripts/brand-derive.ts', 'node_modules/esbuild', 'node_modules/playwright-core'] as const

/** What is missing for `dir` to be a bridge checkout the scripts can run. Empty = usable. */
export function bridgeSourceProblems(dir: string, exists: (p: string) => boolean = existsSync): string[] {
  if (!exists(dir)) return [`${dir}: pasta não existe`]
  return BRIDGE_SRC_MARKERS.filter(m => !exists(join(dir, m))).map(m => `${join(dir, m)}: ausente${m.startsWith('node_modules') ? ' (rode npm ci no bridge)' : ''}`)
}

/** The one-line explanation of how the source was chosen and how to point elsewhere, for logs and errors. */
export function describeBridgeSource(src: BridgeSource): string {
  const how = src.origin === 'arg' ? BRIDGE_SRC_FLAG : src.origin === 'env' ? BRIDGE_SRC_ENV : 'padrão ../../chrome-extensions/bridge'
  return `${src.dir} (${how}; mude com ${BRIDGE_SRC_FLAG} <pasta> ou ${BRIDGE_SRC_ENV}=<pasta>)`
}
