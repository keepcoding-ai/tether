// What the ruler asks at every step of the scene: the visible desk and active tab (as far as the disk says), `agents list`,
// and the ownership objects of the desk `cena`. Reads files of the bench home; the only call out is the CLI, with the bench home and pipe.
//   node check.mjs [--slot <id>] [--before | --after]
// --before saves the snapshot; --after prints the same and says what changed against the saved one.
// `agents list` is the OWNER's view: pass --slot <slot id of the Atrium guide>, or run this from that guide's terminal.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CLI, OUT, readJson, readScene } from './lib.mjs'

const argv = process.argv.slice(2)
const mode = argv.includes('--before') ? 'before' : argv.includes('--after') ? 'after' : 'plain'
const slotAt = argv.indexOf('--slot')
const slot = slotAt >= 0 ? argv[slotAt + 1] : undefined
const scene = readScene()

const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TETHER_)/i.test(k)) env[k] = v
env.TETHER_HOME = scene.home
env.TETHER_PIPE = scene.pipe
// Inside the owner's own guide the slot and its key are what prove who is asking: keep them when they are there.
for (const k of ['TETHER_SLOT_ID', 'TETHER_SLOT_KEY']) if (process.env[k] && !slot) env[k] = process.env[k]

function list() {
  const r = spawnSync(process.execPath, [CLI, 'agents', 'list', '--json', ...(slot ? ['--slot', slot] : [])], { env, encoding: 'utf8', timeout: 30_000 })
  const text = (r.stdout || r.stderr || '').trim()
  try { return JSON.parse(text) } catch { return text }
}

const layout = readJson(join(scene.home, 'layout.json'))
const deskMap = readJson(join(scene.home, 'desks.json'))
const objects = readJson(join(scene.home, 'objects', 'for-agents.json'))
const cena = deskMap?.desks?.find(d => d.name === 'cena')
const active = layout?.desks?.find(d => d.id === layout.activeDesk)

const snap = {
  at: new Date().toISOString(),
  visible: layout ? { activeDesk: layout.activeDesk, name: active?.name, activeFrame: active?.activeFrame } : 'layout.json ainda nao gravado',
  cena: cena ?? 'mesa cena ainda nao existe em desks.json',
  agentsList: list(),
  ownership: !objects ? 'sem objects/for-agents.json' : {
    desk: cena ? objects.desk?.[cena.id] : undefined,
    panes: Object.fromEntries((cena?.panes ?? []).map(p => [p.id, objects.pane?.[p.id]])),
  },
}
const text = JSON.stringify(snap, null, 2)
console.log(text)

const file = join(OUT, 'check-before.json')
if (mode === 'before') { writeFileSync(file, text); console.log(`\nsalvo em ${file}`) }
if (mode === 'after') {
  if (!existsSync(file)) { console.log('\nsem --before salvo'); process.exit(0) }
  const was = JSON.parse(readFileSync(file, 'utf8'))
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  console.log(`\n== mesa visivel e guia ativa: ${same(was.visible, snap.visible) ? 'IGUAL ao antes' : `MUDOU\n antes:  ${JSON.stringify(was.visible)}\n depois: ${JSON.stringify(snap.visible)}`}`)
  console.log(`== posse (cena): ${same(was.ownership, snap.ownership) ? 'igual' : 'mudou (confira com o passo)'}`)
  console.log(`== agents list: ${same(was.agentsList, snap.agentsList) ? 'igual' : 'mudou'}`)
}
