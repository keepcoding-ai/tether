// Shared by setup/check/teardown: where the scene file lives and how to read it. No state of its own.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const WT = resolve(import.meta.dirname, '..', '..', '..')
export const CLI = join(WT, 'bin', 'tether.mjs')
export const OUT = 'D:/atrium/.tmp/tether-agents/onda-2/cena'
export const SCENE = join(OUT, 'scene.json')

export function readScene() {
  if (!existsSync(SCENE)) { console.error(`sem ${SCENE}: rode setup.mjs antes`); process.exit(2) }
  return JSON.parse(readFileSync(SCENE, 'utf8'))
}

export function writeScene(scene) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(SCENE, JSON.stringify(scene, null, 2))
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}
