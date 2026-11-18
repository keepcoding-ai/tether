// Parser for the markdown that `claude -p "/context"` prints. Pure and tolerant: unknown sections, rows and
// columns are preserved (never thrown on), so a newer Claude that adds a section keeps working.

export interface ContextCategory {
  name: string
  tokens: number
  /** Percent of the window as printed (0.3 for "0.3%"); undefined when the cell is not a percentage. */
  percent: number | undefined
  approx: boolean
}

export interface ContextItem {
  name: string
  /** Server (MCP tools) or source (agents, skills) or type (memory files). */
  source: string
  /** Memory files only: the file path. */
  path?: string
  tokens: number
  /** True for "~170" and "< 20": the report itself is not exact. */
  approx: boolean
}

export interface UnknownSection {
  title: string
  rows: string[][]
  lines: string[]
}

export interface ContextReport {
  model: string | undefined
  totalTokens: number | undefined
  maxTokens: number | undefined
  percent: number | undefined
  categories: ContextCategory[]
  mcpTools: ContextItem[]
  agents: ContextItem[]
  memoryFiles: ContextItem[]
  skills: ContextItem[]
  unknownSections: UnknownSection[]
}

export interface ParsedTokens {
  tokens: number
  approx: boolean
}

/** "2.7k" -> 2700, "1m" -> 1_000_000, "~170" -> 170 approx, "< 20" -> 20 approx, "1,234" -> 1234. Undefined when not a count. */
export function parseTokenCount(raw: string): ParsedTokens | undefined {
  let s = raw.trim().toLowerCase().replace(/,/g, '')
  let approx = false
  const prefix = /^(~|<|≈|about)\s*/.exec(s)
  if (prefix) {
    approx = true
    s = s.slice(prefix[0].length)
  }
  const m = /^(\d+(?:\.\d+)?)\s*([kmb])?(?:\s*tokens?)?$/.exec(s)
  if (!m) return undefined
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1
  return { tokens: Math.round(Number(m[1]) * mult), approx }
}

function parsePercent(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const m = /^~?\s*(\d+(?:\.\d+)?)\s*%$/.exec(raw.trim())
  return m ? Number(m[1]) : undefined
}

function splitRow(line: string): string[] | undefined {
  const t = line.trim()
  if (!t.startsWith('|')) return undefined
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  return cells
}

const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c))

interface Section {
  title: string
  lines: string[]
}

function splitSections(markdown: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = []
  const sections: Section[] = []
  let current: Section | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{2,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      current = { title: h[1] ?? '', lines: [] }
      sections.push(current)
    } else if (current) current.lines.push(line)
    else preamble.push(line)
  }
  return { preamble, sections }
}

/** Header + data rows of the first table in the lines; rows with the wrong shape are skipped. */
function readTable(lines: string[]): { header: string[]; rows: string[][]; stray: string[] } {
  let header: string[] | undefined
  const rows: string[][] = []
  const stray: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const cells = splitRow(line)
    if (!cells) {
      stray.push(line.trim())
      continue
    }
    if (isSeparator(cells)) continue
    if (!header) header = cells.map((c) => c.toLowerCase())
    else rows.push(cells)
  }
  return { header: header ?? [], rows, stray }
}

function column(header: string[], ...names: string[]): number {
  return header.findIndex((h) => names.includes(h))
}

function readItems(lines: string[], kind: 'mcp' | 'agent' | 'memory' | 'skill'): { items: ContextItem[]; ok: boolean } {
  const { header, rows } = readTable(lines)
  const tokensCol = column(header, 'tokens')
  const nameCol = column(header, kind === 'mcp' ? 'tool' : kind === 'agent' ? 'agent type' : kind === 'skill' ? 'skill' : 'type')
  const sourceCol = column(header, 'server', 'source', 'type')
  const pathCol = column(header, 'path')
  if (tokensCol < 0 || nameCol < 0) return { items: [], ok: false }
  const items: ContextItem[] = []
  for (const r of rows) {
    const t = parseTokenCount(r[tokensCol] ?? '')
    if (!t) continue
    const item: ContextItem = {
      name: kind === 'memory' && pathCol >= 0 ? (r[pathCol] ?? '') : (r[nameCol] ?? ''),
      source: sourceCol >= 0 ? (r[sourceCol] ?? '') : '',
      tokens: t.tokens,
      approx: t.approx,
    }
    if (kind === 'memory' && pathCol >= 0) {
      item.source = r[nameCol] ?? ''
      item.path = r[pathCol] ?? ''
    }
    items.push(item)
  }
  return { items, ok: true }
}

export function parseContextReport(markdown: string): ContextReport {
  const report: ContextReport = {
    model: undefined, totalTokens: undefined, maxTokens: undefined, percent: undefined,
    categories: [], mcpTools: [], agents: [], memoryFiles: [], skills: [], unknownSections: [],
  }
  const all = String(markdown ?? '')
  const { sections } = splitSections(all)
  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(all)
  if (model) report.model = model[1]?.trim()
  const tokens = /\*\*Tokens:\*\*\s*(~?[\d.,]+\s*[kmb]?)\s*\/\s*(~?[\d.,]+\s*[kmb]?)(?:\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\))?/im.exec(all)
  if (tokens) {
    report.totalTokens = parseTokenCount(tokens[1] ?? '')?.tokens
    report.maxTokens = parseTokenCount(tokens[2] ?? '')?.tokens
    if (tokens[3] !== undefined) report.percent = Number(tokens[3])
  }

  for (const s of sections) {
    const title = s.title.toLowerCase().replace(/\s+/g, ' ').trim()
    if (title === 'context usage') continue
    if (title === 'estimated usage by category') {
      const { header, rows } = readTable(s.lines)
      const nameCol = column(header, 'category')
      const tokCol = column(header, 'tokens')
      const pctCol = column(header, 'percentage', 'percent')
      if (nameCol < 0 || tokCol < 0) {
        report.unknownSections.push(toUnknown(s))
        continue
      }
      for (const r of rows) {
        const t = parseTokenCount(r[tokCol] ?? '')
        if (!t) continue
        report.categories.push({ name: r[nameCol] ?? '', tokens: t.tokens, percent: parsePercent(r[pctCol]), approx: t.approx })
      }
      continue
    }
    const kind = title === 'mcp tools' ? 'mcp' : title === 'custom agents' ? 'agent' : title === 'memory files' ? 'memory' : title === 'skills' ? 'skill' : undefined
    if (kind) {
      const { items, ok } = readItems(s.lines, kind)
      if (!ok) {
        report.unknownSections.push(toUnknown(s))
        continue
      }
      if (kind === 'mcp') report.mcpTools.push(...items)
      else if (kind === 'agent') report.agents.push(...items)
      else if (kind === 'memory') report.memoryFiles.push(...items)
      else report.skills.push(...items)
      continue
    }
    report.unknownSections.push(toUnknown(s))
  }
  return report
}

function toUnknown(s: Section): UnknownSection {
  const { rows, stray } = readTable(s.lines)
  return { title: s.title, rows, lines: stray }
}
