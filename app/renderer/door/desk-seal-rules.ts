// The extensions' seals on the desk pills (TetherUi.desks.setSeal): who put which seal on which desk. Pure and free of the DOM,
// so the unit tests load it. One seal per extension per desk, the order on a pill is stable (by extension id), and everything
// an extension put goes when it goes (the BadgeBoard of seal-rules.ts is the mould). A seal never counts in the orange count:
// the pill reads it from here, not from the attention marks.
import type { DeskSeal } from '../ext-api.ts'
import { toDisposable, type IDisposable } from '../../shared/vscode-lifecycle.ts'

/** A seal as the pill draws it, with who put it. */
export interface PlacedSeal { ext: string; seal: DeskSeal }

/** The hue as a whole number 0-359 (a number out of range wraps); undefined when absent or not a number. */
export function normalizeHue(hue: number | undefined): number | undefined {
  if (typeof hue !== 'number' || !Number.isFinite(hue)) return undefined
  return ((Math.round(hue) % 360) + 360) % 360
}

/** The seal as kept: a named icon, a whole hue, a trimmed label (absent when empty), the tooltip trimmed. Undefined when there is nothing to draw (no icon name). */
export function normalizeSeal(seal: DeskSeal | undefined): DeskSeal | undefined {
  if (!seal || typeof seal.icon !== 'string' || seal.icon === '') return undefined
  const hue = normalizeHue(seal.hue)
  const label = typeof seal.label === 'string' ? seal.label.trim() : ''
  return { icon: seal.icon, ...(hue === undefined ? {} : { hue }), ...(label === '' ? {} : { label }), tooltip: typeof seal.tooltip === 'string' ? seal.tooltip.trim() : '' }
}

function sameSeal(a: DeskSeal, b: DeskSeal): boolean {
  return a.icon === b.icon && a.hue === b.hue && a.label === b.label && a.tooltip === b.tooltip
}

/** Seals by desk id, then by extension id. Every change tells the listeners (the pill draws again). */
export class DeskSealBoard {
  private readonly desks = new Map<string, Map<string, DeskSeal>>()
  private readonly listeners = new Set<() => void>()
  private sig = '[]'

  /** Sets (or, with `undefined` or nothing to draw, takes away) the seal of `ext` on `deskId`. Returns whether anything changed. */
  set(ext: string, deskId: string, seal: DeskSeal | undefined): boolean {
    const next = normalizeSeal(seal)
    const mine = this.desks.get(deskId)
    const prev = mine?.get(ext)
    if (!next) {
      if (!prev) return false
      mine!.delete(ext)
      if (mine!.size === 0) this.desks.delete(deskId)
    } else {
      if (prev && sameSeal(prev, next)) return false
      const bucket = mine ?? new Map<string, DeskSeal>()
      bucket.set(ext, next)
      this.desks.set(deskId, bucket)
    }
    this.changed()
    return true
  }

  /** The seals on a desk, in stable order (by extension id). */
  of(deskId: string): readonly PlacedSeal[] {
    const mine = this.desks.get(deskId)
    if (!mine) return []
    return [...mine].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ext, seal]) => ({ ext, seal }))
  }

  /** Takes away everything `ext` put (the extension went). Returns whether anything changed. */
  removeOwner(ext: string): boolean {
    let any = false
    for (const [deskId, mine] of [...this.desks]) {
      if (!mine.delete(ext)) continue
      any = true
      if (mine.size === 0) this.desks.delete(deskId)
    }
    if (any) this.changed()
    return any
  }

  /** What the pills show of every seal, as one string: equal strings mean nothing to repaint. */
  get signature(): string { return this.sig }

  onChange(listener: () => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private changed(): void {
    this.sig = JSON.stringify([...this.desks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id]) => [id, this.of(id).map(p => [p.ext, p.seal.icon, p.seal.hue ?? null, p.seal.label ?? null, p.seal.tooltip])]))
    for (const l of [...this.listeners]) { try { l() } catch (err) { console.error('desk seals', err) } }
  }
}

/** The one board of the window: the host writes it, the desk switch reads it. */
export const deskSeals = new DeskSealBoard()
