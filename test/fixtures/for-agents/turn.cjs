// Fake agent for the for-agents flow E2E: no LLM. It reads its input raw. Enter outside a paste submits the line as a turn;
// a bracketed paste (ESC[200~ ... ESC[201~) is one chunk of text whose line breaks stay in it; Backspace erases. A submitted
// line is answered by "RESP <n>: <the line, breaks as ' / '>" and then the agent goes quiet. The end of the turn is the
// engine's report, which the test plays (a fake has none).
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let line = ''
let turns = 0
let pasting = false
function submit() {
  const text = line.trim()
  line = ''
  if (!text) return
  turns++
  setTimeout(() => process.stdout.write(`RESP ${turns}: ${text}\r\n`), 150)
}
process.stdin.on('data', (d) => {
  for (const part of d.toString().split(/(\x1b\[20[01]~)/)) {
    if (part === '\x1b[200~') { pasting = true; continue }
    if (part === '\x1b[201~') { pasting = false; continue }
    for (const ch of part) {
      if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
      else if (ch.charCodeAt(0) === 21) line = '' // Ctrl+U
      else if (ch === '\r' || ch === '\n') { if (pasting) line += ' / '; else submit() }
      else if (ch >= ' ') line += ch
    }
  }
})
process.stdout.write('READY\r\n')
setInterval(() => {}, 1000)
