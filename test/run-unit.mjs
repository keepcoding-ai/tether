// Runs the unit suite in two stages: everything else in parallel (capped), then the
// timing-sensitive files (*.timing.test.ts) serially. Both stages always run so one
// failure never hides the other; the exit code is non-zero if either failed.
import { spawnSync } from 'node:child_process'

const common = ['--test', '--test-timeout=120000']
const stages = [
  ['--test-concurrency=4', 'test/unit/**/!(*.timing).test.ts'],
  ['--test-concurrency=1', 'test/unit/**/*.timing.test.ts'],
]
let code = 0
for (const [conc, glob] of stages) {
  const r = spawnSync(process.execPath, [...common, conc, glob], { stdio: 'inherit' })
  if (r.status !== 0) code = r.status ?? 1
}
process.exit(code)
