// Dev runner: starts the fake daemon on a unique pipe, then Electron against it; kills the daemon
// (by PID) when the window exits. Usage: npm run app:fake
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const pipe = process.env.TETHER_PIPE ?? `\\\\.\\pipe\\tether-fake-${process.pid}`
const env = { ...process.env, TETHER_PIPE: pipe }
if (!env.TETHER_HOME) env.TETHER_HOME = join(process.env.LOCALAPPDATA ?? here, 'tether-fake')

const daemon = spawn(process.execPath, [join(here, 'fake-daemon', 'fake-daemon.ts')], { env, stdio: 'inherit' })

function waitForPipe(tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const s = connect(pipe)
      s.once('connect', () => { s.destroy(); resolve() })
      s.once('error', () => { if (n <= 0) reject(new Error(`o tetherd falso não abriu ${pipe}`)); else setTimeout(() => attempt(n - 1), 100) })
    }
    attempt(tries)
  })
}

try {
  await waitForPipe()
  const electron = spawn(electronPath, [join(here, 'dist', 'main.cjs')], { env, stdio: 'inherit' })
  await new Promise(resolve => electron.once('exit', resolve))
} finally {
  if (daemon.pid) process.kill(daemon.pid)
}
