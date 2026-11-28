// The ceilings on what a device creates from afar (RR5 M-2): agents and terminals ("+ Novo", extensions/regency/daemon.ts
// Creator) and background processes ("Novo processo", the `remote` client's `proc-start` with a recipe in server.ts). Each
// one is a process of the machine that comes back at every start of tetherd, so a device left unlocked (or a page that is
// not the person's) must not be able to fill the house in minutes. tetherd keeps the rule, never only the portal.
//
// Three ceilings per kind, each refused `too-many`:
// - per device and per hour: what one phone may create in a sliding hour;
// - per house and per hour: every device together, so pairing a second phone does not double it;
// - live in the house: how many of the kind created from afar exist and run (or will run at the next start), read by the
//   caller from what tetherd keeps on disk (a slot's `createdBy`, a process's card), so it holds across restarts.
// The hourly windows live in memory (a restart of tetherd starts them again; the live ceiling still holds). Memory: one
// list of at most `perDeviceHour` timestamps per device that created in the last hour, and one per kind for the house.

export interface AfarCeiling { perDeviceHour: number; houseHour: number; houseLive: number }

/**
 * The numbers. A person creating from the phone makes a few agents in a sitting; six an hour leaves room for that and for a
 * retry, and stops a loop at the seventh. Twelve an hour for the house: two devices at their own ceiling. Live: sixteen
 * agents or terminals made from afar is already more than a machine runs well side by side (each is a process of the
 * engine with its MCP); processes are servers that hold ports and memory, eight.
 */
export const AFAR_CAPS = {
  slots: { perDeviceHour: 6, houseHour: 12, houseLive: 16 },
  procs: { perDeviceHour: 6, houseHour: 12, houseLive: 8 },
} as const satisfies Record<string, AfarCeiling>
export type AfarKind = keyof typeof AFAR_CAPS

export const AFAR_HOUR_MS = 3_600_000

/** A device's id as the portal names it (16 bytes, hex); anything else counts as the one unnamed device. */
const DEVICE_RE = /^[0-9a-f]{32}$/
export const afarDevice = (v: unknown): string => (typeof v === 'string' && DEVICE_RE.test(v) ? v : '?')

export class AfarCaps {
  readonly #made = new Map<string, number[]>()
  readonly #now: () => number
  readonly #caps: Record<AfarKind, AfarCeiling>

  constructor(opts: { now?: () => number; caps?: Record<AfarKind, AfarCeiling> } = {}) {
    this.#now = opts.now ?? Date.now
    this.#caps = opts.caps ?? AFAR_CAPS
  }

  /**
   * Takes one creation of `kind` by `device`, or says no: `live` is how many of the kind made from afar exist now. A creation
   * taken counts even when the launch fails afterwards (a failing loop is refused all the same).
   */
  take(kind: AfarKind, device: string, live: number): boolean {
    const c = this.#caps[kind]
    if (live >= c.houseLive) return false
    const now = this.#now()
    const mine = this.#recent(`${kind}:${device}`, now)
    const house = this.#recent(`${kind}:*`, now)
    if (mine.length >= c.perDeviceHour || house.length >= c.houseHour) return false
    mine.push(now)
    house.push(now)
    this.#made.set(`${kind}:${device}`, mine)
    this.#made.set(`${kind}:*`, house)
    return true
  }

  /** The creations of a key within the last hour; a key with none is dropped. */
  #recent(key: string, now: number): number[] {
    const kept = (this.#made.get(key) ?? []).filter((t) => now - t < AFAR_HOUR_MS)
    if (kept.length === 0) this.#made.delete(key)
    return kept
  }
}
