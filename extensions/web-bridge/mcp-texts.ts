// What the agent reads about the bridge, where the vendored server (vendor/atrium-bridge.mjs, src/texts.ts
// SERVER_INSTRUCTIONS) names the tether's screen in words that are not the screen's: its instructions say to turn the debug
// mode on "in the tether: Settings → Debugging", and the person sees "Configurações", the extension's section and
// "Depuração". Only the HTTP path (the server inside tetherd, McpHttpHost) passes through this rewriter: the answer to
// `initialize` gets the real labels; nothing else is touched, and an answer in another shape goes through as it came. The
// stdio fallback (`node atrium-bridge.mjs mcp`) keeps the server's words.
import type { LineRewriter } from '../../src/daemon/mcp-http.ts'
import { BRIDGE_NAME } from './manifest.ts'

/** The server's words for the tether's screen (bridge src/texts.ts SERVER_INSTRUCTIONS). */
export const SETTINGS_OLD = 'Settings → Debugging'
/** The screen as the person sees it: the settings page, this extension's node, its "Depuração" section. */
export const SETTINGS_NEW = `"Configurações" → "${BRIDGE_NAME}" → "Depuração" (the setting "Modo de depuração")`

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `initialize` result with the screen's labels in the instructions; any other shape comes back as given. */
export function patchBridgeInitialize(result: unknown): unknown {
  if (!isObject(result) || typeof result.instructions !== 'string' || !result.instructions.includes(SETTINGS_OLD)) return result
  return { ...result, instructions: result.instructions.replaceAll(SETTINGS_OLD, SETTINGS_NEW) }
}

/** Follows one MCP session: which request id asked `initialize`, so its answer is recognized. */
export class BridgeMcpRewriter implements LineRewriter {
  private readonly asked = new Set<string | number>()

  fromClient(line: string): string {
    try {
      const m = JSON.parse(line) as unknown
      if (isObject(m) && m.method === 'initialize' && (typeof m.id === 'string' || typeof m.id === 'number')) {
        if (this.asked.size > 100) this.asked.clear()
        this.asked.add(m.id)
      }
    } catch { /* not JSON: the server will say so */ }
    return line
  }

  fromServer(line: string): string {
    let m: unknown
    try { m = JSON.parse(line) } catch { return line }
    if (!isObject(m) || (typeof m.id !== 'string' && typeof m.id !== 'number') || !('result' in m) || !this.asked.has(m.id)) return line
    this.asked.delete(m.id)
    return JSON.stringify({ ...m, result: patchBridgeInitialize(m.result) })
  }
}
