// Prepares the bench of the for-agents scene (contract section 8, slice V2). Touches nothing of the real tether.
//   node setup.mjs                       creates the bench root (system temp, random suffix) and says the two modes
//   node setup.mjs up                    starts the daemon (serve mode) and the visible app itself, records the PIDs
//   node setup.mjs print                 prints the PowerShell and Git Bash blocks instead
//   node setup.mjs record <name> <pid>   registers a process the scene started, so teardown may end it
import { existsSync, mkdirSync, mkdtempSync, realpathSync, openSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CLI, SCENE, WT, readScene, writeScene } from './lib.mjs'

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'record') {
  const [name, pid] = rest
  if (!name || !/^\d+$/.test(pid ?? '')) { console.error('uso: node setup.mjs record <nome> <pid>'); process.exit(2) }
  const scene = readScene()
  scene.pids = { ...scene.pids, [name]: Number(pid) }
  writeScene(scene)
  console.log(`registrado: ${name} = ${pid}`)
  process.exit(0)
}

function createBench() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tether-cena-')))
  if (/^c:[\\/](atrium|agentes|kai)([\\/]|$)/i.test(root)) { console.error(`raiz de bancada em lugar proibido: ${root}`); process.exit(1) }
  const home = join(root, 'home')
  const dirs = { c1: join(root, 'c1'), ser: join(root, 'ser'), c3: join(root, 'c3') }
  for (const d of [home, ...Object.values(dirs)]) mkdirSync(d, { recursive: true })
  const suffix = basename(root).slice('tether-cena-'.length)
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-cena-${suffix}` : join(root, 'tetherd.sock')
  const electron = createRequire(join(WT, 'package.json'))('electron')
  const scene = { createdAt: new Date().toISOString(), worktree: WT, root, home, pipe, cli: CLI, dirs, electron, pids: {} }
  writeScene(scene)
  return scene
}

// Reuses the bench of scene.json while its root still exists; otherwise makes a new one.
function ensureBench() {
  if (existsSync(SCENE)) {
    const s = readScene()
    if (s.root && existsSync(s.root)) return s
  }
  return createBench()
}

// No inherited CLAUDE* / TETHER_*; the bench home and pipe go through spawn's env, so no shell can mangle the pipe name.
function benchEnv(scene) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CLAUDE|TETHER_)/i.test(k)) delete env[k]
  return { ...env, TETHER_HOME: scene.home, TETHER_PIPE: scene.pipe }
}

function launch(scene, name, file, args, env, logName) {
  const log = openSync(join(scene.root, logName), 'a')
  const child = spawn(file, args, { cwd: WT, env, detached: true, stdio: ['ignore', log, log], windowsHide: name === 'daemon' })
  child.unref()
  scene.pids = { ...scene.pids, [name]: child.pid }
  writeScene(scene)
  console.log(`${name}: pid ${child.pid}`)
}

if (cmd === 'up') {
  const scene = ensureBench()
  const env = benchEnv(scene)
  console.log(`bancada: ${scene.root}`)
  launch(scene, 'daemon', process.execPath, ['src/daemon/main.ts'], env, 'daemon.log')
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 500))
    up = spawnSync(process.execPath, [CLI, 'daemon', 'status'], { env, stdio: 'ignore', cwd: WT, timeout: 10_000 }).status === 0
  }
  if (!up) { console.error(`o daemon nao respondeu em 20 s (veja ${join(scene.root, 'daemon.log')})`); process.exit(1) }
  console.log('daemon respondeu')
  const build = spawnSync(process.execPath, ['app/build.mjs'], { env, cwd: WT, stdio: 'inherit' })
  if (build.status !== 0) { console.error('app/build.mjs falhou'); process.exit(1) }
  launch(scene, 'app', scene.electron, ['app/dist/main.cjs'], env, 'app.log')
  console.log('pronto: app aberto. Ao terminar, rode node teardown.mjs')
  process.exit(0)
}

const scene = cmd === 'print' ? ensureBench() : createBench()
console.log(`bancada: ${scene.root}\npipe:    ${scene.pipe}\ncena:    ${SCENE}\n`)

if (cmd !== 'print') {
  console.log('Dois modos:\n  node setup.mjs up      sobe o daemon e o app visivel por conta propria (recomendado)\n  node setup.mjs print   imprime os blocos para colar em PowerShell ou Git Bash')
  process.exit(0)
}

const { home, pipe, electron } = scene
const rec = 'node test/manual/for-agents-scene/setup.mjs record'
console.log(`# ===== PowerShell NOVO =====
# 1) Tira CLAUDE* e TETHER_* herdados e fixa home e pipe da bancada:
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|TETHER_)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:TETHER_HOME = '${home}'
$env:TETHER_PIPE = '${pipe}'
Set-Location '${WT}'

# 2) tetherd em modo serve (nunca watch); registra o PID:
$d = Start-Process node -ArgumentList 'src/daemon/main.ts' -WorkingDirectory '${WT}' -WindowStyle Minimized -PassThru
${rec} daemon $d.Id

# 3) o app VISIVEL: build de producao, depois o Electron; registra o PID:
node app/build.mjs
$a = Start-Process '${electron}' -ArgumentList 'app/dist/main.cjs' -WorkingDirectory '${WT}' -PassThru
${rec} app $a.Id

# ===== Git Bash NOVO =====
# MSYS_NO_PATHCONV impede que o MSYS engula uma barra do nome do pipe.
export MSYS_NO_PATHCONV=1
for v in $(env | grep -oE '^(CLAUDE|TETHER_)[A-Za-z0-9_]*'); do unset "$v"; done
export TETHER_HOME='${home.replaceAll('\\', '/')}'
export TETHER_PIPE='${pipe}'
cd '${WT.replaceAll('\\', '/')}'
node src/daemon/main.ts > "$TETHER_HOME/../daemon.log" 2>&1 &
${rec} daemon $!   # em Git Bash $! e o PID do MSYS; prefira 'node setup.mjs up'
node app/build.mjs
'${electron.replaceAll('\\', '/')}' app/dist/main.cjs > "$TETHER_HOME/../app.log" 2>&1 &
`)
