// Recebe o JSON do hook do Claude (stdin) e grava uma linha no arquivo de eventos do slot.
import { appendFileSync } from 'node:fs'
let data = ''
process.stdin.on('data', c => (data += c))
process.stdin.on('end', () => {
  let payload
  try { payload = JSON.parse(data) } catch { payload = { raw: data } }
  const line = { ts: new Date().toISOString(), slot: process.env.TETHER_SLOT_ID ?? null, event: process.argv[2], payload }
  if (process.env.TETHER_EVENTS) appendFileSync(process.env.TETHER_EVENTS, JSON.stringify(line) + '\n')
})
