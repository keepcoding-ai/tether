// The sync extension's Electron-main side. It reaches the app's runner (app/main/sync-runner.ts getSyncRunner, the same
// module instance main.ts created): main never runs the engine, every act is the runner's child process of the CLI under the
// runner's guard (flush, held saves, reload). This side adds what the renderer shows: the remote (masked) and the machine
// from <home>/sync.json, the last result from <home>/sync-last.json before the runner's first cycle, the profile names for
// the missing env line, and it keeps the tray notice of what needs the person. All disk reads are asynchronous (the main
// loop is under test/unit/arch.sync-ratchet.test.ts).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { getSyncRunner, type SyncResult, type SyncState } from '../../app/main/sync-runner.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ActOutcome, SyncChannels } from './ipc.ts'
import { EMPTY_VIEW, looksLikeGitUrl, maskUrl, noticeAction, profileNamesOf, type SyncLastView, type SyncView } from './rules.ts'

export { manifest } from './manifest.ts'

/** What this side uses of the runner (SyncRunner fits). */
export interface RunnerLike {
  state(): SyncState
  run(reason: string): Promise<SyncResult | undefined>
  connect(url: string): Promise<SyncResult | undefined>
  disconnect(): Promise<{ ok: boolean; message: string }>
  onDidChange(listener: (state: SyncState) => void): () => void
}

export interface SyncMainDeps {
  home: string
  runner(): RunnerLike | undefined
  /** A file's text, undefined when absent or unreadable. Asynchronous. */
  readText(path: string): Promise<string | undefined>
  notices: TetherMain['notices']
  /** The `state` event to the renderer. */
  push(view: SyncView): void
  log(msg: string): void
}

const NO_RUNNER = 'o ciclo de sincronização do app não está disponível'

const lastOf = (r: SyncResult | null): SyncLastView | null =>
  r ? { at: r.at, ok: r.ok, ...(r.error ? { error: r.error } : {}), report: r.report as SyncLastView['report'] } : null

/** The parts of this side that do not need Electron (unit-tested in test/unit/ext.sync-main.test.ts). */
export function createSyncMain(d: SyncMainDeps): { view(): Promise<SyncView>; now(): Promise<ActOutcome>; connect(url: unknown): Promise<ActOutcome>; disconnect(): Promise<ActOutcome>; dispose(): void } {
  let notice: { resolve(): void; update(message: string): void } | undefined
  let noticeText: string | undefined

  const readJson = async <T>(name: string): Promise<T | undefined> => {
    const text = await d.readText(join(d.home, name))
    if (text === undefined) return undefined
    try { return JSON.parse(text) as T } catch { return undefined }
  }

  const view = async (): Promise<SyncView> => {
    const runner = d.runner()
    const s = runner?.state() ?? { connected: false, running: false, last: null }
    if (!s.connected && !s.running) return { ...EMPTY_VIEW }
    const cfg = await readJson<{ url?: unknown; machine?: unknown }>('sync.json')
    let last = lastOf(s.last)
    // Before the runner's first cycle (or for a cycle a terminal ran), the disk has the last result.
    if (!last && s.connected) {
      const disk = await readJson<SyncLastView>('sync-last.json')
      if (disk && typeof disk.ok === 'boolean' && typeof disk.at === 'string') last = disk
    }
    const needNames = Object.values(last?.report?.missingEnv ?? {}).some(n => n.length)
    return {
      connected: s.connected, running: s.running,
      ...(typeof cfg?.url === 'string' ? { remote: maskUrl(cfg.url) } : {}),
      ...(typeof cfg?.machine === 'string' ? { machine: cfg.machine } : {}),
      last: last && last.error ? { ...last, error: { code: last.error.code, message: maskUrl(last.error.message) } } : last,
      trashDir: join(d.home, 'sync-trash'),
      ...(needNames ? { profileNames: profileNamesOf(await d.readText(join(d.home, 'profiles.json'))) } : {}),
    }
  }

  const applyNotice = (v: SyncView): void => {
    const a = noticeAction(v)
    if (a === 'keep') return
    if (a === 'resolve') { notice?.resolve(); notice = undefined; noticeText = undefined; return }
    if (notice) { if (noticeText !== a.raise) notice.update(a.raise) } else notice = d.notices.raise({ message: a.raise })
    noticeText = a.raise
  }

  let seq = 0
  const changed = (): void => {
    const mine = ++seq
    void view().then(v => {
      if (mine !== seq) return // a newer change is on its way
      applyNotice(v)
      d.push(v)
    }).catch(err => d.log(`estado: ${err instanceof Error ? err.message : String(err)}`))
  }

  let off: (() => void) | undefined
  let attached: RunnerLike | undefined
  const attach = (): RunnerLike | undefined => {
    const r = d.runner()
    if (r && r !== attached) { off?.(); attached = r; off = r.onDidChange(changed) }
    return r
  }
  attach()
  changed()

  const done = async (): Promise<ActOutcome> => ({ ok: true, view: await view() })

  return {
    view: () => { attach(); return view() },
    now: async () => {
      const r = attach()
      if (!r) return { ok: false, message: NO_RUNNER }
      const res = await r.run('agora')
      if (!res) return { ok: false, message: 'a sincronização não está configurada' }
      return done()
    },
    connect: async url => {
      const r = attach()
      if (!r) return { ok: false, message: NO_RUNNER }
      if (typeof url !== 'string' || !looksLikeGitUrl(url)) return { ok: false, message: 'isso não parece o endereço de um repositório git' }
      const res = await r.connect(url.trim())
      if (!res) return { ok: false, message: 'a conexão não pôde começar' }
      if (!res.ok) return { ok: false, message: maskUrl(res.error?.message ?? 'a conexão falhou') }
      return done()
    },
    disconnect: async () => {
      const r = attach()
      if (!r) return { ok: false, message: NO_RUNNER }
      const res = await r.disconnect()
      return res.ok ? done() : { ok: false, message: maskUrl(res.message) }
    },
    dispose: () => { off?.(); off = undefined; notice?.resolve(); notice = undefined },
  }
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<SyncChannels>()
  const core = createSyncMain({
    home: main.home,
    runner: getSyncRunner,
    readText: path => readFile(path, 'utf8').then(t => t, () => undefined),
    notices: main.notices,
    push: v => ipc.send('state', v),
    log: msg => main.log(msg),
  })
  return [
    ipc.handle('state', () => core.view()),
    ipc.handle('now', () => core.now()),
    ipc.handle('connect', url => core.connect(url)),
    ipc.handle('disconnect', () => core.disconnect()),
    toDisposable(() => core.dispose()),
  ]
}
