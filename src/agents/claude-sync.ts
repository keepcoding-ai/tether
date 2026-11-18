// Claude's transcript lookups, synchronous: the twins of findTranscriptAsync and lastCustomTitleAsync (claude.ts) for the tests
// and tools. tetherd's coordinator never imports this file.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Binding } from '../core/event.ts'
import { CHUNK, claudeConfigDir, encodeProjectDir, titleOf } from './claude.ts'
import type { LookupOptions } from './types.ts'

/** Path of the session's transcript, or undefined when it is not on disk. */
export function findTranscript(binding: Pick<Binding, 'sessionId' | 'cwd'>, opts?: LookupOptions): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(binding.sessionId)) return undefined
  const projects = join(claudeConfigDir(opts), 'projects')
  const file = `${binding.sessionId}.jsonl`
  const direct = join(projects, encodeProjectDir(binding.cwd), file)
  if (existsSync(direct)) return direct
  let dirs: string[]
  try { dirs = readdirSync(projects) } catch { return undefined }
  for (const d of dirs) {
    const candidate = join(projects, d, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The last {"type":"custom-title"} line of a transcript, read backwards in chunks (transcripts can be MBs). */
export function lastCustomTitle(file: string): string | undefined {
  const fd = openSync(file, 'r')
  try {
    let end = fstatSync(fd).size
    let carry = Buffer.alloc(0) // bytes of the (still incomplete) first line of the chunk above
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      readSync(fd, chunk, 0, chunk.length, start)
      let data = Buffer.concat([chunk, carry])
      if (start > 0) {
        const nl = data.indexOf(0x0a)
        if (nl === -1) { carry = data; end = start; continue }
        carry = data.subarray(0, nl)
        data = data.subarray(nl + 1)
      }
      const lines = data.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = titleOf(lines[i]!.trimEnd())
        if (t !== undefined) return t
      }
      end = start
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}
