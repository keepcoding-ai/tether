// The entry of a process that is not tetherd (the CLI, Electron main, the doctor): its extensions read settings.json and
// profiles.json synchronously from disk, as these processes always did. Imported for the side effect, next to load.ts.
import { readProfiles } from '../core/profile-sync.ts'
import { readUserSettings } from '../core/user-settings-sync.ts'
import { setHostSources } from './load.ts'

setHostSources({ settings: (home) => readUserSettings(home), profiles: (home) => readProfiles(home).profiles })
