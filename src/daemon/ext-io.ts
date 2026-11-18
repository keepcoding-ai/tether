// `api.io`: the restricted disk facade the daemon extensions use instead of node:fs. Inside tetherd it runs on the
// executor (a worker thread; the loop never waits on the disk); outside it (the CLI, the doctor, Electron main, unit tests
// that build no host) `fsIo` does the same through node:fs/promises. Both speak the same contract, so an extension's code
// is written once. This file must stay free of the synchronous node:fs API (the sync ratchet counts it).
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile, access } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DaemonIo } from './ext-api.ts'
import type { Executor } from '../exec/executor.ts'

const missing = (e: unknown): boolean => (e as { code?: string } | undefined)?.code === 'ENOENT'
let seq = 0

/** The facade over tetherd's executor. Errors keep their errno `code` (ExecError). */
export function createExecutorIo(executor: Executor): DaemonIo {
  const readText = (path: string): Promise<string> => executor.run('readText', [path])
  return {
    readText,
    tryReadText: (path) => readText(path).catch((e) => { if (missing(e)) return undefined; throw e }),
    writeTextAtomic: async (path, text) => { await executor.run('writeTextAtomicDir', [path, text]) },
    appendText: async (path, text) => { await executor.run('appendText', [path, text]) },
    rename: async (from, to) => { await executor.run('rename', [from, to]) },
    rm: async (path) => { await executor.run('rm', [path]) },
    mkdirp: async (path) => { await executor.run('mkdirp', [path]) },
    stat: (path) => executor.run('stat', [path]),
    readdir: (path) => executor.run('readdir', [path]),
    exists: (path) => executor.run('exists', [path]),
  }
}

/** The same facade for processes without an executor: node's own asynchronous file API. */
export const fsIo: DaemonIo = {
  readText: (path) => readFile(path, 'utf8'),
  tryReadText: (path) => readFile(path, 'utf8').catch((e) => { if (missing(e)) return undefined; throw e }),
  writeTextAtomic: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${seq++}.tmp`
    try {
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, path)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  },
  appendText: (path, text) => appendFile(path, text),
  rename: (from, to) => rename(from, to),
  rm: (path) => rm(path, { recursive: true, force: true }),
  mkdirp: async (path) => { await mkdir(path, { recursive: true }) },
  stat: async (path) => { const s = await stat(path); return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() } },
  readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() })),
  exists: (path) => access(path).then(() => true, () => false),
}
