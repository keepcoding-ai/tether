// F9 0b: the extensions' IPC bus (app/shared/ext-ipc.ts) between a renderer TetherUi and a main TetherMain, over an
// in-memory pair that behaves like ipcRenderer/ipcMain (invoke → handle, send → on, main broadcast → renderer on);
// Electron main's host (app/main/ext-host.ts): activation with `extensions.disabled`, the settings registry
// (app/shared/vscode-configuration-registry.ts) and the core channels.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extChannel, mainIpc, uiIpc, type ExtTransport, type MainIpcTransport } from '../../app/shared/ext-ipc.ts'
import { ConfigurationRegistry, normalizeSetting, readExtensionsSettings, withSetting, writeExtensionsSettings, type ExtensionsSettings } from '../../app/shared/vscode-configuration-registry.ts'
import { activateExtensions } from '../../app/shared/ext-activation.ts'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { MainExtensionHost, type MainHostDeps } from '../../app/main/ext-host.ts'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { ExtensionEntry, ExtensionManifest } from '../../extensions/types.ts'

type Listener = (event: { returnValue?: unknown }, ...args: unknown[]) => unknown

/** ipcMain + ipcRenderer in one process: what Electron does across the bridge, minus serialization (checked with structuredClone). */
function fakeIpc() {
  const handlers = new Map<string, Listener>()
  const mainListeners = new Map<string, Set<Listener>>()
  const rendererListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const main: MainIpcTransport & MainHostDeps['ipc'] = {
    handle: (ch, fn) => { if (handlers.has(ch)) throw new Error(`second handler for ${ch}`); handlers.set(ch, fn as Listener) },
    removeHandler: ch => { handlers.delete(ch) },
    on: (ch, fn) => { let s = mainListeners.get(ch); if (!s) mainListeners.set(ch, s = new Set()); s.add(fn as Listener) },
    removeListener: (ch, fn) => { mainListeners.get(ch)?.delete(fn as Listener) },
  }
  const broadcast = (ch: string, ...args: unknown[]): void => { for (const l of rendererListeners.get(ch) ?? []) l(...structuredClone(args)) }
  const renderer = {
    invoke: async (ch: string, ...args: unknown[]) => {
      const h = handlers.get(ch)
      if (!h) throw new Error(`No handler registered for '${ch}'`)
      return structuredClone(await h({}, ...structuredClone(args)))
    },
    send: (ch: string, ...args: unknown[]) => { for (const l of mainListeners.get(ch) ?? []) l({}, ...structuredClone(args)) },
    sendSync: (ch: string, ...args: unknown[]) => { const e: { returnValue?: unknown } = {}; for (const l of mainListeners.get(ch) ?? []) l(e, ...args); return structuredClone(e.returnValue) },
    on: (ch: string, l: (...args: unknown[]) => void) => { let s = rendererListeners.get(ch); if (!s) rendererListeners.set(ch, s = new Set()); s.add(l); return () => { s.delete(l) } },
  }
  // What preload.ts exposes as window.tether.ext.
  const ext: ExtTransport = {
    invoke: (id, ch, ...args) => renderer.invoke(extChannel(id, ch), ...args),
    send: (id, ch, ...args) => renderer.send(extChannel(id, ch), ...args),
    on: (id, ch, l) => renderer.on(extChannel(id, ch), l),
  }
  return { main, broadcast, renderer, ext, handlers }
}

interface EchoChannels {
  invoke: { add: (a: number, b: number) => number; read: (path: string) => { ok: boolean; text: string } }
  send: { flush: (path: string, text: string) => void }
  events: { changed: (path: string) => void }
}

