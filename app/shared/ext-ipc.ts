// The extensions' IPC bus (F9 §3.5): every extension talks between its renderer and main sides on channels named
// `ext:<id>:<channel>`, typed by a channel map the extension declares once (invoke = request/reply, send = renderer →
// main fire-and-forget, events = main → renderer). The prefix keeps extensions apart from each other and from the core's
// bespoke channels, which stay as they are. The shape follows VS Code's channel model
// (src/vs/base/parts/ipc/common/ipc.ts @7faf984: IChannel.call/listen and ProxyChannel.toService, a typed proxy whose
// methods are calls on the channel): `proxy()` below is that proxy for the invoke side. Pure: the Electron objects come
// in as small transports (preload's `window.tether.ext` on the renderer, ipcMain + the window on main), so the bus is
// unit-tested with an in-memory pair.
import { toDisposable, type IDisposable } from './vscode-lifecycle.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...args: any[]) => any

/** What an extension declares: `extensions/<id>/ipc.ts` exports one, both sides import it. */
export interface ChannelMap {
  invoke?: Record<string, Fn>
  send?: Record<string, Fn>
  events?: Record<string, Fn>
}

type Section<C, K extends keyof ChannelMap> = C extends Record<K, infer S> ? (S extends Record<string, Fn> ? S : never) : never
export type InvokeOf<C> = Section<C, 'invoke'>
export type SendOf<C> = Section<C, 'send'>
export type EventsOf<C> = Section<C, 'events'>

const NAME = /^[a-z0-9][a-z0-9-]*$/
const CHANNEL = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/

/** The wire name of an extension's channel; throws on an id or channel that could escape its namespace. */
export function extChannel(id: string, channel: string): string {
  if (!NAME.test(id)) throw new Error(`id de extensão inválido: ${JSON.stringify(id)}`)
  if (!CHANNEL.test(channel)) throw new Error(`canal inválido: ${JSON.stringify(channel)}`)
  return `ext:${id}:${channel}`
}

/** What the preload exposes as `window.tether.ext` (the renderer's raw side of the bus). */
export interface ExtTransport {
  invoke(id: string, channel: string, ...args: unknown[]): Promise<unknown>
  send(id: string, channel: string, ...args: unknown[]): void
  on(id: string, channel: string, listener: (...args: unknown[]) => void): () => void
}

/** The renderer side an extension gets (TetherUi.ipc). */
export interface UiIpc<C extends ChannelMap> {
  invoke<K extends keyof InvokeOf<C> & string>(channel: K, ...args: Parameters<InvokeOf<C>[K]>): Promise<Awaited<ReturnType<InvokeOf<C>[K]>>>
  send<K extends keyof SendOf<C> & string>(channel: K, ...args: Parameters<SendOf<C>[K]>): void
  on<K extends keyof EventsOf<C> & string>(channel: K, listener: EventsOf<C>[K]): IDisposable
  /** ProxyChannel.toService: `proxy().read(path)` is `invoke('read', path)`. */
  proxy(): { [K in keyof InvokeOf<C>]: (...args: Parameters<InvokeOf<C>[K]>) => Promise<Awaited<ReturnType<InvokeOf<C>[K]>>> }
}

export function uiIpc<C extends ChannelMap>(id: string, t: ExtTransport): UiIpc<C> {
  extChannel(id, 'x') // validates the id up front
  const self: UiIpc<C> = {
    invoke: (channel, ...args) => t.invoke(id, channel, ...args) as never,
    send: (channel, ...args) => t.send(id, channel, ...args),
    on: (channel, listener) => toDisposable(t.on(id, channel, listener as (...args: unknown[]) => void)),
    proxy: () => new Proxy({}, {
      get: (_t, key) => typeof key === 'string' && key !== 'then' ? (...args: unknown[]) => t.invoke(id, key, ...args) : undefined,
    }) as never,
  }
  return self
}

/** The slice of ipcMain the main side needs (Electron's signatures: the first listener argument is the event). */
export interface MainIpcTransport {
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, fn: (event: unknown, ...args: any[]) => void): void
  removeListener(channel: string, fn: (event: unknown, ...args: any[]) => void): void
}

/** The main side an extension gets (TetherMain.ipc). Handlers validate their arguments: they come from the renderer. */
export interface MainIpc<C extends ChannelMap> {
  handle<K extends keyof InvokeOf<C> & string>(channel: K, fn: (...args: Parameters<InvokeOf<C>[K]>) => ReturnType<InvokeOf<C>[K]> | Promise<Awaited<ReturnType<InvokeOf<C>[K]>>>): IDisposable
  on<K extends keyof SendOf<C> & string>(channel: K, fn: SendOf<C>[K]): IDisposable
  send<K extends keyof EventsOf<C> & string>(channel: K, ...args: Parameters<EventsOf<C>[K]>): void
}

/** `broadcast` delivers a main → renderer event (main.ts: the window's webContents.send). */
export function mainIpc<C extends ChannelMap>(id: string, ipc: MainIpcTransport, broadcast: (channel: string, ...args: unknown[]) => void): MainIpc<C> {
  extChannel(id, 'x')
  return {
    handle: (channel, fn) => {
      const name = extChannel(id, channel)
      ipc.handle(name, (_e, ...args) => fn(...(args as never)))
      return toDisposable(() => ipc.removeHandler(name))
    },
    on: (channel, fn) => {
      const name = extChannel(id, channel)
      const listener = (_e: unknown, ...args: unknown[]): void => { (fn as Fn)(...args) }
      ipc.on(name, listener)
      return toDisposable(() => ipc.removeListener(name, listener))
    },
    send: (channel, ...args) => broadcast(extChannel(id, channel), ...args),
  }
}
