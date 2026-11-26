// "Esperam você": the waiting list as the portal projects it (attention.list / attention.watch / attention.changed,
// `{ items: [{ id, name, kind, since }], more }`). Everything here is hostile text from the house: read with a strict
// shape, capped, and handed to the screen only as strings for `textContent`. Pure: no DOM.

export interface Waiting {
  id: string
  name: string
  kind: string
  /** Unix ms, by the house's clock. */
  sinceMs: number
}

export interface WaitingList { items: Waiting[]; more: number }

const MAX_ITEMS = 64
const MAX_TEXT = 64

const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined)

/** The list in a body from the house, or undefined when the body does not have the shape. */
export function parseWaiting(body: Record<string, unknown>): WaitingList | undefined {
  const raw = body.items
  if (!Array.isArray(raw)) return undefined
  const items: Waiting[] = []
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (it === null || typeof it !== 'object') return undefined
    const o = it as Record<string, unknown>
    const id = text(o.id)
    const name = text(o.name)
    const kind = text(o.kind, 32)
    const sinceMs = typeof o.since === 'string' ? Date.parse(o.since) : NaN
    if (!id || !name || !kind || !Number.isFinite(sinceMs)) return undefined
    items.push({ id, name, kind, sinceMs })
  }
  const more = typeof body.more === 'number' && Number.isInteger(body.more) && body.more > 0 ? body.more : 0
  return { items, more: more + Math.max(0, raw.length - MAX_ITEMS) }
}

const KIND_LABEL: Record<string, string> = {
  claude: 'Claude', soul: 'Soul', codex: 'Codex', shell: 'Terminal', agent: 'Agente',
}

/** How the kind of pane reads for the person. An unknown kind shows as it came (it is already text). */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/** "há quanto tempo", in pt-BR, from the house's clock (`nowMs` already corrected by the skew seen at HS_DONE). */
export function waitedFor(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
  if (s < 60) return 'agora'
  const m = Math.floor(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? 'há 1 dia' : `há ${d} dias`
}
