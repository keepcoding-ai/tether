// Files changed in git under a folder (the "search only in changed files" switch of the search), main-process side
// (no Electron here: the unit tests run it under plain Node). Same list VS Code takes from source control.
import { type ChildProcess, spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'

const DEFAULT_MAX = 5000

/** Runs git without a shell; resolves with stdout and the exit code (null code = failed to run or killed). */
function runGit(args: string[], signal?: AbortSignal): Promise<{ out: string; code: number | null }> {
  return new Promise(resolveRun => {
    let child: ChildProcess
    try {
      child = spawn('git', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    } catch { resolveRun({ out: '', code: null }); return }
    let out = ''
    if (signal) { if (signal.aborted) child.kill(); else signal.addEventListener('abort', () => child.kill(), { once: true }) }
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => { out += chunk })
    child.on('error', () => resolveRun({ out, code: null }))
    child.on('close', code => resolveRun({ out, code }))
  })
}

/** Pure: parses `git status --porcelain=v1 -z` output into paths relative to the repository root (deleted files left out, renames/copies keep the new path). */
export function parsePorcelainZ(out: string): string[] {
  const files: string[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const x = entry[0]!
    const y = entry[1]!
    const path = entry.slice(3)
    // Renames and copies carry the original path as the next entry: skip it.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
    if (x === 'D' || y === 'D') continue
    files.push(path)
  }
  return files
}

/** Absolute paths (platform separator) of the files changed under `folder`: modified, added, renamed (the new path), untracked. Deleted files are left out. Empty when `folder` is not inside a git repository or git is missing. */
export async function gitChangedFiles(folder: string, opts: { signal?: AbortSignal; max?: number } = {}): Promise<string[]> {
  const max = opts.max ?? DEFAULT_MAX
  const top = await runGit(['-C', folder, 'rev-parse', '--show-toplevel'], opts.signal)
  if (top.code !== 0) return []
  const root = top.out.trim()
  if (root === '') return []
  const status = await runGit(['-C', folder, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], opts.signal)
  if (status.code !== 0) return []
  const base = resolve(folder)
  const result: string[] = []
  for (const rel of parsePorcelainZ(status.out)) {
    const abs = resolve(join(root, rel))
    const inside = relative(base, abs)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue
    result.push(abs)
    if (result.length >= max) break
  }
  return result
}
