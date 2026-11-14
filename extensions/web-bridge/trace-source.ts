// The bridge's logs for `tether trace` (src/trace/timeline.ts), all in the bridge home (<home>/bridge):
//   mcp.log    the MCP shell ("casca"): call_started / call_finished {callId, tool, ok, code?, durationMs}, the daemon's comings
//              and goings with callId (daemon_unreachable, call_retried, call_lost, browsers_waited)
//   daemon.log the daemon, layer 0: call_started {callId, key, client?, browser, tool, timeoutMs}, call_finished {…, ok, code?,
//              durationMs}, late_result {callId, …, lateMs}. Never arguments
//   trace.log  debug mode only: the daemon's call_started with `args`, call_finished with `result | error`, `gate`; and the
//              extension's lines (they carry the extension's own time `at`): cdp {method, durationMs, ok}, stage, gate, typing
// Every line is `{ ts, event, … }` with `callId` (chrome-extensions/bridge README, "Rastro de cada chamada").
import { join } from 'node:path'
import type { TraceEntry, TraceFile, TraceSource } from '../../src/trace/timeline.ts'
import { timeOf } from '../../src/trace/timeline.ts'
import { bridgeHomeOf, MCP_SERVER_NAME } from './paths.ts'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/** One bridge line → an entry. Exported for the unit test. */
export function parseBridgeLine(raw: Record<string, unknown>, file: TraceFile): TraceEntry | undefined {
  const event = str(raw.event)
  if (!event) return undefined
  // The extension's lines in trace.log carry its own time (`at`); the daemon stamps `ts` when it writes the batch.
  const fromExtension = str(raw.at) !== undefined
  const at = timeOf(raw.at ?? raw.ts)
  if (!Number.isFinite(at)) return undefined
  const error = obj(raw.error)
  const gate = str(raw.gate)
  const step = str(raw.stage) ?? str(raw.method) ?? (gate ? `${gate}: ${str(raw.decision) ?? '?'}` : undefined) ?? str(raw.phase)
  const ok = typeof raw.ok === 'boolean' ? raw.ok : undefined
  const code = str(raw.code) ?? str(error?.code)
  return {
    at,
    origin: fromExtension ? 'extensão' : file.origin,
    server: MCP_SERVER_NAME,
    event,
    ...(str(raw.callId) ? { callId: str(raw.callId) } : {}),
    ...(str(raw.tool) ? { tool: str(raw.tool) } : {}),
    ...(step ? { step } : {}),
    ...(num(raw.durationMs) !== undefined ? { durationMs: num(raw.durationMs) } : num(raw.lateMs) !== undefined ? { durationMs: num(raw.lateMs) } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(code ? { code } : {}),
    ...(event === 'call_started' && 'args' in raw ? { args: raw.args } : {}),
    raw,
  }
}

/** The bridge's contribution to `tether trace`. In `upload`, the field lookup goes as `<id>-target`: it counts as the call. */
export function bridgeTraceSource(home: string): TraceSource {
  const dir = bridgeHomeOf(home)
  return {
    server: MCP_SERVER_NAME,
    files: () => [
      { path: join(dir, 'mcp.log'), origin: 'casca' },
      { path: join(dir, 'daemon.log'), origin: 'daemon' },
      { path: join(dir, 'trace.log'), origin: 'daemon' },
    ],
    parse: parseBridgeLine,
    cites: (raw, id) => raw.callId === id || raw.callId === `${id}-target`,
  }
}
