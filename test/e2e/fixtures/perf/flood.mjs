// Continuous-output fixture: a busy agent. Writes numbered text lines at about <KB/s> (argv[2], default 100) in 50 ms ticks.
const kbps = Number(process.argv[2]) || 100
const perTick = Math.round(kbps * 1024 * 0.05)
let n = 0
process.stdout.write('FLOOD-READY\r\n')
setInterval(() => {
  let s = ''
  while (s.length < perTick) s += `line ${n++} the agent is reading files and writing a fairly long progress line about it ${'x'.repeat(n % 40)}\r\n`
  process.stdout.write(s)
}, 50)
