const pty = require('node-pty'); const fs = require('fs')
const [,, settings, events, cwd, logFile, stepsJson, ...extra] = process.argv
const steps = JSON.parse(stepsJson)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))); Object.assign(env, { TETHER_SLOT_ID: process.env.TSLOT || 'slotI', TETHER_EVENTS: events })
const p = pty.spawn('claude.exe', ['--model', 'haiku', '--settings', settings, ...extra], { cols: 120, rows: 40, cwd, env, useConpty: true })
let out = ''
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
p.onData(d => { out += d; fs.appendFileSync(logFile, strip(d)) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (re, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(strip(out))) return true; await sleep(300) } return false }
const typeLine = async s => { for (const ch of s) { p.write(ch); await sleep(15) } await sleep(400); p.write('\r') }
;(async () => {
  await sleep(4000)
  if (/trust/i.test(strip(out))) { p.write('\x1b[B'); await sleep(500); p.write('\r'); await sleep(5000) }
  for (const st of steps) {
    if (st.kill) { console.log('KILL'); p.kill(); await sleep(3000); process.exit(0) }
    console.log('STEP', st.type ?? st.raw); out = ''
    if (st.raw) p.write(st.raw); else await typeLine(st.type)
    await sleep(st.wait ?? 8000)
  }
  await sleep(3000); try { p.kill() } catch {} ; process.exit(0)
})()
p.onExit(e => { console.log('EXIT', JSON.stringify(e)) })
