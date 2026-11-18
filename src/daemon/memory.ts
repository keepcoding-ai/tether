// Memory per slot: the working set of each slot's whole process tree (agent / shell and every descendant).
//
// One process-table snapshot answers for ALL slots (a single command per sample, never a spawn per slot). On Windows it
// is one `Get-CimInstance Win32_Process` through PowerShell (Node has no parent-pid API), on POSIX one `ps`. The command
// runs on the executor's worker (src/exec/ops-os.ts), so neither the process creation nor the wait touches the daemon loop;
// about 0.9 s wall and CPU per sample on Windows, see MEMORY_INTERVAL_MS.
import { agentExecutor } from '../agents/agent-exec.ts'

export interface ProcRow {
  pid: number
  ppid: number
  /** Working set (resident memory) in bytes. */
  bytes: number
  /** The executable's name (who listens on a port outside tether), when the sample has it. */
  name?: string
}

/**
 * Parses the sample's output: one process per line, `pid,ppid,bytes[,name]` (whitespace separators work too).
 * `unit` multiplies the third column to bytes (POSIX `ps` reports KiB). Malformed lines are skipped.
 */
export function parseProcessTable(text: string, unit = 1): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+(.*?))?\s*$/.exec(line)
    if (!m) continue
    const row: ProcRow = { pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * unit }
    if (m[4]) row.name = m[4]
    rows.push(row)
  }
  return rows
}

/**
 * Bytes of each root's tree (the root plus every descendant, found through the parent pids). Each tree is summed
 * independently. A root missing from the table is absent from the result. Cycles (reused pids) are harmless.
 */
export function treeBytes(rows: ProcRow[], roots: number[]): Map<number, number> {
  const byPid = new Map<number, ProcRow>()
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    if (r.ppid === r.pid) continue
    const list = kids.get(r.ppid)
    if (list) list.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  const out = new Map<number, number>()
  for (const root of roots) {
    if (!byPid.has(root)) continue
    let sum = 0
    const seen = new Set<number>()
    const stack = [root]
    while (stack.length) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      sum += byPid.get(pid)?.bytes ?? 0
      for (const k of kids.get(pid) ?? []) stack.push(k)
    }
    out.set(root, sum)
  }
  return out
}

/** One snapshot of the machine's process table, taken on the executor. Rejects when the command fails or times out. */
export function sampleProcessTable(): Promise<ProcRow[]> {
  return agentExecutor().run('sampleProcessTable', [])
}

/** Should a new reading be broadcast? Only when it moved by more than 5 % or 20 MB (the first reading always). */
export function memoryChanged(prevMB: number | undefined, nextMB: number): boolean {
  if (prevMB === undefined) return true
  const d = Math.abs(nextMB - prevMB)
  return d > 20 || d > prevMB * 0.05
}
