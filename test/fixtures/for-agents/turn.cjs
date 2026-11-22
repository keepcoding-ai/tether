// Fake agent for the for-agents flow E2E: no LLM. It reads its input raw; a line ended by Enter is a turn, and the turn
// ends by itself: it prints "RESP <n>: <the line, whole>" and goes quiet (the quiet is what the core reads as the end of
// the turn, and what the test's owner is told about). Several lines arrive as one paste: it answers once, with the first line.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let line = ''
let turns = 0
process.stdin.on('data', (d) => {
  for (const ch of d.toString()) {
    if (ch === '\r' || ch === '\n') {
      const text = line.trim()
      line = ''
      if (!text) continue
      turns++
      setTimeout(() => process.stdout.write(`RESP ${turns}: ${text}\r\n`), 150)
    } else if (ch >= ' ') line += ch
  }
})
process.stdout.write('READY\r\n')
setInterval(() => {}, 1000)
