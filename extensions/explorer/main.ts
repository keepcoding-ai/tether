// The explorer extension's Electron-main side (F8 slice 1b): the file system for the tree, on the bus `ext:explorer:*`.
// A folder is read on demand (`readdir` of the expanded folder only, never a recursive listing), filtered by VS Code's
// default `files.exclude` and sorted folders first (tree-rules.ts). Slice 3: the disk watchers (watchers.ts) tell the window
// which expanded folders changed. Slice 5: create, rename and move to the trash (never a permanent delete). Every argument
// comes from the renderer: paths are read only inside the project roots it announced, and every write goes through
// `guardWrite` (source and destination: inside a root, never a root itself, no link leading out of it).
import { lstat, mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import { toDisposable, type IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { isValidBasename } from './file-names.ts'
import type { ExplorerChannels, OpResult, ReadDirResult } from './ipc.ts'
import { type Entry, isExcluded, isInsideAny, listing, samePath } from './tree-rules.ts'
import { ExplorerWatchers } from './watchers.ts'

export { manifest } from './manifest.ts'

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** A read error in the person's words. */
function describe(err: unknown): { missing: boolean; message: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return { missing: true, message: 'Pasta não encontrada.' }
  if (code === 'ENOTDIR') return { missing: true, message: 'Isto não é uma pasta.' }
  if (code === 'EACCES' || code === 'EPERM') return { missing: false, message: 'Sem permissão para ler esta pasta.' }
  return { missing: false, message: `Não foi possível ler a pasta: ${(err as Error | undefined)?.message ?? String(err)}` }
}

/** A directory entry as the tree draws it; a link takes its target's kind (a broken one is a file). */
async function entryOf(dir: string, d: Dirent): Promise<Entry> {
  if (d.isDirectory()) return { name: d.name, kind: 'dir' }
  if (!d.isSymbolicLink()) return { name: d.name, kind: 'file' }
  try {
    const target = await stat(join(dir, d.name))
    return { name: d.name, kind: target.isDirectory() ? 'dir' : 'file', link: true }
  } catch { return { name: d.name, kind: 'file', link: true } }
}

export async function readDirectory(dir: string): Promise<ReadDirResult> {
  try {
    const dirents = (await readdir(dir, { withFileTypes: true })).filter(d => !isExcluded(d.name))
    // Links are the only entries that cost a stat.
    return { ok: true, entries: listing(await Promise.all(dirents.map(d => entryOf(dir, d)))) }
  } catch (err) { return { ok: false, ...describe(err) } }
}

/**
 * The path to read, or undefined when it is not inside a project root: the lexical check (no `..`, under a root) and then the
 * real paths (a link inside a project that leads outside it is refused). `real` is fs.realpath, injected for the unit test.
 */
export async function guardPath(
  roots: readonly string[], path: unknown, real: (p: string) => Promise<string> = realpath, caseInsensitive = CASE_INSENSITIVE,
): Promise<string | undefined> {
  if (typeof path !== 'string' || path.trim() === '' || !isInsideAny(roots, path, caseInsensitive)) return undefined
  try {
    const target = await real(path)
    const realRoots = await Promise.all(roots.map(r => real(r).catch(() => '')))
    return isInsideAny(realRoots.filter(r => r !== ''), target, caseInsensitive) ? path : undefined
  } catch {
    // A path that does not exist has no real path: it is only allowed for the 'missing' answer, which reveals nothing.
    return path
  }
}

/**
 * The path to write, or undefined when a write there is refused. Lexically inside a root and never a root itself.
 * `mustExist`: the source of a rename or a trash must exist and its real path stay inside the real roots (a link inside a
 * project that leads outside it is refused). Otherwise a destination: the nearest existing folder on its way must have its
 * real path inside the real roots, so a link cannot lead a new file outside the project. `real`/`present` are injected for the unit test.
 */
export async function guardWrite(
  roots: readonly string[], path: unknown, mustExist: boolean,
  real: (p: string) => Promise<string> = realpath, caseInsensitive = CASE_INSENSITIVE,
  present: (p: string) => Promise<boolean> = p => lstat(p).then(() => true, () => false),
): Promise<string | undefined> {
  if (typeof path !== 'string' || path.trim() === '' || !isInsideAny(roots, path, caseInsensitive)) return undefined
  if (roots.some(r => samePath(r, path, caseInsensitive))) return undefined
  const realRoots = (await Promise.all(roots.map(r => real(r).catch(() => '')))).filter(r => r !== '')
  if (mustExist) {
    if (!(await present(path))) return undefined
    try {
      const target = await real(path)
      return isInsideAny(realRoots, target, caseInsensitive) && !realRoots.some(r => samePath(r, target, caseInsensitive)) ? path : undefined
    } catch { return undefined }
  }
  let probe = dirname(path)
  for (let i = 0; i < 64 && !(await present(probe)); i++) {
    const up = dirname(probe)
    if (up === probe) return undefined
    probe = up
  }
  try { return isInsideAny(realRoots, await real(probe), caseInsensitive) ? path : undefined } catch { return undefined }
}

/** A write error in the person's words. */
function describeWrite(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EEXIST') return 'Já existe um arquivo ou pasta com esse nome.'
  if (code === 'ENOENT') return 'O arquivo ou a pasta não existe mais.'
  if (code === 'EACCES' || code === 'EPERM') return 'Sem permissão (ou o arquivo está em uso por outro programa).'
  if (code === 'EBUSY') return 'O arquivo está em uso por outro programa.'
  return (err as Error | undefined)?.message ?? String(err)
}

const OUTSIDE = 'Este caminho não está em um projeto aberto.'
const IS_WINDOWS = process.platform === 'win32'

export async function createEntry(roots: readonly string[], path: unknown, kind: unknown): Promise<OpResult> {
  if (kind !== 'file' && kind !== 'dir') return { ok: false, message: 'Pedido inválido.' }
  const ok = await guardWrite(roots, path, false)
  if (!ok) return { ok: false, message: OUTSIDE }
  if (!isValidBasename(basename(ok), IS_WINDOWS)) return { ok: false, message: 'Nome inválido.' }
  try {
    await mkdir(dirname(ok), { recursive: true })
    // Never over something that is there: 'wx' and a non-recursive mkdir fail with EEXIST.
    if (kind === 'file') await writeFile(ok, '', { flag: 'wx' })
    else await mkdir(ok)
    return { ok: true }
  } catch (err) { return { ok: false, message: describeWrite(err) } }
}

export async function renameEntry(roots: readonly string[], from: unknown, to: unknown): Promise<OpResult> {
  const src = await guardWrite(roots, from, true)
  if (!src) return { ok: false, message: OUTSIDE }
  if (typeof to !== 'string' || !isValidBasename(basename(to), IS_WINDOWS)) return { ok: false, message: 'Nome inválido.' }
  if (!samePath(dirname(src), dirname(to), CASE_INSENSITIVE)) return { ok: false, message: 'Renomear não muda a pasta.' }
  // A change of case only (Windows) renames to a path that, to the file system, already exists.
  const caseOnly = samePath(src, to, CASE_INSENSITIVE)
  const dst = caseOnly ? to : await guardWrite(roots, to, false)
  if (!dst) return { ok: false, message: OUTSIDE }
  if (!caseOnly && await lstat(dst).then(() => true, () => false)) return { ok: false, message: 'Já existe um arquivo ou pasta com esse nome.' }
  try { await rename(src, dst); return { ok: true } } catch (err) { return { ok: false, message: describeWrite(err) } }
}

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<ExplorerChannels>()
  let roots: string[] = []
  const watchers = new ExplorerWatchers({
    changed: dirs => ipc.send('changed', dirs),
    rootMissing: (root, missing) => ipc.send('rootMissing', root, missing),
    failed: (root, message) => { main.log(`watcher failed for ${root}: ${message}`); ipc.send('watchFailed', root, message) },
  })
  return [
    toDisposable(() => watchers.dispose()),
    ipc.on('setRoots', list => {
      roots = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 200) : []
      watchers.setRoots(roots)
    }),
    ipc.on('setExpanded', dirs => { watchers.setExpanded(Array.isArray(dirs) ? dirs.filter((x): x is string => typeof x === 'string').slice(0, 20_000) : []) }),
    ipc.on('rewatch', () => watchers.rewatch()),
    ipc.handle('watchStats', () => watchers.stats()),
    ipc.handle('readDir', async dir => {
      const ok = await guardPath(roots, dir)
      return ok ? readDirectory(ok) : { ok: false, missing: false, message: 'Esta pasta não está em um projeto aberto.' }
    }),
    ipc.handle('create', (path, kind) => createEntry(roots, path, kind)),
    ipc.handle('rename', (from, to) => renameEntry(roots, from, to)),
    // The trash only: there is no permanent delete. When the system cannot trash it, nothing happens and the person is told why.
    ipc.handle('trash', async path => {
      const ok = await guardWrite(roots, path, true)
      if (!ok) return { ok: false, message: OUTSIDE }
      try { await main.shell.trash(ok); return { ok: true } } catch (err) {
        main.log(`trash failed for ${ok}: ${(err as Error).message}`)
        return { ok: false, message: `Não foi possível mover para a lixeira: ${describeWrite(err)}` }
      }
    }),
    ipc.handle('stat', async path => {
      const ok = await guardPath(roots, path)
      if (!ok) return { kind: 'missing' }
      try { return { kind: (await stat(ok)).isDirectory() ? 'dir' : 'file' } } catch { return { kind: 'missing' } }
    }),
  ]
}
