// The `meta` of a delivery from inside (`notifications/claude/channel`), with the traps the channels probe found turned into
// rules. Claude Code makes each meta entry an attribute of the `<channel source="tether" ...>` tag the agent reads, and:
// - a value that is not a string drops the WHOLE notification, with no error: every value here is a string;
// - a key with anything but letters, digits and `_` is dropped by the CLI: such a key is refused here, so what the agent
//   sees is exactly what this function returns;
// - `source` is not filtered and duplicates the tag's attribute, letting a third party's text pose as the origin: it never
//   goes out, in any case;
// - a line break in a value goes raw into the attribute: line breaks and control characters become spaces.
// Values are cut to META_VALUE_MAX characters; an empty value is left out. Pure: no state, no I/O.
import type { DeliveryMessage } from './types.ts'

export const META_VALUE_MAX = 120
const KEY_RE = /^[A-Za-z0-9_]+$/
// C0 controls (line breaks included), DEL and the C1 range.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

/** One line, no control characters, trimmed and cut to `max`. */
export function oneLine(value: string, max = META_VALUE_MAX): string {
  return value.replace(CONTROL_RE, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max).trimEnd()
}

/** A key the CLI keeps as an attribute, and never `source`. */
export function isMetaKey(key: string): boolean {
  return KEY_RE.test(key) && key.toLowerCase() !== 'source'
}

/**
 * The meta as the CLI will show it: refused keys and `source` out, every value a one-line string (numbers and booleans
 * stringified; objects, arrays, null and undefined left out), cut, the empty ones left out. Order of `fields` is kept.
 */
export function channelMeta(fields: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(fields)) {
    if (!isMetaKey(key)) continue
    const text = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint' ? String(raw) : undefined
    if (text === undefined) continue
    const value = oneLine(text)
    if (value) out[key] = value
  }
  return out
}

/** The addressees as one line (`a, b`), each name sanitised; undefined when there are none. */
export function toNames(msg: DeliveryMessage, sep = ','): string | undefined {
  const names = (msg.to ?? []).map((n) => oneLine(n)).filter(Boolean)
  return names.length ? names.join(sep) : undefined
}

/**
 * The meta of one delivery (contract 4.5): kind, origin, room, from, from_id, role, id, reply_to. `origin` is the extension
 * that delivers, set by the core and written after nothing the message carries, so the message never chooses it.
 */
export function deliveryMeta(msg: DeliveryMessage, origin: string, id: string): Record<string, string> {
  return channelMeta({
    kind: msg.kind,
    origin,
    room: msg.room,
    from: msg.from.name,
    from_id: msg.from.id,
    role: msg.from.role,
    id,
    reply_to: msg.inReplyTo,
    to: toNames(msg),
    ref: msg.ref,
  })
}
