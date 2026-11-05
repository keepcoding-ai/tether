// Ctrl+click on a path printed in a terminal, main-process side: is this candidate a file or folder? The renderer
// detects the candidates in the line (app/shared/vscode-terminal-link-detector.ts, VS Code's detection) and asks
// here; the answer is a cheap `stat`, cached for a few seconds like VS Code's link resolver (which this follows:
// terminalLinkResolver.ts, commit 7faf984945fefaceb533ca1d851697a2e72e4e68).
// A relative path is read against the folder the pane was OPENED in, never the shell's current one: after a `cd`,
// a relative path that is not under the opening folder simply does not exist, and is no link.
// Hovering a line asks for its candidates without a click, so nothing here may reach a network share: a UNC path
// (`\\host\share`, `//host/share`) is refused before any stat (a stat would send the person's credentials to
// whoever printed that text). Nothing is opened or run here.
import type { IpcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeLinkQueryString, removeLinkSuffix, winDrivePrefix } from '../shared/vscode-terminal-link-parsing.ts'
import type { ResolvedPath } from '../shared/vscode-terminal-link-detector.ts'

export type PathPlatform = 'win32' | 'posix'

/**
 * The absolute path a candidate names, or null when it names none (a relative path with no opening folder, `~` with
 * no home, a network path). Port of VS Code's `_preprocessPath`, plus file:// URIs, the UNC refusal and the
 * suffix/query removal `resolveLink` does first. Does not touch the disk.
 */
export function candidatePath(candidate: string, cwd: string | undefined, home: string | undefined, platform: PathPlatform): string | null {
  const path = platform === 'win32' ? win32 : posix
  let link = removeLinkQueryString(removeLinkSuffix(candidate))
  if (link.length === 0) return null
  if (link.startsWith('file://')) {
    try { link = fileURLToPath(link, { windows: platform === 'win32' }) } catch { return null }
  } else if (link.charAt(0) === '~') {
    // Resolve ~ -> userHome
    if (!home) return null
    link = path.join(home, link.substring(1))
  } else if (link.charAt(0) !== '/') {
    // Resolve workspace path . | .. | <relative_path> -> <path>/. | <path>/.. | <path>/<relative_path>
    if (platform === 'win32') {
      if (/^\\\\(?!\?\\)/.test(link)) {
        return null // \\host\share: a network path (VS Code would join it to the cwd)
      } else if (!new RegExp('^' + winDrivePrefix).test(link) && !link.startsWith('\\\\?\\')) {
        if (!cwd) return null
        // `\x` is the root of the opening folder's drive; anything else is under the folder
        link = link.startsWith('\\') ? path.resolve(cwd, link) : path.join(cwd, link)
      } else {
        // Remove \\?\ from paths so that they share the same underlying URI and don't open multiple tabs for the same file
        link = link.replace(/^\\\\\?\\/, '')
      }
    } else {
      if (!cwd) return null
      link = path.join(cwd, link)
    }
  }
  // A network share (UNC): never stat'ed (checked before normalize, which would collapse `//` on posix).
  if (platform === 'posix' && link.startsWith('//')) return null
  link = path.normalize(link)
  if (platform === 'win32' && /^[\\/]{2}/.test(link)) return null
  return link
}

/** The positive and negative lifetimes of a cached answer (VS Code keeps 10 s; a missing file is asked again sooner). */
const FOUND_TTL_MS = 10_000
const MISSING_TTL_MS = 2_000
const CACHE_MAX = 1000

export interface LinkResolverOptions {
  platform?: PathPlatform
  home?: string
  now?: () => number
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>
}

export class TerminalLinkResolver {
  private readonly platform: PathPlatform
  private readonly home: string | undefined
  private readonly now: () => number
  private readonly statFn: (path: string) => Promise<{ isDirectory(): boolean }>
  private readonly cache = new Map<string, { until: number; value: ResolvedPath | null }>()
  /** How many stats ran (the unit tests count them to see the cache work). */
  stats = 0

  constructor(opts: LinkResolverOptions = {}) {
    this.platform = opts.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
    this.home = 'home' in opts ? opts.home : homedir()
    this.now = opts.now ?? Date.now
    this.statFn = opts.stat ?? stat
  }

  /** The first candidate that exists, resolved against the opening folder `cwd`; null when none does. */
  async resolve(cwd: string | undefined, candidates: readonly string[]): Promise<ResolvedPath | null> {
    for (const candidate of candidates) {
      const found = await this.one(cwd, candidate)
      if (found) return found
    }
    return null
  }

  private async one(cwd: string | undefined, candidate: string): Promise<ResolvedPath | null> {
    const key = `${cwd ?? ''}\0${candidate}`
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return cached.value
    const path = candidatePath(candidate, cwd, this.home, this.platform)
    let value: ResolvedPath | null = null
    if (path !== null) {
      try {
        this.stats++
        const s = await this.statFn(path)
        value = { link: candidate, path, isDirectory: s.isDirectory() }
      } catch { /* does not exist (or cannot be read): not a link */ }
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear()
    this.cache.set(key, { until: this.now() + (value ? FOUND_TTL_MS : MISSING_TTL_MS), value })
    return value
  }
}

const MAX_CANDIDATES = 8
const MAX_CANDIDATE_LENGTH = 1024

/** Wires `terminallinks:resolve` (cwd, candidates) → the first existing candidate or null. */
export function registerTerminalLinks(ipcMain: IpcMain, resolver = new TerminalLinkResolver()): TerminalLinkResolver {
  ipcMain.handle('terminallinks:resolve', (_e, cwd: unknown, candidates: unknown): Promise<ResolvedPath | null> => {
    if (!Array.isArray(candidates)) return Promise.resolve(null)
    const list = candidates.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_LENGTH).slice(0, MAX_CANDIDATES)
    return resolver.resolve(typeof cwd === 'string' && cwd !== '' ? cwd : undefined, list)
  })
  return resolver
}
