// The Faults screen's Electron-main side: reads the registry for the screen, applies its verbs through the same code the
// CLI uses (src/core/faults-ops.ts, so the screen and an agent's `tether faults note` never overwrite each other), and
// watches the registry's folder so the screen refreshes live when any process records a fault or any writer changes a
// state. Capture itself is not here (app/main/faults-main.ts): it is on with the screen off.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { buildInfo } from '../../src/core/faults.ts'
import { canonicalDir } from '../../src/core/paths.ts'
import { applyAction, describeNotFound, listFaults, showFault, type FaultAction } from '../../src/core/faults-ops.ts'
import type { FaultsChannels, FaultsList, ScreenAction, UpdateOutcome } from './ipc.ts'

export { manifest } from './manifest.ts'

/** Occurrences the detail carries unless the screen asks for all of them. */
export const DETAIL_CAP = 20
const WATCH_DEBOUNCE_MS = 120
const MAX_TEXT = 8_000
const MAX_TAGS = 20

/** The tether source folder when the app runs from it (app/dist → repository root) and it is really the tether checkout. */
export function sourceRootOf(dist: string): string | undefined {
  const root = resolve(dist, '..', '..')
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }
    return pkg.name === 'tether' ? root : undefined
  } catch { return undefined }
}

/** Where a new pane that investigates a fault opens: the setting (when the folder exists), else the source folder, else the user's folder in its canonical spelling (core/paths.ts canonicalDir, as every slot's cwd). */
export function investigateCwd(setting: string | undefined, dist: string, home: string = homedir()): string {
  const chosen = setting?.trim()
  if (chosen && existsSync(chosen)) return chosen
  return sourceRootOf(dist) ?? canonicalDir(home)
}

/** The screen's verb as the registry's, or a message when the screen sent something it should not have. */
export function actionOf(a: unknown): FaultAction | string {
  if (!a || typeof a !== 'object') return 'ação inválida'
  const r = a as Record<string, unknown>
  switch (r.type) {
    case 'investigate': return { type: 'investigate', by: 'você' }
    case 'ignore': return { type: 'ignore' }
    case 'reopen': return { type: 'reopen' }
    case 'done': return { type: 'done', by: 'você', ...(typeof r.fix === 'string' && r.fix.trim() ? { fix: r.fix.trim().slice(0, 80) } : {}) }
    case 'tag':
      if (!Array.isArray(r.tags) || r.tags.length === 0 || r.tags.length > MAX_TAGS || !r.tags.every(t => typeof t === 'string' && t.length < 80)) return 'etiquetas inválidas'
      return { type: 'tag', tags: r.tags as string[], remove: r.remove === true }
    case 'note':
      return typeof r.text === 'string' && r.text.trim() && r.text.length <= MAX_TEXT ? { type: 'note', author: 'você', text: r.text } : 'nota vazia ou grande demais'
    default: return 'ação desconhecida'
  }
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<FaultsChannels>()
  const dir = join(main.userDir, 'faults')

  const list = (): FaultsList | { ok: false; message: string } => {
    try {
      let readError: string | undefined
      try { accessSync(join(dir, 'faults.jsonl'), constants.R_OK) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') readError = (e as Error).message }
      const snap = listFaults(dir)
      return {
        ok: true, rows: snap.rows, skipped: snap.skipped, ...(readError ? { readError } : {}), ...(snap.problem ? { stateProblem: snap.problem } : {}),
        dir, build: buildInfo(main.dist), seenAt: main.state.get<string>('seenAt') ?? null, cwd: investigateCwd(main.settings.get<string>('investigateCwd'), main.dist),
      }
    } catch (e) { return { ok: false, message: (e as Error).message } }
  }

  const update = (id: unknown, a: ScreenAction): UpdateOutcome => {
    if (typeof id !== 'string' || !id || id.length > 80) return { ok: false, message: 'falha inválida' }
    const action = actionOf(a)
    if (typeof action === 'string') return { ok: false, message: action }
    try {
      const r = applyAction(dir, id, action)
      if (r.ok) return { ok: true, id: r.id, changed: r.changed }
      return { ok: false, message: 'message' in r ? r.message : describeNotFound(r) }
    } catch (e) { return { ok: false, message: (e as Error).message } }
  }

  // The registry's folder, watched: lines and states are written by main, the daemon, the CLI and agents. A folder that
  // does not exist yet is created (empty) so the first fault already finds a watcher.
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, (_event, filename) => {
      if (typeof filename === 'string' && !/^faults(-state)?\.(jsonl|json)$/.test(filename)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; ipc.send('changed') }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', e => main.log(`watch: ${e.message}`))
  } catch (e) { main.log(`não consegui vigiar ${dir}: ${(e as Error).message}`) }

  return [
    ipc.handle('list', () => list()),
    ipc.handle('show', (id, all) => {
      if (typeof id !== 'string' || !id || id.length > 80) return { ok: false as const, message: 'falha inválida' }
      try {
        const r = showFault(dir, id, all === true ? undefined : DETAIL_CAP)
        return r.ok ? { ok: true as const, fault: r.fault, skipped: r.skipped } : { ok: false as const, message: describeNotFound(r) }
      } catch (e) { return { ok: false as const, message: (e as Error).message } }
    }),
    ipc.handle('update', (id, a) => update(id, a)),
    ipc.handle('markSeen', () => { main.state.update('seenAt', new Date().toISOString()) }),
    toDisposable(() => { if (timer) clearTimeout(timer); watcher?.close() }),
  ]
}
