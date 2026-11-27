// `tether remote`: the CLI keeps only what lowers power (A-2): see the state, revoke a device, switch the remote off.
// Pairing and switching on are gestures of the app's screen, with the person in front of the machine (E-7).
//   remote status [--json]        on/off, relay, portal, link, sessions and the devices
//   remote off                    switches the remote off: the portal stops, every session ends
//   remote revoke <aparelho>      revokes a device (its id, or a unique start of it with 4+ digits)
// BENCH ONLY, with TETHER_TEST_REMOTE=1 in the environment of this CLI AND of the tetherd (a test flag, never for use):
//   remote on <relay-url> [--web <url>]
//                                 switches the remote on against a bench relay; --web sets the phone app's address the
//                                 pairing QR carries (https://, http:// only for localhost; --web '' forgets it)
//   remote pair                   prints the code, waits for the device, asks for the 6 digits it shows
import { createInterface } from 'node:readline/promises'
import type { DaemonClient } from '../daemon/client.ts'
import { parseArgs, UsageError } from './args.ts'

export interface RemoteIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  connect: () => Promise<DaemonClient | undefined>
  /** One line typed by the person (bench pairing only). */
  ask?: (question: string) => Promise<string>
}

export const REMOTE_USAGE = 'uso: tether remote status [--json] | off | revoke <aparelho>'

interface DeviceView { id: string; name: string; state: string; access: string; createdAt: string; lastSeenAt?: string; revokedAt?: string }
interface Status {
  on: boolean
  relay?: string
  portal: { state: string; reason?: string; pid?: number }
  link: string
  sessions: number
  fingerprint?: string
  webUrl?: string
  live?: { deviceId: string; since: string; doing?: string }[]
  devices: DeviceView[]
}

const STATE_PT: Record<string, string> = { pending: 'pendente', active: 'ativo', revoked: 'revogado' }
const PORTAL_PT: Record<string, string> = { off: 'parado', starting: 'subindo', up: 'no ar', refused: 'recusou subir', down: 'caiu' }

export function describeStatus(s: Status): string {
  const lines = [s.on ? `Acesso remoto: ligado (relay ${s.relay ?? '?'}).` : 'Acesso remoto: desligado.']
  if (s.on || s.portal.state !== 'off') {
    lines.push(`Portal: ${PORTAL_PT[s.portal.state] ?? s.portal.state}${s.portal.pid ? ` (pid ${s.portal.pid})` : ''}${s.portal.reason ? `: ${s.portal.reason}` : ''}.`)
    lines.push(`Relay: ${s.link === 'up' ? 'conectado' : 'desconectado'}. Sessões abertas: ${s.sessions}.`)
  }
  if (s.fingerprint) lines.push(`Impressão digital desta casa: ${s.fingerprint}`)
  if (s.webUrl) lines.push(`App do celular (no QR): ${s.webUrl}`)
  const kept = s.devices.filter((d) => d.state !== 'revoked')
  const on = new Map((s.live ?? []).map((l) => [l.deviceId, l.since]))
  lines.push(kept.length ? 'Aparelhos:' : 'Nenhum aparelho pareado.')
  for (const d of kept) lines.push(`  ${d.id.slice(0, 8)}  ${STATE_PT[d.state] ?? d.state}  ${d.name}${on.has(d.id) ? `  (ligado desde ${on.get(d.id)})` : d.lastSeenAt ? `  (visto ${d.lastSeenAt})` : ''}`)
  return lines.join('\n') + '\n'
}

async function req(client: DaemonClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
  const r = await client.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })
  return r.result
}

export async function cmdRemote(argv: string[], io: RemoteIo): Promise<number> {
  const [sub, ...rest] = argv
  const bench = io.env.TETHER_TEST_REMOTE === '1'
  const a = parseArgs(rest, { flags: ['json'], valued: ['web'] })
  if (!sub) throw new UsageError(REMOTE_USAGE)
  if ((sub === 'pair' || sub === 'on') && !bench) {
    io.err('tether: parear e ligar a remota se faz no app do tether, na tela, com você diante da máquina. A linha de comando só mostra o estado, revoga e desliga.\n')
    return 2
  }
  if (!['status', 'off', 'revoke', 'pair', 'on'].includes(sub)) throw new UsageError(REMOTE_USAGE)
  const client = await io.connect()
  if (!client) { io.err('tether: o tetherd não está rodando.\n'); return 1 }
  try {
    switch (sub) {
      case 'status': {
        const s = await req(client, 'remote.status') as Status
        io.out(a.flags.has('json') ? JSON.stringify(s, null, 2) + '\n' : describeStatus(s))
        return 0
      }
      case 'off':
        await req(client, 'remote.off')
        io.out('Acesso remoto desligado: o portal parou e as sessões dos aparelhos terminaram.\n')
        return 0
      case 'revoke': {
        const id = a.positional[0]
        if (!id || a.positional.length > 1) throw new UsageError('uso: tether remote revoke <aparelho>')
        const r = await req(client, 'device.revoke', { device: id }) as { device: DeviceView }
        io.out(`Aparelho ${r.device.id.slice(0, 8)} (${r.device.name}) revogado: as sessões dele caíram e ele não entra mais.\n`)
        return 0
      }
      case 'on': {
        const url = a.positional[0]
        if (!url) throw new UsageError('uso (bancada): tether remote on <relay-url> [--web <endereço-do-app>]')
        const web = a.options.web
        await req(client, 'remote.on', { relayUrl: url, ...(web !== undefined ? { webUrl: web } : {}) })
        io.out('Acesso remoto ligado (bancada).\n')
        return 0
      }
      case 'pair': return await benchPair(client, io)
    }
    return 0
  } finally {
    client.close()
  }
}

interface PairView { pairId: string; state: string; device?: { declaredName: string }; triesLeft?: number; burnReason?: string; code?: string; fingerprint?: string }

/** Bench only: the same requests the app's screen makes, from a terminal. The tetherd must have the flag too. */
async function benchPair(client: DaemonClient, io: RemoteIo): Promise<number> {
  const begun = await req(client, 'pair.begin') as PairView
  io.out(`[bancada] Código: ${begun.code}\nImpressão digital da casa: ${begun.fingerprint}\nEsperando o aparelho…\n`)
  let v: PairView = begun
  const until = Date.now() + 130_000
  while (v.state === 'open' || v.state === 'revealed') {
    if (Date.now() > until) { io.err('O código expirou.\n'); return 1 }
    await new Promise((r) => setTimeout(r, 500))
    v = await req(client, 'pair.state', { pairId: begun.pairId }) as PairView
  }
  const ask = io.ask ?? (async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try { return await rl.question(q) } finally { rl.close() }
  })
  while (v.state === 'waiting-sas') {
    const digits = await ask(`Aparelho que se declara «${v.device?.declaredName ?? '?'}». Digite só os 6 números que aparecem no SEU aparelho agora: `)
    v = await req(client, 'pair.sas', { pairId: begun.pairId, digits }) as PairView
    if (v.state === 'waiting-sas') io.out(`Não confere. Restam ${v.triesLeft ?? 0} tentativas.\n`)
  }
  for (let i = 0; i < 80 && v.state === 'confirmed'; i++) {
    await new Promise((r) => setTimeout(r, 250))
    v = await req(client, 'pair.state', { pairId: begun.pairId }) as PairView
  }
  if (v.state === 'done') { io.out('Aparelho pareado.\n'); return 0 }
  io.err(`O pareamento não concluiu (${v.burnReason ?? v.state}).\n`)
  return 1
}
