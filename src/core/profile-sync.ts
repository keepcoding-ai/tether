// Launch profiles, synchronous side: profiles.json read and written straight from disk, for the CLI, Electron main and the
// tests. tetherd never imports this file: it keeps the snapshot in profile.ts (ProfileStore), reloaded by the executor.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { defaultShell } from '../agents/shell-sync.ts'
import { defaultProfilesWith, gitBashPath, parseProfilesFile, profilesPath, type Profile, type ProfilesFile, type ProfilesRead } from './profile.ts'

/** The default profiles of this machine (the shell found on PATH, Git Bash when its file exists). */
export function defaultProfiles(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Profile[] {
  return defaultProfilesWith(env, platform, defaultShell(env, platform), platform === 'win32' && existsSync(gitBashPath(env)))
}

/** Atomic: the whole file goes to a temp name first, then replaces the old one. */
export function writeProfiles(home: string, profiles: Profile[]): void {
  const path = profilesPath(home)
  mkdirSync(home, { recursive: true })
  const file: ProfilesFile = { v: 1, profiles }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n')
  renameSync(tmp, path)
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * The profiles on disk. A missing file is created with the defaults. A file that cannot be parsed is copied to
 * `profiles.json.corrompido-<time>` and replaced by the defaults (the copy fails → nothing is overwritten and the
 * defaults are used in memory only); either way `problem` says what happened, for the CLI/app to show.
 */
export function readProfiles(home: string): ProfilesRead {
  const path = profilesPath(home)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { profiles: defaultProfiles(), problem: `não consegui ler ${path} (${(e as Error).message}); usando os perfis padrão` }
    }
    const profiles = defaultProfiles()
    try { writeProfiles(home, profiles) } catch { /* read-only home: the defaults still work in memory */ }
    return { profiles }
  }
  const parsed = parseProfilesFile(text)
  if (parsed.ok) {
    if (parsed.skipped === 0) return { profiles: parsed.profiles }
    return { profiles: parsed.profiles, problem: `${path}: ${parsed.skipped} perfil(is) malformado(s) ignorado(s)` }
  }
  const backup = `${path}.corrompido-${stamp()}`
  try {
    copyFileSync(path, backup)
  } catch (e) {
    return { profiles: defaultProfiles(), problem: `${path} está inválido (${parsed.error}) e não consegui guardar uma cópia (${(e as Error).message}); usando os perfis padrão sem gravar` }
  }
  const profiles = defaultProfiles()
  writeProfiles(home, profiles)
  return { profiles, backup, problem: `${path} estava inválido (${parsed.error}); cópia guardada em ${backup}; perfis padrão recriados` }
}
