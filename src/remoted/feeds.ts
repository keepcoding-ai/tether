// What changed for the reads of step 3.4a, as the portal tells a device (EVT channels.changed, regency.changed): thin
// notices built from tetherd's own events (`ext-event` of `channels` and `regency`, and the slots' `state` / `removed`),
// with no content. The payload of a tetherd event never goes on: only a channel's id (checked by the projector) and the
// tree's signature, its time and whether the app publishes. Pure: time comes in as an argument.
//
// Pace: each notice at most once per its gap, always with the latest state (a change inside the gap waits for the next
// take, it is never lost). Reading again on every notice fits the device's 120 requests a minute: marks and the open page
// every 2 s are 60, the tree every 5 s is 12. Memory: at most CHANGED_IDS_MAX ids, then the flag `all`.
import { CHANGED_IDS_MAX, type ChannelsChangedSource, type RegencyChanged } from '../remote/projection.ts'

export const CHANNELS_NOTICE_GAP_MS = 2_000
export const REGENCY_NOTICE_GAP_MS = 5_000

/** The events of the `channels` extension that change what marks or a page show. */
const CHANNEL_EVENTS = new Set(['line', 'channel', 'poll', 'reaction'])
const ID_RE = /^[\w.:-]{1,64}$/
const SIG_RE = /^[0-9a-f]{16}$/

export class ReadFeeds {
  readonly #gaps: { channels: number; regency: number }
  readonly #ids = new Set<string>()
  #all = false
  #channelsDirty = false
  #channelsAt = -Infinity
  #regencyDirty = false
  #regencyAt = -Infinity
  /** What the portal last learned of the kept tree (from `tree.changed` or a `tree.read` it served). */
  #tree: RegencyChanged | undefined

  constructor(gaps: Partial<{ channels: number; regency: number }> = {}) {
    this.#gaps = { channels: gaps.channels ?? CHANNELS_NOTICE_GAP_MS, regency: gaps.regency ?? REGENCY_NOTICE_GAP_MS }
  }

  /** One `ext-event` of tetherd. Only the two extensions' events count; their payloads are read for an id, a sig, a time. */
  extEvent(ext: string, name: string, payload: unknown): void {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (ext === 'channels' && CHANNEL_EVENTS.has(name)) {
      const ch = p.channel && typeof p.channel === 'object' ? (p.channel as Record<string, unknown>).id : undefined
      const id = typeof p.channelId === 'string' ? p.channelId : ch
      this.#channelsDirty = true
      if (typeof id === 'string' && ID_RE.test(id) && !this.#all) {
        this.#ids.add(id)
        if (this.#ids.size > CHANGED_IDS_MAX) { this.#all = true; this.#ids.clear() }
      } else this.#all = true
      return
    }
    if (ext === 'regency' && name === 'tree.changed') {
      const live = p.live === true
      this.#tree = {
        live,
        ...(typeof p.sig === 'string' && SIG_RE.test(p.sig) ? { sig: p.sig } : {}),
        ...(!live && typeof p.at === 'number' && Number.isInteger(p.at) && p.at >= 0 ? { asOf: p.at } : {}),
      }
      this.#regencyDirty = true
    }
  }

  /** A `tree.read` the portal served: it says whether the app publishes now. */
  sawTree(view: RegencyChanged): void { this.#tree = view }

  /** A slot changed. With the app closed (or not known to publish) the slots go over the kept tree, so the tree a device sees changed too. */
  slotsChanged(): void {
    if (this.#tree?.live !== true) this.#regencyDirty = true
  }

  /** The channels notice due now, or undefined (nothing changed, or inside the gap). */
  takeChannels(nowMs: number): ChannelsChangedSource | undefined {
    if (!this.#channelsDirty || nowMs - this.#channelsAt < this.#gaps.channels) return undefined
    const out: ChannelsChangedSource = this.#all ? { channels: [], all: true } : { channels: [...this.#ids] }
    this.#channelsDirty = false
    this.#all = false
    this.#ids.clear()
    this.#channelsAt = nowMs
    return out
  }

  /** The Regency notice due now, or undefined. */
  takeRegency(nowMs: number): RegencyChanged | undefined {
    if (!this.#regencyDirty || nowMs - this.#regencyAt < this.#gaps.regency) return undefined
    this.#regencyDirty = false
    this.#regencyAt = nowMs
    return this.#tree ?? { live: false }
  }
}
