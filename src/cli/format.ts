// Human output for the CLI (Portuguese): status words, relative times, a plain-text table.
import type { SlotStatus } from '../daemon/protocol.ts'

export function statusLabel(status: SlotStatus): string {
  switch (status) {
    case 'running': return 'ativo'
    case 'queued': return 'na fila'
    case 'starting': return 'iniciando'
    case 'exited': return 'parado'
    case 'unconfirmed': return 'não confirmado'
    case 'error': return 'erro'
  }
}

/** "há 5 min", "há 2 h", "há 3 d"; "agora" under a minute; "?" for an unparsable timestamp. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '-'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '?'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'agora'
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `há ${h} h`
  return `há ${Math.round(h / 24)} d`
}

/** First 8 chars of a session id followed by an ellipsis (ids are uuids / long hashes). */
export function shortId(id: string | undefined): string {
  if (!id) return '-'
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`
}

/** Keeps the END of the text (paths: the last folders matter most). */
export function truncateStart(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? text.slice(-max) : `…${text.slice(text.length - max + 1)}`
}

/** Local date/time, compact: "2026-10-29 14:05" (with `seconds`: "2026-10-29 14:05:07"). */
export function localTime(iso: string, seconds = false): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ''}`
}

/** Column widths follow the content; two spaces between columns; no trailing spaces. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n') + '\n'
}
