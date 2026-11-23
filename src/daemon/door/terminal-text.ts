// The text a delivery types into a terminal (contract 4.5): a header line with the same fields the channel's meta carries,
// then the body. One line when the body has one line (`[tether · channels · #kai · de Atrium (member) · m_01] corpo`);
// otherwise the header is the first line and the body follows (typing.ts pastes it in brackets).
// The header is the core's alone, so nothing in the message may imitate or break it:
// - a header field is one line, with its square brackets turned into parentheses (a name cannot close the header early);
// - a body line that starts with `[tether ·` gets that bracket turned into `(`, on every line, so a pasted body cannot fake a
//   header line of its own;
// - the body loses every control character but the line break and the tab: an ESC would let it end the bracketed paste
//   (`ESC[201~`) and submit half a message, or move the cursor over the user's screen; CR and CRLF become LF.
// Pure: no state, no I/O.
import { oneLine, toNames } from './channel-meta.ts'
import type { DeliveryMessage } from './types.ts'

export const HEADER_TAG = '[tether ·'
const HEADER_FIELD_MAX = 80
// C0 controls except TAB (0x09) and LF (0x0a), DEL and the C1 range.
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

function field(value: string): string {
  return oneLine(value, HEADER_FIELD_MAX).replace(/\[/g, '(').replace(/\]/g, ')')
}

/** `[tether · <origin> · #<room> · de <from> (<role>) · <id>]`; the room part is left out when there is none. */
export function terminalHeader(msg: DeliveryMessage, origin: string, id: string): string {
  const room = msg.room ? field(msg.room) : ''
  const to = field(toNames(msg, ', ') ?? '')
  const parts = [
    field(origin),
    ...(room ? [`#${room}`] : []),
    `de ${field(msg.from.name) || field(msg.from.id)} (${field(msg.from.role)})${to ? ` → ${to}` : ''}`,
    (msg.ref && field(msg.ref)) || field(id),
  ]
  return `${HEADER_TAG} ${parts.join(' · ')}]`
}

/** The body as it may be typed: LF line breaks, no control characters, no line that imitates the header. */
export function disarmBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(BODY_CONTROL_RE, '')
    .split('\n')
    .map((line) => {
      const lead = /^\s*/.exec(line)![0].length
      return line.startsWith(HEADER_TAG, lead) ? `${line.slice(0, lead)}(${line.slice(lead + 1)}` : line
    })
    .join('\n')
}

/** Header and body: one line (`header body`) when the body has one line, else `header\nbody`. Lines are joined with LF. */
export function terminalText(msg: DeliveryMessage, origin: string, id: string): string {
  const header = terminalHeader(msg, origin, id)
  const body = disarmBody(msg.body).replace(/^\n+|\n+$/g, '')
  if (!body) return header
  return body.includes('\n') ? `${header}\n${body}` : `${header} ${body}`
}
