// Prepares the bench of the for-agents scene (contract section 8, slice V2). Touches nothing of the real tether.
//   node setup.mjs                       creates the bench root (system temp, random suffix) and prints the start commands
//   node setup.mjs record <name> <pid>   registers a process the scene started, so teardown may end it
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tether-cena-')))
if (/^d:[\\/](atrium|agentes|kai)([\\/]|$)/i.test(root)) { console.error(`raiz de bancada em lugar proibido: ${root}`); process.exit(1) }
const home = join(root, 'home')
const dirs = { c1: join(root, 'c1'), ser: join(root, 'ser'), c3: join(root, 'c3') }
for (const d of [home, ...Object.values(dirs)]) mkdirSync(d, { recursive: true })
const suffix = basename(root).slice('tether-cena-'.length)
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-cena-${suffix}` : join(root, 'tetherd.sock')
const electron = createRequire(join(WT, 'package.json'))('electron')

writeScene({ createdAt: new Date().toISOString(), worktree: WT, root, home, pipe, cli: CLI, dirs, electron, pids: {} })

console.log(`bancada: ${root}\npipe:    ${pipe}\ncena:    ${SCENE}\n`)
console.log(`# 1) PowerShell NOVO. Tira CLAUDE* e TETHER_* herdados e fixa home e pipe da bancada:
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|TETHER_)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:TETHER_HOME = '${home}'
$env:TETHER_PIPE = '${pipe}'
Set-Location '${WT}'

# 2) tetherd em modo serve (nunca watch); registra o PID:
$d = Start-Process node -ArgumentList 'src/daemon/main.ts' -WorkingDirectory '${WT}' -WindowStyle Minimized -PassThru
node test/manual/for-agents-scene/setup.mjs record daemon $d.Id

# 3) o app VISIVEL (sem TETHER_E2E_HIDDEN): build de producao uma vez, depois o Electron; registra o PID:
node app/build.mjs
$a = Start-Process '${electron}' -ArgumentList 'app/dist/main.cjs' -WorkingDirectory '${WT}' -PassThru
node test/manual/for-agents-scene/setup.mjs record app $a.Id
`)
