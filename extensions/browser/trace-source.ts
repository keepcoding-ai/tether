// The browser's log for `tether trace` (src/trace/timeline.ts): <home>/browser/mcp.log, next to endpoint.json, written by
// the vendored server's call tracer (packages/browser call-trace.ts), one JSON line per event `{ t, ev, call, … , pid }`:
//   call_started {call, tool}, and in debug {debug, args}
//   call_finished {call, tool, tab?, durationMs, ok, code?, stage?, cdp?: {method, inFlight, ageMs}}, in debug {args, result}
//   cdp {call, method, durationMs, ok, error?}, gate {call, tool, gate, decision}, page_events {call, tool, events, dropped?}
//   and page_events_unavailable {call, tool, reason} (debug only); a failed call in debug names its dump folder in
//   call_finished `dump` (<home>/browser/debug/<callId>/: screenshot.png, console.json, target.json, call.json)
// Rotation: `mcp.log.1` (and `.2`, `.3` when it rotated on a debug line).
import { join } from 'node:path'
import type { TraceEntry, TraceSource } from '../../src/trace/timeline.ts'
import { pageEventsText, timeOf } from '../../src/trace/timeline.ts'
import { browserDirOf, MCP_SERVER_NAME } from './agents.ts'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/** <home>/browser/mcp.log. */
export const browserTraceFileOf = (home: string): string => join(browserDirOf(home), 'mcp.log')

/** One browser line → an entry. Exported for the unit test. */
export function parseBrowserLine(raw: Record<string, unknown>): TraceEntry | undefined {
  const event = str(raw.ev)
  const at = timeOf(raw.t)
  if (!event || !Number.isFinite(at)) return undefined
  const gate = str(raw.gate)
  const cdp = obj(raw.cdp)
  // A failed call says where it stopped: the stage, and the CDP command in flight then.
  const events = Array.isArray(raw.events) ? raw.events as Array<Record<string, unknown>> : undefined
  const step = str(raw.method) ?? (gate ? `${gate}: ${str(raw.decision) ?? '?'}` : undefined)
    ?? (events ? pageEventsText(events, num(raw.dropped)) : undefined)
    ?? (event === 'page_events_unavailable' ? `indisponível: ${(str(raw.reason) ?? '?').slice(0, 80)}` : undefined)
    ?? (str(raw.stage) ? `${str(raw.stage)}${str(cdp?.method) ? ` · ${str(cdp?.method)}` : ''}` : undefined)
  const ok = typeof raw.ok === 'boolean' ? raw.ok : undefined
  return {
    at,
    origin: 'browser',
    server: MCP_SERVER_NAME,
    event,
    ...(str(raw.call) ? { callId: str(raw.call) } : {}),
    ...(str(raw.tool) ? { tool: str(raw.tool) } : {}),
    ...(step ? { step } : {}),
    ...(num(raw.durationMs) !== undefined ? { durationMs: num(raw.durationMs) } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(str(raw.code) ? { code: str(raw.code) } : {}),
    ...(event === 'call_started' && 'args' in raw ? { args: raw.args } : {}),
    ...(str(raw.dump) ? { dump: str(raw.dump) } : {}),
    raw,
  }
}

/** The browser's contribution to `tether trace`. */
export function browserTraceSource(home: string): TraceSource {
  return {
    server: MCP_SERVER_NAME,
    files: () => [{ path: browserTraceFileOf(home), origin: 'browser' }],
    parse: raw => parseBrowserLine(raw),
    cites: (raw, id) => raw.call === id,
  }
}
