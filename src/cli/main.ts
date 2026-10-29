// CLI entry point (`bin/tether.mjs`). Only `doctor` is implemented here; the other subcommands come with T4.
import { exitCodeFor, formatReport, runDoctor } from '../doctor.ts'

export async function main(argv: string[]): Promise<number> {
  const [command] = argv
  if (command === 'doctor') {
    const results = await runDoctor()
    process.stdout.write(formatReport(results))
    return exitCodeFor(results)
  }
  process.stderr.write(`tether: not implemented yet (${argv.join(' ')})\n`)
  return 1
}