describe('the extensions IPC bus', () => {
  test('channels are namespaced ext:<id>:<channel>, and a name that could escape is refused', () => {
    assert.equal(extChannel('note', 'read'), 'ext:note:read')
    assert.equal(extChannel('quick-open', 'search.v2'), 'ext:quick-open:search.v2')
    for (const [id, ch] of [['Note', 'x'], ['a:b', 'x'], ['', 'x'], ['note', ''], ['note', 'a:b'], ['note', '../x']]) assert.throws(() => extChannel(id!, ch!), `${id} ${ch}`)
  })

  test('invoke, send and events round-trip between a renderer and a main side, typed by the channel map', async () => {
    const { main, broadcast, ext } = fakeIpc()
    const m = mainIpc<EchoChannels>('echo', main, broadcast)
    const ui = uiIpc<EchoChannels>('echo', ext)
    const flushed: string[] = []
    const changed: string[] = []
    m.handle('add', (a, b) => a + b)
    m.handle('read', async path => ({ ok: true, text: `conteúdo de ${path}` }))
    const flushSub = m.on('flush', (path, text) => { flushed.push(`${path}=${text}`) })
    const sub = ui.on('changed', path => { changed.push(path) })
    assert.equal(await ui.invoke('add', 2, 3), 5)
    assert.deepEqual(await ui.proxy().read('a.md'), { ok: true, text: 'conteúdo de a.md' })
    ui.send('flush', 'a.md', 'x')
    m.send('changed', 'a.md')
    sub.dispose()
    m.send('changed', 'b.md')
    flushSub.dispose()
    ui.send('flush', 'b.md', 'y')
    assert.deepEqual(flushed, ['a.md=x'])
    assert.deepEqual(changed, ['a.md'])
  })

  test('two extensions with the same channel name do not collide; disposing a handler unregisters it', async () => {
    const { main, broadcast, ext, handlers } = fakeIpc()
    const a = mainIpc<EchoChannels>('a', main, broadcast).handle('add', () => 1)
    mainIpc<EchoChannels>('b', main, broadcast).handle('add', () => 2)
    assert.equal(await uiIpc<EchoChannels>('a', ext).invoke('add', 0, 0), 1)
    assert.equal(await uiIpc<EchoChannels>('b', ext).invoke('add', 0, 0), 2)
    a.dispose()
    assert.ok(!handlers.has('ext:a:add'))
    await assert.rejects(uiIpc<EchoChannels>('a', ext).invoke('add', 0, 0))
  })
})

describe('the settings registry', () => {
  test('normalizes by schema: wrong type, out of enum, out of bounds read as the default', () => {
    assert.equal(normalizeSetting({ type: 'boolean', default: true, title: '' }, 'no'), true)
    assert.equal(normalizeSetting({ type: 'boolean', default: true, title: '' }, false), false)
    assert.equal(normalizeSetting({ type: 'string', default: 'a', title: '', enum: ['a', 'b'] }, 'c'), 'a')
    assert.equal(normalizeSetting({ type: 'string', default: 'a', title: '', enum: ['a', 'b'] }, 'b'), 'b')
    assert.equal(normalizeSetting({ type: 'number', default: 5, title: '', min: 1, max: 9 }, 10), 5)
    assert.equal(normalizeSetting({ type: 'number', default: 5, title: '', min: 1, max: 9 }, NaN), 5)
    assert.equal(normalizeSetting({ type: 'number', default: 5, title: '', min: 1, max: 9 }, 7), 7)
  })

  test('reads settings.json `extensions` tolerantly and writes it back with `disabled` first', () => {
    assert.deepEqual(readExtensionsSettings(undefined), { disabled: [], values: {} })
    assert.deepEqual(readExtensionsSettings([1]), { disabled: [], values: {} })
    const s = readExtensionsSettings({ disabled: ['note', 7, 'Bad', 'note'], note: { wordWrap: false }, 'Bad.id': { x: 1 }, junk: 3 })
    assert.deepEqual(s, { disabled: ['note'], values: { note: { wordWrap: false } } })
    assert.deepEqual(Object.keys(writeExtensionsSettings(withSetting(s, 'quick-open', 'max', 9))), ['disabled', 'note', 'quick-open'])
  })

  test('properties by full key; undeclared keys read undefined; duplicate registration throws', () => {
    const r = new ConfigurationRegistry()
    const d = r.registerConfiguration({ id: 'note', properties: { wordWrap: { type: 'boolean', default: true, title: 'Quebra de linha' } } })
    assert.deepEqual(Object.keys(r.getConfigurationProperties()), ['note.wordWrap'])
    const settings: ExtensionsSettings = { disabled: [], values: { note: { wordWrap: 'x' } } }
    assert.equal(r.read(settings, 'note', 'wordWrap'), true)
    assert.equal(r.read(settings, 'note', 'other'), undefined)
    assert.throws(() => r.registerConfiguration({ id: 'note', properties: {} }))
    d.dispose()
    assert.equal(r.read(settings, 'note', 'wordWrap'), undefined)
  })
})

