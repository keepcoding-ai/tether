// Git provider: the sync folder is a git repo whose `origin` is the remote. Credentials are the machine's own
// git credentials (helper, ssh agent); we never prompt and never put a secret anywhere. Conflicts are resolved
// per file with "the remote wins", after the local version is saved in the trash.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SyncError,
  type ConnectResult,
  type ProviderStatus,
  type PullConflict,
  type PullResult,
  type PushResult,
  type SyncProvider,
} from '../provider.ts'

export interface GitProviderOpts {
  /** The sync folder (becomes the working tree). */
  dir: string
  /** The remote location, as `git remote add` takes it. */
  url: string
  /** Where local versions go when the remote wins a conflict. */
  trashDir: string
  /** This machine's name, used in commit messages. */
  machine: string
  branch?: string
  /** The git binary. */
  git?: string
  now?: () => number
  timeoutMs?: number
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Hides `user:pass@` (and `token@`) embedded in a URL; safe to call on any text. */
export function maskUrl(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1***@')
}

interface RunResult { code: number; stdout: Buffer; stderr: string }

export function createGitProvider(opts: GitProviderOpts): SyncProvider {
  const { dir, url, trashDir, machine } = opts
  const branch = opts.branch ?? 'main'
  const gitBin = opts.git ?? 'git'
  const now = opts.now ?? Date.now
  const timeout = opts.timeoutMs ?? 60_000
  const remoteRef = `origin/${branch}`
  const ident = ['-c', 'user.name=tether', '-c', 'user.email=tether@localhost', '-c', 'commit.gpgsign=false']
  const base = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false']

  function exec(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        gitBin,
        [...base, ...args],
        {
          cwd: dir,
          timeout,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C' },
        },
        (err, stdout, stderr) => {
          const errText = stderr.toString('utf8')
          if (!err) return resolve({ code: 0, stdout, stderr: errText })
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          if (e.code === 'ENOENT') {
            return reject(new SyncError('git-missing', `git não encontrado (${gitBin})`))
          }
          if (e.killed) return reject(new SyncError('network', `o git não respondeu em ${Math.round(timeout / 1000)}s`))
          const code = typeof e.code === 'number' ? e.code : 1
          resolve({ code, stdout, stderr: errText })
        },
      )
    })
  }

  function fail(args: string[], r: RunResult): SyncError {
    const err = maskUrl(r.stderr).trim()
    const short = err.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400)
    if (/authentication failed|permission denied|could not read (username|password)|access denied|invalid credentials|requested url returned error: 40[13]|repository not found|terminal prompts disabled/i.test(err)) {
      return new SyncError('auth', `falha de autenticação no remoto: ${short}`)
    }
    if (/could not resolve host|unable to access|connection (refused|timed out|reset)|network is unreachable|does not appear to be a git repository|could not read from remote|operation timed out|unable to connect|early eof/i.test(err)) {
      return new SyncError('network', `remoto inalcançável: ${short}`)
    }
    return new SyncError('git', `git ${args[0] ?? ''} falhou: ${short || `código ${r.code}`}`)
  }

  /** Runs git, throws SyncError on a non-zero exit. */
  async function git(args: string[]): Promise<string> {
    const r = await exec(args)
    if (r.code !== 0) throw fail(args, r)
    return r.stdout.toString('utf8')
  }

  const isRepo = (): boolean => existsSync(join(dir, '.git'))

  async function ok(args: string[]): Promise<boolean> {
    return (await exec(args)).code === 0
  }

  const hasHead = (): Promise<boolean> => ok(['rev-parse', '--verify', '-q', 'HEAD'])
  const hasRemoteRef = (): Promise<boolean> => ok(['rev-parse', '--verify', '-q', `refs/remotes/${remoteRef}`])

  async function count(range: string): Promise<number> {
    const r = await exec(['rev-list', '--count', range])
    return r.code === 0 ? Number(r.stdout.toString('utf8').trim()) || 0 : 0
  }

  async function dirtyFiles(): Promise<string[]> {
    const out = await git(['status', '--porcelain', '-z', '-uall'])
    return out.split('\0').filter(Boolean)
  }

  /** Commits whatever is pending in the folder. Returns true when a commit was made. */
  async function commitPending(): Promise<boolean> {
    await git(['add', '-A'])
    if ((await dirtyFiles()).length === 0) return false
    await git([...ident, 'commit', '-q', '-m', `sync: ${machine}`])
    return true
  }

  async function fetchRemote(): Promise<void> {
    await git(['fetch', '-q', 'origin'])
  }

  /** Unmerged paths with the stages each has (1 base, 2 ours/local, 3 theirs/remote). */
  async function unmerged(): Promise<Map<string, Set<number>>> {
    const out = await git(['ls-files', '-u', '-z'])
    const map = new Map<string, Set<number>>()
    for (const entry of out.split('\0').filter(Boolean)) {
      const m = /^\d+ [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(entry)
      if (!m) continue
      const path = m[2]!
      const set = map.get(path) ?? new Set<number>()
      set.add(Number(m[1]))
      map.set(path, set)
    }
    return map
  }

  async function resolveConflicts(): Promise<PullConflict[]> {
    const stamp = new Date(now()).toISOString().replace(/:/g, '')
    const conflicts: PullConflict[] = []
    for (const [path, stages] of [...(await unmerged())].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let trashed = false
      if (stages.has(2)) {
        const r = await exec(['show', `:2:${path}`])
        if (r.code === 0) {
          const target = join(trashDir, stamp, ...path.split('/'))
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, r.stdout)
          trashed = true
        }
      }
      if (stages.has(3)) {
        await git(['checkout', '--theirs', '--', path])
        await git(['add', '--', path])
      } else {
        await git(['rm', '-f', '-q', '--', path]) // the remote deleted it
      }
      conflicts.push({ path, trashed })
    }
    return conflicts
  }

  async function changedBetween(before: string, after: string): Promise<string[]> {
    if (before === after) return []
    const out = await git(['diff', '--name-only', '--no-renames', '-z', before, after])
    return out.split('\0').filter(Boolean).sort()
  }

  async function headOrEmpty(): Promise<string> {
    return (await hasHead()) ? (await git(['rev-parse', 'HEAD'])).trim() : EMPTY_TREE
  }

  return {
    kind: 'git',

    async connect(): Promise<ConnectResult> {
      mkdirSync(dir, { recursive: true })
      if (!isRepo()) await git(['init', '-q', '-b', branch])
      const cur = await exec(['remote', 'get-url', 'origin'])
      if (cur.code !== 0) await git(['remote', 'add', 'origin', url])
      else if (cur.stdout.toString('utf8').trim() !== url) await git(['remote', 'set-url', 'origin', url])
      await fetchRemote()
      return { remoteEmpty: !(await hasRemoteRef()) }
    },

    async pull(): Promise<PullResult> {
      await commitPending()
      await fetchRemote()
      if (!(await hasRemoteRef())) return { changed: [], conflicts: [] }
      const before = await headOrEmpty()
      const merge = await exec([
        ...ident, 'merge', '--no-edit', '--allow-unrelated-histories', '-m', `sync: ${machine} merge`, remoteRef,
      ])
      let conflicts: PullConflict[] = []
      if (merge.code !== 0) {
        if ((await unmerged()).size === 0) throw fail(['merge'], merge)
        conflicts = await resolveConflicts()
        await git([...ident, 'commit', '-q', '--no-edit'])
      }
      const after = await headOrEmpty()
      return { changed: await changedBetween(before, after), conflicts }
    },

    async push(): Promise<PushResult> {
      await commitPending()
      if (!(await hasHead())) return { pushed: false }
      const ahead = (await hasRemoteRef()) ? await count(`${remoteRef}..HEAD`) : await count('HEAD')
      if (ahead === 0) return { pushed: false }
      const args = ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]
      const r = await exec(args)
      if (r.code === 0) {
        await exec(['update-ref', `refs/remotes/${remoteRef}`, 'HEAD']) // keep the tracking ref honest if fetch refspec is odd
        return { pushed: true }
      }
      if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(r.stderr) && !/permission|denied|authentication/i.test(r.stderr)) {
        return { pushed: false, reason: 'behind' }
      }
      throw fail(args, r)
    },

    async status(): Promise<ProviderStatus> {
      if (!isRepo()) return { connected: false, dirty: 0, ahead: 0, behind: 0 }
      const cur = await exec(['remote', 'get-url', 'origin'])
      const connected = cur.code === 0
      const dirty = (await dirtyFiles()).length
      const headOk = await hasHead()
      const refOk = await hasRemoteRef()
      const ahead = !headOk ? 0 : refOk ? await count(`${remoteRef}..HEAD`) : await count('HEAD')
      const behind = !refOk ? 0 : headOk ? await count(`HEAD..${remoteRef}`) : await count(remoteRef)
      const out: ProviderStatus = { connected, dirty, ahead, behind }
      if (connected) out.url = maskUrl(cur.stdout.toString('utf8').trim())
      return out
    },

    async disconnect(): Promise<void> {
      if (!isRepo()) return
      if ((await exec(['remote', 'get-url', 'origin'])).code === 0) await git(['remote', 'remove', 'origin'])
    },
  }
}
