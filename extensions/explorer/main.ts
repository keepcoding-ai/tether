// The explorer extension's Electron-main side (F8 slice 1b): the file system for the tree, on the bus `ext:explorer:*`.
// A folder is read on demand (`readdir` of the expanded folder only, never a recursive listing), filtered by VS Code's
// default `files.exclude` and sorted folders first (tree-rules.ts). Nothing here watches the disk (slice 3). Every
// argument comes from the renderer: paths are read only inside the project roots it announced.
import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { ExplorerChannels, ReadDirResult } from './ipc.ts'
import { type Entry, isExcluded, isInsideAny, listing } from './tree-rules.ts'

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

export function activate(main: TetherMain): IDisposable[] {
  const ipc = main.ipc<ExplorerChannels>()
  let roots: string[] = []
  return [
    ipc.on('setRoots', list => { roots = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 200) : [] }),
    ipc.handle('readDir', async dir => {
      const ok = await guardPath(roots, dir)
      return ok ? readDirectory(ok) : { ok: false, missing: false, message: 'Esta pasta não está em um projeto aberto.' }
    }),
    ipc.handle('stat', async path => {
      const ok = await guardPath(roots, path)
      if (!ok) return { kind: 'missing' }
      try { return { kind: (await stat(ok)).isDirectory() ? 'dir' : 'file' } } catch { return { kind: 'missing' } }
    }),
  ]
}
