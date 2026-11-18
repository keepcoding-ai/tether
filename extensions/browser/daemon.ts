// The browser extension in tetherd. E8: at every launch of an AI agent the browser can be handed to it (agents.ts: a key of
// its own, an MCP file of its own, one more `--mcp-config`), by default only to the agents launched with a profile that
// marks it (`extensions.browser.serveToAgents`: perProfile | all | off; the mark is `profile.extensions.browser.serve`). The key dies with the agent's run. The side effects wait for
// `onStarted`: only the tetherd that owns the pipe sweeps what a killed one left (the CLI and Electron main, which activate
// this entry for the doctor checks, never get there).
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeSetting, readExtensionsSettings, type SettingReader, settingReaderOf } from '../../app/shared/vscode-configuration-registry.ts'
import type { DaemonCheck } from '../../src/daemon/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import { profileOption } from '../../src/core/profile.ts'
import { findNode } from '../web-bridge/warmup.ts'
import { McpHttpHost, type McpBackend } from '../../src/daemon/mcp-http.ts'
import { type BrowserBackendInput, browserDirOf, createBrowserLaunchMiddleware, keysDirOf, MCP_SERVER_NAME, releaseSlot, sweepStale } from './agents.ts'
import { warmPrivateDirs } from './private-dir.ts'
import { debugStateOf, debugSummary } from './debug-file.ts'
import { browserChecks } from './doctor.ts'
import { browserTraceSource } from './trace-source.ts'
import { auditVendor } from './vendor-rules.ts'
import { manifest } from './manifest.ts'
import { scrubLogLine } from './log-scrub.ts'
import { PROFILE_OPTION, serveModeOf, servesAgent, type ServeMode } from './rules.ts'

export { manifest } from './manifest.ts'

/** A boolean setting of this extension as the app stores it (settings.json `extensions` object), normalized by the manifest's schema. */
export function browserFlag(api: Pick<TetherDaemon, 'settings'>, key: 'evaluate'): boolean {
  const schema = manifest.contributes!.settings![key]!
  const values = readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]
  return normalizeSetting(schema, values?.[key]) === true
}

/** This extension's settings as settings.json holds them, read now (the daemon has no change event). */
export function browserSettings(api: Pick<TetherDaemon, 'settings'>): SettingReader {
  return settingReaderOf(manifest.contributes!.settings!, readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id])
}

/** The doctor's line of the debug mode: OK while off, AVISO while on (it should not stay on by accident). */
export function debugCheck(settings: SettingReader): DaemonCheck {
  const state = debugStateOf(settings)
  const name = 'depuração do navegador do tether'
  if (!state.enabled) return { level: 'OK', name, detail: debugSummary(state) }
  return { level: 'AVISO', name, detail: debugSummary(state), hint: 'desligue em Configurações > Browser > Depuração quando terminar de investigar' }
}

/** `extensions.browser.serveToAgents` as the person set it (the old boolean included: see serveModeOf). */
export function serveMode(api: Pick<TetherDaemon, 'settings'>): ServeMode {
  return serveModeOf(readExtensionsSettings(api.settings.get<unknown>('extensions')).values[manifest.id]?.serveToAgents)
}

/** Whether the launch's profile carries the browser option (a slot without a profile, or whose profile is gone, does not). */
export function profileMarked(api: Pick<TetherDaemon, 'profiles'>, slot: Pick<SlotMeta, 'profileId'>): boolean {
  return !!slot.profileId && profileOption(api.profiles.get(slot.profileId), manifest.id, PROFILE_OPTION) === true
}

/** The launch decision: the global mode and the slot's profile. */
export function serveFor(api: Pick<TetherDaemon, 'settings' | 'profiles'>, slot: Pick<SlotMeta, 'profileId'>): boolean {
  return servesAgent(serveMode(api), profileMarked(api, slot))
}

/** What the daemon uses of the vendored bundle as a module (packages/browser src/tether-server.ts). */
interface BrowserBundle {
  createTetherBrowserServer(opts: {
    endpointFile: string; keyFile: string; allowEvaluate?: boolean; env?: Record<string, string | undefined>
    log?: (line: string) => void; sessionIdleMs?: number
    /** The call trace's file (JSON lines); without it, a server given `log` traces into `log`. A server older than the trace ignores it. */
    traceFile?: string
  }): McpBackend
}

/**
 * The slots' servers inside the daemon: the vendored bundle is checked against its manifests and imported ONCE, at the first
 * agent that initializes (never at startup: a daemon whose agents do not use the browser never loads it); each slot then gets
 * its own server object. A bundle that is not whole is never loaded into the daemon: the error reaches the agent's CLI.
 */
