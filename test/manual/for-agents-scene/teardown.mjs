// Ends only the processes registered in scene.json (setup.mjs record ...) plus the daemon whose pid file sits in the bench home,
// then removes the bench root. Refuses when the root holds a link (junction or symlink) or sits where it must not.
//   node teardown.mjs
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { CLI, SCENE, readScene } from './lib.mjs'

const scene = readScene()
const root = scene.root
if (!root || !root.startsWith(tmpdir() + sep) || !root.includes('tether-cena-')) { console.error(`raiz fora do esperado, nada feito: ${root}`); process.exit(1) }

function links(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) found.push(p)
    else if (st.isDirectory()) links(p, found)
  }
  return found
}
if (existsSync(root)) {
  const found = links(root)
  if (found.length) { console.error(`ha links na bancada, recuso apagar:\n${found.join('\n')}`); process.exit(1) }
}

const env = { ...process.env, TETHER_HOME: scene.home, TETHER_PIPE: scene.pipe }
for (const k of Object.keys(env)) if (/^(CLAUDE|TETHER_SLOT)/i.test(k)) delete env[k]
const pids = { ...scene.pids }
try { const n = Number.parseInt(readFileSync(join(scene.home, 'tetherd.pid'), 'utf8'), 10); if (n && !pids.daemon) pids.daemon = n } catch { /* no pid file */ }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// The app first, then a graceful daemon stop (it ends the PTY trees), then whatever is left, by the recorded PID.
if (pids.app && alive(pids.app)) { spawnSync('taskkill', ['/PID', String(pids.app), '/T', '/F'], { stdio: 'ignore' }); console.log(`encerrado: app (${pids.app})`) }
if (pids.daemon && alive(pids.daemon)) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env, stdio: 'ignore', timeout: 20_000 })
for (const [name, pid] of Object.entries(pids)) {
  if (name !== 'app' && alive(pid)) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); console.log(`encerrado: ${name} (${pid})`) }
}
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
rmSync(SCENE, { force: true })
console.log(`bancada apagada: ${root}`)
