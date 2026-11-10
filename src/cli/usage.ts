// `tether usage [--json] [--fresh]`: the agent's own LLM usage on its platform (what is left of each limit and when it
// renews). Only the Claude Code source exists so far (skills/llm-usage, references/claude.md).
// Lives in the CLI, not in a loose script, because every pane already gets TETHER_CLI: `node "$TETHER_CLI" usage`
// works from any shell and any cwd, with no new variable.
import { parseArgs } from './args.ts'
import { defaultUsageDeps, EXIT_CODES, readClaudeUsage, renderUsageText, type UsageDeps } from '../usage/claude.ts'

export const USAGE_HELP = `uso: tether usage [--json] [--fresh]

  Mostra o uso de LLM do plano do Claude Code: cada limite, quanto foi usado e quando renova.
  Fonte: o uso oficial do plano da Anthropic, lido com o login do Claude Code desta máquina
  (env CLAUDE_CODE_OAUTH_TOKEN; Windows e Linux: .credentials.json; macOS: Keychain). O token nunca é exibido.

  --json     a mesma informação como JSON (inclui source "live"|"cache" e ageSec)
  --fresh    ignora o cache e consulta a fonte agora (ela limita a ~1 consulta a cada 5 min)

Saída: 0 ok · 2 uso inválido · 3 sem credencial/token expirado · 4 erro de rede/HTTP · 5 formato mudou
`

export interface UsageIo { out: (t: string) => void; err: (t: string) => void; deps?: UsageDeps }

export async function cmdUsage(args: string[], io: UsageIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.out(USAGE_HELP); return 0 }
  const p = parseArgs(args, { flags: ['json', 'fresh'] })
  const json = p.flags.has('json')
  const r = await readClaudeUsage(io.deps ?? defaultUsageDeps(), { fresh: p.flags.has('fresh') })
  if (r.state === 'ok') {
    io.out(`${json ? JSON.stringify(r, null, 2) : renderUsageText(r)}\n`)
    return 0
  }
  io.out(`${json ? JSON.stringify(r, null, 2) : `[${r.state}] ${r.message}`}\n`)
  return EXIT_CODES[r.state]
}