export function createBrowserBackends(vendorDir: string, server: string, log: (msg: string) => void, importBundle: (path: string) => Promise<unknown> = p => import(pathToFileURL(p).href)): (input: BrowserBackendInput) => Promise<McpBackend> {
  let bundle: Promise<BrowserBundle> | undefined
  const load = async (): Promise<BrowserBundle> => {
    const problems = await auditVendor(vendorDir)
    if (problems.length) throw new Error(`servidor do navegador não confere com o manifesto (${problems[0]}${problems.length > 1 ? `, +${problems.length - 1}` : ''})`)
    const m = await importBundle(server) as Partial<BrowserBundle>
    if (typeof m.createTetherBrowserServer !== 'function') throw new Error('o servidor vendorizado do navegador não tem a entrada de biblioteca (createTetherBrowserServer): revendorize')
    return m as BrowserBundle
  }
  return async input => {
    bundle ??= load()
    // A failed load is tried again by the next agent (the folder may have been repaired).
    bundle.catch(() => { bundle = undefined })
    const lib = await bundle
    return lib.createTetherBrowserServer({
      endpointFile: input.endpointFile,
      keyFile: input.keyFile,
      ...(input.evaluate ? { allowEvaluate: true } : {}),
      env: input.env,
      // The server lives as long as the agent's run: its session is not released for being idle.
      sessionIdleMs: Infinity,
      // The call trace (one JSON line per call, with its id) in <home>/browser/mcp.log, next to endpoint.json, where
      // `tether trace` and the doctor read it; the `log` below keeps only the connection line for tetherd.log.
      traceFile: join(dirname(input.endpointFile), 'mcp.log'),
      // Only the connection's own line; tool failures name addresses and stay out of the log.
      log: line => { if (line.startsWith('connected')) log(line) },
    })
  }
}

export function activate(api: TetherDaemon): IDisposable[] {
  // The server over HTTP for agents with `mcp.http` (agents.ts). It listens only in the tetherd that owns the pipe (onStarted):
  // elsewhere urlOf is undefined and the stdio path applies.
  const log = (msg: string): void => api.log(scrubLogLine(msg))
  const http = new McpHttpHost({ name: MCP_SERVER_NAME, log })
  const vendorDir = resolve(import.meta.dirname ?? '.', 'vendor')
  const middleware = createBrowserLaunchMiddleware({
    http,
    backend: createBrowserBackends(vendorDir, resolve(vendorDir, 'tether-browser', 'server.mjs'), log),
    home: api.home,
    agent: name => api.agents.get(name),
    serve: slot => serveFor(api, slot),
    evaluate: () => browserFlag(api, 'evaluate'),
    // Read on use: Electron main bundles this module as CommonJS (import.meta.dirname is undefined there), and never runs it.
    server: resolve(import.meta.dirname ?? '.', 'vendor', 'tether-browser', 'server.mjs'),
    proxy: resolve(import.meta.dirname ?? '.', 'mcp-proxy.mjs'),
    // The system node, like the bridge's MCP shell and tetherd itself; the daemon's own binary (a renamed node) is the last resort.
    node: () => findNode() ?? (existsSync(process.execPath) ? process.execPath : undefined),
    log: msg => api.log(scrubLogLine(msg)),
  })
  return [
    api.onStarted(() => {
      // The owner-only check of the key folders (whoami + icacls) off the loop, so the first launch does not spawn them synchronously.
      void warmPrivateDirs([browserDirOf(api.home), keysDirOf(api.home)], log)
      void sweepStale(api.home).then(
        n => { if (n) api.log(`${n} arquivo(s) de chave/MCP do navegador de um tetherd anterior removidos`) },
        e => api.log(`limpeza de chaves do navegador falhou: ${e instanceof Error ? e.message : String(e)}`),
      )
      http.listen().then(
        port => api.log(`navegador servido aos agentes por HTTP em 127.0.0.1:${port}`),
        e => api.log(`servidor HTTP do navegador não subiu (${e instanceof Error ? e.message : String(e)}); agentes recebem o navegador por stdio`),
      )
    }),
    api.launch.use(middleware),
    api.onSlot(ev => { if (ev.kind === 'exited' && ev.slot.kind !== 'shell') { http.revoke(ev.slot.slotId); releaseSlot(api.home, ev.slot.slotId) } }),
    { dispose: () => { void http.close() } },
    ...browserChecks({ home: api.home }).map(check => api.doctor.register(check)),
    api.doctor.register(async () => debugCheck(browserSettings(api))),
    api.traces.register(browserTraceSource(api.home)),
  ]
}
