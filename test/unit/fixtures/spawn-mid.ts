// The "app" side of the spawnDaemon probe: starts the daemon (a sleeper script here) through the real helper,
// prints its pid and exits at once. Run by test/unit/fixtures/spawn-inherit.ps1.
import { spawnDaemon } from '../../../src/daemon/client.ts'

const [home, pipe, sleeper] = process.argv.slice(2) as [string, string, string]
const pid = await spawnDaemon({ home, pipe, mainPath: sleeper })
process.stdout.write(`${pid ?? ''}\n`)
