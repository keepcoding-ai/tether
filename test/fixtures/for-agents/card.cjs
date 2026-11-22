// Fake agent for the for-agents flow E2E: no LLM. On a line ended by Enter it opens a turn and prints a permission card, then
// waits for the choice as one key: 1 (yes), 2 (always), 3 (no). The choice closes the card and prints the outcome; the turn ends
// in the quiet that follows.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let line = ''
let asking = false
const OUTCOME = { 1: 'yes', 2: 'always', 3: 'no' }
process.stdin.on('data', (d) => {
  for (const ch of d.toString()) {
    if (asking) {
      if (!OUTCOME[ch]) continue
      asking = false
      setTimeout(() => process.stdout.write(`CARD CLOSED: ${OUTCOME[ch]}\r\nRESP: done after ${OUTCOME[ch]}\r\n`), 100)
    } else if (ch === '\r' || ch === '\n') {
      if (!line.trim()) { line = ''; continue }
      line = ''
      asking = true
      process.stdout.write('\r\nPERMISSION CARD: create the file probe.txt?\r\n  1. yes\r\n  2. always\r\n  3. no\r\n')
    } else if (ch >= ' ') line += ch
  }
})
process.stdout.write('READY\r\n')
setInterval(() => {}, 1000)
