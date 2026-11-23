// Shared by setup/check/teardown: where the scene file lives and how to read it. No state of its own.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const WT = resolve(import.meta.dirname, '..', '..', '..')
export const CLI = join(WT, 'bin', 'tether.mjs')
export const OUT = 'C:/atrium/.tmp/tether-agents/onda-2/cena'
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

// Process table with command lines (Windows: CIM through PowerShell; elsewhere: ps). Filtering happens in JS so no
// bench path ever appears on a command line of ours.
export function listProcs() {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    return (r.stdout ?? '').split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), name: (m[3].split(' ')[0].split('/').pop()) ?? '', cmd: m[3] }))
  }
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  try {
    const rows = JSON.parse(r.stdout)
    return (Array.isArray(rows) ? rows : [rows]).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name ?? '', cmd: p.CommandLine ?? '' }))
  } catch { return [] }
}

// The calling process and its parents: never a target.
export function selfChain(procs) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const chain = new Set([process.pid])
  for (let p = byPid.get(process.pid); p && !chain.has(p.ppid); p = byPid.get(p.ppid)) chain.add(p.ppid)
  return chain
}

export const norm = s => s.toLowerCase().replaceAll('\\', '/')
