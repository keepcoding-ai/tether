// The sync extension's daemon side: one `tether doctor` line. It reads <home>/sync.json and <home>/sync-last.json and looks for
// git on PATH, all through the daemon's asynchronous disk facade (api.io; tetherd is under test/unit/arch.sync-ratchet.test.ts).
// The remote goes out masked (rules.ts doctorCheck).
import { delimiter, join } from 'node:path'
import type { DaemonIo, TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { doctorCheck, type DoctorCheck } from './rules.ts'

export { manifest } from './manifest.ts'

/** Is `git` an executable file on PATH (asynchronous: io.exists per candidate). */
export async function gitOnPath(io: Pick<DaemonIo, 'exists'>, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const names = platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git'] : ['git']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) if (await io.exists(join(dir, n)).catch(() => false)) return true
  }
  return false
}

export async function syncCheck(o: { home: string; io: Pick<DaemonIo, 'tryReadText' | 'exists'>; env?: NodeJS.ProcessEnv; now?: number }): Promise<DoctorCheck> {
  const configText = await o.io.tryReadText(join(o.home, 'sync.json')).catch(() => undefined)
  // Without a link nothing else is read (git is not this line's business then).
  if (configText === undefined) return doctorCheck({ configText, lastText: undefined, gitFound: true, now: o.now ?? Date.now() })
  const [lastText, gitFound] = await Promise.all([
    o.io.tryReadText(join(o.home, 'sync-last.json')).catch(() => undefined),
    gitOnPath(o.io, o.env),
  ])
  return doctorCheck({ configText, lastText, gitFound, now: o.now ?? Date.now() })
}

export function activate(api: TetherDaemon): IDisposable[] {
  return [api.doctor.register(() => syncCheck({ home: api.home, io: api.io }))]
}
