// The tether's settings that reach the bridge through its config.json `capabilities` (tether-bridge-debug T1). The bridge
// daemon re-reads config.json by mtime and pushes `capabilities` to the browser extension (its `config` message), so a
// write here takes effect live, without a daemon, agent or app restart. Before this, `agentWindows` and `evaluate` only
// seeded a fresh installation once (bridge-home.ts seedCapabilities) and a later change on the settings page reached nothing;
// `agentWindows` also seeded the wrong key (the bridge reads `windowPerAgent`).
//
// What the tether owns in `capabilities`, and when it writes it:
//   evaluate        ← extensions.web-bridge.evaluate       written when the person set it (settings.json holds a valid
//   windowPerAgent  ← extensions.web-bridge.agentWindows   value), and at a live change of it, the reset included: an
//                                                          installation that chose its own value keeps it until then
//   debug           ← extensions.web-bridge.debug          true while on; false when turned off (left out while it was
//                                                          never on: absent = off)
//   debugCallTimeoutMs ← extensions.web-bridge.debugCallTimeoutSec  the milliseconds as a string ("0" = no deadline), only
//                                                          while debug is on and the person set it; else left out (the
//                                                          daemon's default, 60 s)
// Every other key (download, upload, pdf, readNetwork, a key a newer bridge adds) is kept as it is. A config without
// `capabilities` is not touched: the first tetherd start seeds the package's defaults (seedCapabilities) and applies these
// right after. Writes go through the bundle's setCapabilities (the bridge's own config lock). No secret is read or logged:
// only `capabilities` of the config is looked at.
import type { SettingReader } from '../../app/shared/vscode-configuration-registry.ts'

export type Capabilities = Record<string, boolean | string>

/** The setting behind each tether-owned capability that mirrors a setting one to one. */
const MIRRORED = { evaluate: 'evaluate', windowPerAgent: 'agentWindows' } as const

/** The settings whose change rewrites the capabilities. */
export const CAPABILITY_SETTINGS = ['evaluate', 'agentWindows', 'debug', 'debugCallTimeoutSec'] as const

/** Whether the debug mode is on (the icon's amber, the popover's line, the doctor's line). */
export const bridgeDebugOn = (s: { get(key: string): unknown }): boolean => s.get('debug') === true

/** Seconds as typed on the settings page → the capability's string of whole milliseconds ("0" = no deadline). */
const msText = (sec: number): string => String(Math.max(0, Math.round(sec * 1000)))

/**
 * `current` with the tether's part applied from the settings. `changed` names the settings the person just changed (a live
 * change): a mirrored one among them is written even when unset (it was reset to its default). Pure.
 */
export function withTetherCapabilities(current: Capabilities, s: SettingReader, changed: readonly string[] = []): Capabilities {
  const next: Capabilities = { ...current }
  for (const [cap, key] of Object.entries(MIRRORED)) {
    const v = s.get(key)
    if ((s.isSet(key) || changed.includes(key)) && (typeof v === 'boolean' || typeof v === 'string')) next[cap] = v
  }
  const on = bridgeDebugOn(s)
  if (on) next.debug = true
  else if ('debug' in next) next.debug = false
  const timeout = s.get('debugCallTimeoutSec')
  if (on && s.isSet('debugCallTimeoutSec') && typeof timeout === 'number') next.debugCallTimeoutMs = msText(timeout)
  else delete next.debugCallTimeoutMs
  return next
}

/** Same keys with the same values (order does not count). */
export function sameCapabilities(a: Capabilities, b: Capabilities): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && a[k] === b[k])
}

/** What the writer needs of the bridge bundle (chrome-extensions/bridge daemon/src/bundle.ts). */
export interface CapabilitiesBundle {
  readConfig(home: string): { capabilities?: Capabilities } | null
  setCapabilities(home: string, capabilities: Capabilities | null): void
}

/**
 * Applies the tether's part to <bridge home>/config.json. `skipped`: no config yet, or a config whose capabilities were never
 * seeded (the tetherd start does both, then applies this).
 */
export function applyCapabilities(b: CapabilitiesBundle, bridgeHome: string, s: SettingReader, changed: readonly string[] = []): 'written' | 'unchanged' | 'skipped' {
  const current = b.readConfig(bridgeHome)?.capabilities
  if (!current) return 'skipped'
  const next = withTetherCapabilities(current, s, changed)
  if (sameCapabilities(current, next)) return 'unchanged'
  b.setCapabilities(bridgeHome, next)
  return 'written'
}

/**
 * The live writer (Electron main): `sync(changed)` applies the settings in force, one write at a time. Called at activation
 * (changed = []) and at every change of a CAPABILITY_SETTINGS setting. The bundle is loaded at the first call; a failure is
 * logged, never thrown.
 */
export function createCapabilitiesWriter(o: {
  bridgeHome: string
  settings: SettingReader
  load(): Promise<CapabilitiesBundle>
  log(msg: string): void
}): { sync(changed?: readonly string[]): Promise<void> } {
  let chain: Promise<void> = Promise.resolve()
  let lastDebug = false
  const once = async (changed: readonly string[]): Promise<void> => {
    try {
      const r = applyCapabilities(await o.load(), o.bridgeHome, o.settings, changed)
      const on = bridgeDebugOn(o.settings)
      if (r === 'written' && on !== lastDebug) o.log(`modo de depuração ${on ? 'ligado' : 'desligado'} (capabilities do bridge gravadas)`)
      if (r !== 'skipped') lastDebug = on
    } catch (e) {
      const code = (e as { code?: unknown } | undefined)?.code
      o.log(`capabilities do bridge não gravadas: ${typeof code === 'string' ? code : e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { sync: (changed = []) => (chain = chain.then(() => once(changed))) }
}

/** The doctor's words: "desligada", or "ligada" with the call deadline in force. */
export function bridgeDebugSummary(s: SettingReader): string {
  if (!bridgeDebugOn(s)) return 'desligada'
  const t = s.get('debugCallTimeoutSec')
  const deadline = !s.isSet('debugCallTimeoutSec') || typeof t !== 'number' ? 'o normal' : t === 0 ? 'sem prazo' : `${t} s`
  return `ligada (prazo de cada chamada: ${deadline})`
}
