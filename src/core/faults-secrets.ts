// Where the fault registry learns secret values it must never write down (src/core/faults.ts `addSecretSource`): the
// env values of the launch profiles. Read from profiles.json as it is (no defaults written, no corrupt copy made: this
// runs inside `record`, which must not touch anything but the faults folder). Every profile counts, not only the one of
// the failing slot: the process that fails often does not know which slot it was serving.
import { readFileSync } from 'node:fs'
import { parseProfilesFile, profilesPath } from './profile.ts'

/** The values of every `env` of every profile in `<home>/profiles.json`; empty when the file is absent or unreadable. */
export function profileEnvSecrets(home: string): string[] {
  try {
    const parsed = parseProfilesFile(readFileSync(profilesPath(home), 'utf8'))
    if (!parsed.ok) return []
    return parsed.profiles.flatMap(p => Object.values(p.env ?? {}))
  } catch { return [] }
}
