// Ends the processes of the bench scene and removes the bench root. Targets are chosen ONLY by command line:
// it contains the bench root (a unique path), or carries --relaunched-from=<pid> of a bench app (the Electron relaunch chain).
// Never by executable name alone. Refuses when the root holds a link (junction or symlink) or sits where it must not.
//   node teardown.mjs
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { CLI, SCENE, listProcs, norm, readScene, selfChain } from './lib.mjs'

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
const rootN = norm(root)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const killTree = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
const daemonPid = () => { try { return Number.parseInt(readFileSync(join(scene.home, 'tetherd.pid'), 'utf8'), 10) || undefined } catch { return undefined } }

// Bench processes: root in the command line, or relaunched from a PID already known to be a bench app (fixpoint).
function benchProcs() {
  const procs = listProcs()
  const skip = selfChain(procs)
  const appPids = new Set(scene.pids?.app ? [scene.pids.app] : [])
  const recorded = new Set([...Object.values(scene.pids ?? {}), daemonPid()].filter(Boolean))
  const hit = new Map()
  for (let changed = true; changed;) {
    changed = false
    for (const p of procs) {
      if (hit.has(p.pid) || skip.has(p.pid)) continue
      const rel = /--relaunched-from=(\d+)/.exec(p.cmd)
      const byRoot = norm(p.cmd).includes(rootN) || (recorded.has(p.pid) && /node|electron|tether/i.test(p.name))
      const byRelaunch = rel && appPids.has(Number(rel[1]))
      if (byRoot || byRelaunch) {
        hit.set(p.pid, p)
        if (byRelaunch || (/electron/i.test(p.name) && !/--type=/.test(p.cmd))) appPids.add(p.pid)
        changed = true
      }
    }
  }
  return { list: [...hit.values()], appPids }
}

const stage = (p, appPids, dPids) => appPids.has(p.pid) ? 0 : dPids.has(p.pid) || /tetherd/i.test(p.name) ? 1 : 2
const label = ['app', 'daemon', 'resto']
let stopped = false
const deadline = Date.now() + 20_000
for (;;) {
  const { list, appPids } = benchProcs()
  const dPids = new Set([daemonPid(), scene.pids?.daemon].filter(Boolean))
  const first = Math.min(...list.map(p => stage(p, appPids, dPids)), 9)
  if (list.length === 0) break
  if (Date.now() > deadline) break
  if (first === 1 && !stopped) { stopped = true; spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env, stdio: 'ignore', timeout: 15_000 }) }
  for (const p of list.filter(p => stage(p, appPids, dPids) === first)) {
    killTree(p.pid)
    console.log(`encerrado: ${label[first]} (${p.pid} ${p.name})`)
  }
  await sleep(700)
}

const left = benchProcs().list
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
} catch (e) {
  const holders = left.map(p => `${p.pid} ${p.name}`).join(', ') || 'nenhum processo achado'
  console.error(`nao consegui apagar ${root} (${e.code ?? e.message}); seguram a pasta: ${holders}`)
  process.exit(1)
}
rmSync(SCENE, { force: true })
console.log(`bancada apagada: ${root}`)
