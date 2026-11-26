// Entry of the relay: `node remote/relay/src/main.ts serve [--port N] [--host H] [--aud A] [--origins a,b]`.
// Each flag falls back to an environment variable (RELAY_PORT, RELAY_HOST, RELAY_AUD, RELAY_ORIGINS). Logs are one
// JSON object per line on stdout. SIGINT and SIGTERM close every socket and empty the maps before exiting.
import { isValidAudBytes } from '../../../src/remote/index.ts'
import { startRelay } from './shell.ts'

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function log(event: string, fields: Record<string, string | number> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`)
}

async function serve(args: readonly string[]): Promise<void> {
  const port = Number(flag(args, 'port') ?? process.env.RELAY_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('porta inválida')
  const host = flag(args, 'host') ?? process.env.RELAY_HOST ?? 'localhost'
  const aud = flag(args, 'aud') ?? process.env.RELAY_AUD
  if (aud !== undefined && !isValidAudBytes(new TextEncoder().encode(aud))) throw new Error('aud inválido: 1 a 253 bytes ASCII visíveis, sem maiúsculas')
  const originsRaw = flag(args, 'origins') ?? process.env.RELAY_ORIGINS
  const origins = originsRaw ? originsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const relay = await startRelay({ port, host, aud, origins, log })
  log('relay.listening', { port: relay.port, aud: relay.aud, origins: origins ? origins.length : 'any' })
  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    void relay.close().then(() => {
      const s = relay.stats()
      log('relay.stopped', { signal, peers: s.peers, houses: s.houses, routes: s.routes, listens: s.listens, ips: s.ips })
      process.exit(0)
    })
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'serve') {
  serve(rest).catch(e => { log('relay.failed', { error: e instanceof Error ? e.message : String(e) }); process.exit(1) })
} else {
  process.stderr.write('uso: node remote/relay/src/main.ts serve [--port N] [--host H] [--aud A] [--origins a,b]\n')
  process.exit(2)
}