const manifest = (id: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest => ({ id, version: '0.1.0', displayName: id.toUpperCase(), hosts: ['main'], ...extra })

describe('Electron main extension host', () => {
  function setup(list: ExtensionEntry<TetherMain>[], initial: unknown = {}) {
    const ipc = fakeIpc()
    let stored = readExtensionsSettings(initial)
    let file: Record<string, unknown> = {}
    const logs: string[] = []
    const host = new MainExtensionHost(list, {
      home: 'H', userDir: 'H', dist: 'D', ipc: ipc.main, broadcast: ipc.broadcast, window: () => undefined,
      readSettings: () => stored, writeSettings: s => { stored = s }, log: m => logs.push(m),
      readFile: () => ({ ...file, extensions: writeExtensionsSettings(stored) }),
      writeFile: f => { file = f; stored = readExtensionsSettings(f.extensions) },
    })
    return { ipc, host, logs, stored: () => stored }
  }

  test('activates the index minus the disabled ones; a requirement on a disabled one fails; the rest stays up', () => {
    const activated: string[] = []
    const entry = (id: string, extra: Partial<ExtensionManifest> = {}): ExtensionEntry<TetherMain> => ({ manifest: manifest(id, extra), activate: api => { activated.push(`${api.id}@${api.home}`) } })
    const { host } = setup([entry('a'), entry('b'), entry('c', { requires: ['b'] }), { manifest: manifest('d'), activate: () => { throw new Error('boom') } }], { disabled: ['b'] })
    const r = host.activate()
    assert.deepEqual(activated, ['a@H'])
    assert.deepEqual(r.active, ['a'])
    assert.deepEqual(r.disabled, ['b'])
    assert.deepEqual(r.failed.map(f => f.id).sort(), ['c', 'd'])
  })

  test('TetherMain: the bus from activate, settings by schema, changes broadcast to the renderer and to main listeners', async () => {
    let api: TetherMain | undefined
    const { ipc, host, stored } = setup([{ manifest: manifest('note', { contributes: { settings: { wordWrap: { type: 'boolean', default: true, title: 'Quebra' } } } }), activate: a => { api = a; return [a.ipc<EchoChannels>().handle('add', (x, y) => x * y)] } }])
    host.activate()
    assert.equal(await uiIpc<EchoChannels>('note', ipc.ext).invoke('add', 4, 5), 20)
    assert.equal(api!.settings.get('wordWrap'), true)
    const seenMain: unknown[] = []
    const seenRenderer: unknown[] = []
    api!.settings.onChange('wordWrap', v => seenMain.push(v))
    ipc.renderer.on('tether:ext-setting', c => seenRenderer.push(c))
    ipc.renderer.send('extsettings:set', 'note', 'wordWrap', false)
    assert.equal(api!.settings.get('wordWrap'), false)
    assert.deepEqual(stored(), { disabled: [], values: { note: { wordWrap: false } } })
    ipc.renderer.send('extsettings:set', 'note', 'wordWrap', 'garbage') // normalized: the default
    ipc.renderer.send('extsettings:set', 'Note', 'wordWrap', true) // refused: not an id
    ipc.renderer.send('extsettings:set', 'note', 'obj', { a: 1 }) // refused: not a setting value
    assert.deepEqual(seenMain, [false, true])
    assert.deepEqual(seenRenderer, [{ id: 'note', key: 'wordWrap', value: false }, { id: 'note', key: 'wordWrap', value: true }])
    assert.deepEqual(ipc.renderer.sendSync('extsettings:get-sync'), { disabled: [], values: { note: { wordWrap: true } } })
  })

  test('extensions:list serves the main manifests, the disabled list and the failures', async () => {
    const { ipc, host } = setup([{ manifest: manifest('a'), activate: () => { throw new Error('x') } }, { manifest: manifest('b'), activate: () => { } }], { disabled: ['b'] })
    host.activate()
    assert.deepEqual(await ipc.renderer.invoke('extensions:list'), { manifests: [manifest('a'), manifest('b')], disabled: ['b'], failed: [{ id: 'a', error: 'x' }] })
  })

  test('the shared activation leaves disabled ones out without failing them', () => {
    const r = activateExtensions([{ manifest: manifest('a'), activate: () => { } }], () => ({}), new DisposableStore(), ['a'])
    assert.deepEqual(r, { active: [], disabled: ['a'], failed: [] })
  })
})
