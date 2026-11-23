// Prepares the bench of the channels scene (contract section 8, slice S1). Touches nothing of the real tether: own home, own
// pipe, own work folders.
//   node setup.mjs                       creates the bench (home under .tmp, work folders in the system temp), turns the
//                                        extensions for-agents, channels and skills on, says how to open the app
//   node setup.mjs up [--no-app]         starts the daemon (serve mode) and, unless --no-app, builds and opens the visible app
//   node setup.mjs print                 prints the PowerShell and Git Bash blocks instead of `up`
//   node setup.mjs record <name> <pid>   registers a process the scene started, so teardown may end it
import { existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CLI, OUT, SCENE, WT, readScene, writeScene } from './lib.mjs'

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

// The agents work in folders OUTSIDE D:/atrium, D:/agentes and D:/kai (system temp); the home and the evidence stay in .tmp.
function createBench() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'tether-canais-')))
  if (/^d:[\\/](atrium|agentes|kai)([\\/]|$)/i.test(work)) { console.error(`pasta de trabalho em lugar proibido: ${work}`); process.exit(1) }
  const suffix = basename(work).slice('tether-canais-'.length)
  mkdirSync(OUT, { recursive: true })
  const root = join(OUT, `bench-${suffix}`)
  const home = join(root, 'home')
  const dirs = { c1: join(work, 'c1'), ser: join(work, 'ser'), c3: join(work, 'c3') }
  for (const d of [home, ...Object.values(dirs)]) mkdirSync(d, { recursive: true })
  // The three extensions of the scene are on by default (the list names what is OFF): say so explicitly, so the bench
  // does not depend on a default. Conductors and the rest keep their default.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: [] } }, null, 2))
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-canais-${suffix}` : join(root, 'tetherd.sock')
  const electron = createRequire(join(WT, 'package.json'))('electron')
  const scene = { createdAt: new Date().toISOString(), worktree: WT, root, work, home, pipe, cli: CLI, dirs, electron, extensions: ['for-agents', 'channels', 'skills'], pids: {} }
  writeScene(scene)
  return scene
}

// Reuses the bench of scene.json while its folders still exist; otherwise makes a new one.
function ensureBench() {
  if (existsSync(SCENE)) {
    const s = readScene()
    if (s.root && existsSync(s.root) && s.work && existsSync(s.work)) return { scene: s, fresh: false }
  }
  return { scene: createBench(), fresh: true }
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
  const { scene } = ensureBench()
  const env = benchEnv(scene)
  const withApp = !rest.includes('--no-app')
  console.log(`bancada: ${scene.root}`)
  if (scene.pids?.daemon) { console.error(`a bancada ja tem daemon registrado (pid ${scene.pids.daemon}); rode teardown.mjs antes de subir de novo`); process.exit(1) }
  launch(scene, 'daemon', process.execPath, ['src/daemon/main.ts'], env, 'daemon.log')
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 500))
    up = spawnSync(process.execPath, [CLI, 'daemon', 'status'], { env, stdio: 'ignore', cwd: WT, timeout: 10_000 }).status === 0
  }
  if (!up) { console.error(`o daemon nao respondeu em 20 s (veja ${join(scene.root, 'daemon.log')})`); process.exit(1) }
  console.log('daemon respondeu')
  if (!withApp) { console.log('pronto: so o daemon (--no-app). Ao terminar, rode node teardown.mjs'); process.exit(0) }
  const build = spawnSync(process.execPath, ['app/build.mjs'], { env, cwd: WT, stdio: 'inherit' })
  if (build.status !== 0) { console.error('app/build.mjs falhou'); process.exit(1) }
  launch(scene, 'app', scene.electron, ['app/dist/main.cjs'], env, 'app.log')
  console.log('pronto: app aberto. Siga o README.md; ao terminar, rode node teardown.mjs')
  process.exit(0)
}

const { scene, fresh } = ensureBench()
console.log(`${fresh ? 'bancada criada' : 'bancada ja existia (reaproveitada)'}: ${scene.root}`)
console.log(`home:    ${scene.home}\npipe:    ${scene.pipe}\ncena:    ${SCENE}`)
console.log(`pastas dos agentes (fora de D:/atrium):\n  claude  ${scene.dirs.c1}\n  soul    ${scene.dirs.ser}   (o ser nasce novo e vazio, pelos verbos do motor)\n  codex   ${scene.dirs.c3}`)
console.log(`extensoes ligadas: ${scene.extensions.join(', ')} (settings.json do home da bancada)`)

if (cmd !== 'print') {
  console.log('\nComo abrir:\n  node test/manual/channels-scene/setup.mjs up            daemon (modo serve) + app visivel, sozinho (recomendado)\n  node test/manual/channels-scene/setup.mjs up --no-app   so o daemon (ensaio sem tela)\n  node test/manual/channels-scene/setup.mjs print         blocos para colar em PowerShell ou Git Bash')
  process.exit(0)
}

const { home, pipe, electron } = scene
const rec = 'node test/manual/channels-scene/setup.mjs record'
console.log(`
# ===== PowerShell NOVO =====
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|TETHER_)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:TETHER_HOME = '${home}'
$env:TETHER_PIPE = '${pipe}'
Set-Location '${WT}'
# tetherd em modo serve (nunca watch); registra o PID:
$d = Start-Process node -ArgumentList 'src/daemon/main.ts' -WorkingDirectory '${WT}' -WindowStyle Minimized -PassThru
${rec} daemon $d.Id
# o app VISIVEL: build de producao, depois o Electron; registra o PID:
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
${rec} daemon $!   # em Git Bash $! e o PID do MSYS; prefira 'setup.mjs up'
node app/build.mjs
'${electron.replaceAll('\\', '/')}' app/dist/main.cjs > "$TETHER_HOME/../app.log" 2>&1 &
`)
