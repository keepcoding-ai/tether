// What the agent reads about the browser, where the vendored server (vendor/tether-browser/, sealed by its manifests) says it
// wrong or not at all (Tether Browser V2b). The server is written for any host; in the tether its tabs are panes the person sees,
// `localhost` opens with her permission, and two tools are not offered. The proxy (mcp-proxy.mjs) runs between the agent's CLI and
// the server and applies these rules to the server's answers, as pure functions of the JSON-RPC messages:
//   - `initialize`: the server's `instructions` (the CLI puts them in the agent's context) say whose browser this is, how the local
//     network works, and why WebEvaluate / WebSavePdf answer "Tool not found";
//   - `tools/list`: the one description that is wrong here (WebNavigate: "addresses inside the machine ... are refused").
// Nothing else is touched. A message that is not JSON, or an answer in a shape that is not the expected, goes through as it came.

/** The sentence of WebNavigate's description that is false in the tether (vendored server, TOOL_TEXTS.navigate). */
export const NAVIGATE_OLD = 'Only public http(s) addresses are reachable; addresses inside the machine or its private network are refused.'
/** What is true in the tether: the address of this machine or its network is asked of the person, the first time. */
export const NAVIGATE_NEW = 'Public http(s) addresses open directly. localhost and addresses of the local network open only with the person\'s permission, which the tether asks of her the first time (she may allow it once or for good); if she refuses, the call fails with LOCAL_NETWORK_DENIED and you should ask her instead of trying another way.'

export interface McpTextsOptions {
  /** The server was started with `--allow-evaluate` (the setting `extensions.browser.evaluate`). */
  evaluate: boolean
}

/** The server's `instructions`: whose browser this is, the local network, and what is not offered and why. */
export function serverInstructions(o: McpTextsOptions): string {
  return [
    'These tools drive browser tabs inside the tether (the app the person is working in), not the person\'s own Chrome. The tabs are panes she sees on her screen, in a Browser desk, each marked with your name; she can take a tab from you, pause it or close it. They start without her logins: when a site needs one, use WebAskUser to ask her to log in; never ask her for a password.',
    'localhost and addresses of the local network open only with the person\'s permission, which the tether asks of her the first time; if she refuses, the call fails with LOCAL_NETWORK_DENIED and you should ask her what to do.',
    o.evaluate
      ? 'WebSavePdf is not offered in the tether. A call to a tool that is not in your list fails with "Tool not found": that is because it does not exist here, not a mistake of yours.'
      : 'WebEvaluate (run JavaScript in the page) is off: the person has not turned on "extensions.browser.evaluate" in the tether\'s settings. WebSavePdf is never offered in the tether. A call to either fails with "Tool not found" because they are not offered here, not because of a mistake of yours; to read the page use WebSnapshot, WebRead, WebFind and WebScreenshot.',
  ].join('\n\n')
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The answer to `initialize` with our instructions in place of the server's (it has none). Other shapes come back as given. */
export function patchInitializeResult(result: unknown, o: McpTextsOptions): unknown {
  if (!isObject(result)) return result
  return { ...result, instructions: serverInstructions(o) }
}

/** The answer to `tools/list` with WebNavigate's description corrected; any tool without the old sentence is left alone. */
export function patchToolsListResult(result: unknown): unknown {
  if (!isObject(result) || !Array.isArray(result.tools)) return result
  return {
    ...result,
    tools: result.tools.map(t => (isObject(t) && typeof t.description === 'string' && t.description.includes(NAVIGATE_OLD) ? { ...t, description: t.description.replace(NAVIGATE_OLD, NAVIGATE_NEW) } : t)),
  }
}

/** Follows one connection: which request id asked what, so the answer can be recognized. */
export class McpRewriter {
  private readonly asked = new Map<string | number, string>()
  private readonly opts: McpTextsOptions

  constructor(opts: McpTextsOptions) { this.opts = opts }

  /** A line from the agent's CLI to the server: noted, never changed. */
  fromClient(line: string): string {
    try {
      const m = JSON.parse(line) as unknown
      if (isObject(m) && typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number')) {
        if (this.asked.size > 1000) this.asked.clear()
        this.asked.set(m.id, m.method)
      }
    } catch { /* not JSON: the server will say so */ }
    return line
  }

  /** A line from the server to the CLI: the answers to `initialize` and `tools/list` are rewritten, the rest passes untouched. */
  fromServer(line: string): string {
    let m: unknown
    try { m = JSON.parse(line) } catch { return line }
    if (!isObject(m) || (typeof m.id !== 'string' && typeof m.id !== 'number') || !('result' in m)) return line
    const method = this.asked.get(m.id)
    if (method === undefined) return line
    this.asked.delete(m.id)
    if (method === 'initialize') return JSON.stringify({ ...m, result: patchInitializeResult(m.result, this.opts) })
    if (method === 'tools/list') return JSON.stringify({ ...m, result: patchToolsListResult(m.result) })
    return line
  }
}
