// Shared by setup/check/teardown of the channels scene (contract section 8, slice S1): where the scene file lives and how
// to read it. The process helpers come from the for-agents scene, unchanged.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, WT, listProcs, norm, readJson, selfChain } from '../for-agents-scene/lib.mjs'

export { CLI, WT, listProcs, norm, readJson, selfChain }

/** Everything the scene keeps of its own (home, logs, evidence) lives under here, inside .tmp. */
export const OUT = 'D:/atrium/.tmp/tether-agents/onda-3/cena'
export const SCENE = join(OUT, 'scene.json')
/** The names the scene gives to the three guides A opens (step 2). */
export const GUIDE_NAMES = { claude: 'claude · conferente', soul: 'soul · bancada', codex: 'codex · conferência' }
/** The desk A receives (step 1). Its channel is named after the desk (decision C14: no `mesa-` prefix). */
export const DESK_NAME = 'cena'

export function readScene() {
  if (!existsSync(SCENE)) { console.error(`sem ${SCENE}: rode setup.mjs antes`); process.exit(2) }
  return JSON.parse(readFileSync(SCENE, 'utf8'))
}

export function writeScene(scene) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(SCENE, JSON.stringify(scene, null, 2))
}
