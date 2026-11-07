// A stand-in for the soul CLI in tests (TETHER_SOUL_CMD="node <this file>"): reports its session the way the soul does
// (a `start` event appended to SOUL_SESSION_REPORT, which makes the slot "running" and its turn idle), then reads lines in
// raw mode and echoes them. A line starting with "work" prints a burst (>= 512 bytes) and goes quiet, which the daemon's
// idle heuristic reads as the end of a turn; any other line prints a few bytes and the turn never "ends" (busy for good).
import { appendFileSync } from 'node:fs'

const report = process.env.SOUL_SESSION_REPORT
const slotId = process.env.TETHER_SLOT_ID
if (report && slotId) {
  const sessionId = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '0')}`
  const cwd = process.cwd()
  const ev = { v: 1, ts: new Date().toISOString(), slotId, agent: 'soul', kind: 'start', source: 'startup', sessionId, cwd, resume: { cwd, args: ['-r', sessionId] } }
  appendFileSync(report, JSON.stringify(ev) + '\n')
}
process.stdout.write('fake soul ready\r\n> ')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let line = ''
process.stdin.on('data', chunk => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      const text = line
      line = ''
      process.stdout.write(`\r\ngot: ${text}\r\n`)
      if (text.startsWith('work')) setTimeout(() => process.stdout.write('x'.repeat(600) + '\r\n> '), 100)
    } else if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1)
    } else {
      line += ch
      process.stdout.write(ch)
    }
  }
})
setInterval(() => {}, 1000)
