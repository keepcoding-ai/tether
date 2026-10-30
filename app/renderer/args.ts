// The one-line argument field of the profile form: text ⇄ argv. Splits on whitespace, honours double and
// single quotes (so `--add-dir "C:\Meus Projetos"` is one arg), and `\"` inside double quotes; any other
// backslash is literal (Windows paths). Pure, so the unit tests cover it (test/unit/app.args.test.ts).

/** Text → argv. Unbalanced quotes run to the end of the text (the user is still typing). */
export function parseArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let inArg = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) { quote = undefined; continue }
      if (quote === '"' && ch === '\\' && text[i + 1] === '"') { cur += '"'; i++; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; inArg = true; continue }
    if (/\s/.test(ch)) {
      if (inArg) { out.push(cur); cur = ''; inArg = false }
      continue
    }
    cur += ch
    inArg = true
  }
  if (inArg) out.push(cur)
  return out
}

/** argv → text that parseArgs reads back: an arg with spaces, quotes or nothing in it is double-quoted. */
export function formatArgs(args: string[]): string {
  return args.map(a => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}
