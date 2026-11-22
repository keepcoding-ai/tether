// A browser process stand-in for process-host.ts: plain node (the host spawns process.execPath), speaking the real line (Wire):
// hello, ready, ping, the invokes the tests use, and the endpoint file the real gatekeeper writes.
const { connect } = require('node:net')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

;(async () => {
  const { Wire } = await import(process.env.FAKE_WIRE_URL)
  const socket = connect(process.env.TETHER_BROWSER_PIPE)
  await new Promise(r => socket.once('connect', r))
  const w = new Wire(socket)
  w.whenClosed(() => process.exit(0))
  const dir = join(process.env.TETHER_BROWSER_HOME, 'browser')
  const endpoint = join(dir, 'endpoint.json')
  await w.call('hello', process.env.TETHER_BROWSER_TOKEN, process.pid)
  w.handle('ping', () => true)
  w.handle('window', () => {})
  w.handle('agentChange', () => {})
  w.handle('surface', () => {})
  w.handle('ipcInvoke', (channel, args) => {
    if (channel === 'restore' || channel === 'reopenClosed') {
      const info = { tabId: args[0]?.tabId ?? 't-new', surfaceId: 's-' + (args[0]?.tabId ?? 'new'), loading: false }
      w.post('ipcEvent', 'tab', [info])
      return info
    }
    if (channel === 'close') { w.post('ipcEvent', 'closed', [args[0]]); return }
    return null
  })
  // Lets a test have this process raise an event of the extension, as the real one does.
  w.handle('testRun', (_src, arg) => { w.post('ipcEvent', arg.channel, arg.args) })
  w.handle('quit', () => { rmSync(endpoint, { force: true }); setTimeout(() => process.exit(0), 20) })
  setTimeout(() => { mkdirSync(dir, { recursive: true }); writeFileSync(endpoint, JSON.stringify({ v: 1, port: 1, pid: process.pid, instance: 'x' })) }, 80)
  w.post('ready')
})()
