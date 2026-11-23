// Ends what the channels scene started and removes what it created. Processes are chosen by the PIDs the scene recorded and
// by a command line that carries the bench's own unique paths (never by executable name alone); the Electron relaunch chain
// (--relaunched-from=<pid>) of a bench app counts too. Folders go by absolute path, and only the two roots setup made:
// the bench under C:/atrium/.tmp/tether-agents/onda-3/cena/bench-* and the work folders in the system temp (tether-canais-*).
// Refuses when either root holds a link (junction or symlink) or sits where it must not.
//   node teardown.mjs
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { CLI, OUT, SCENE, listProcs, norm, readScene, selfChain } from './lib.mjs'

const scene = readScene()
const { root, work } = scene
const benchPrefix = `${norm(OUT)}/bench-`
if (!root || !norm(root).startsWith(benchPrefix) || !work || !work.startsWith(tmpdir() + sep) || !work.includes('tether-canais-')) {
  console.error(`raizes fora do esperado, nada feito: ${root} | ${work}`); process.exit(1)
}

function links(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) found.push(p)
    else if (st.isDirectory()) links(p, found)
  }
  return found
}
for (const dir of [root, work]) {
  if (!existsSync(dir)) continue
  const found = links(dir)
  if (found.length) { console.error(`ha links na bancada, recuso apagar:\n${found.join('\n')}`); process.exit(1) }
}

const env = { ...process.env, TETHER_HOME: scene.home, TETHER_PIPE: scene.pipe }
for (const k of Object.keys(env)) if (/^(CLAUDE|TETHER_SLOT)/i.test(k)) delete env[k]
const roots = [norm(root), norm(work)]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const killTree = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
const daemonPid = () => { try { return Number.parseInt(readFileSync(join(scene.home, 'tetherd.pid'), 'utf8'), 10) || undefined } catch { return undefined } }

// Bench processes: a bench path in the command line, a PID the scene recorded, or relaunched from a PID known to be a bench app.
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
      const cmd = norm(p.cmd)
      const byRoot = roots.some(r => cmd.includes(r)) || (recorded.has(p.pid) && /node|electron|tether/i.test(p.name))
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
let bad = false
for (const dir of [work, root]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    console.log(`apagada: ${dir}`)
  } catch (e) {
    bad = true
    const holders = left.map(p => `${p.pid} ${p.name}`).join(', ') || 'nenhum processo achado'
    console.error(`nao consegui apagar ${dir} (${e.code ?? e.message}); seguram a pasta: ${holders}`)
  }
}
if (bad) process.exit(1)
rmSync(SCENE, { force: true })
rmSync(join(OUT, 'check-before.json'), { force: true })
console.log('bancada desmontada')
