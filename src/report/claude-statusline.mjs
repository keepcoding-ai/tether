// Claude Code status line for every Claude launched by tether (injected via --settings).
// Claude pipes a JSON object on stdin; we print one line: model (strong alert when it is Fable), effort, cwd.
// Plain Node, no dependencies, never throws and never exits non-zero.

/** One status line from Claude's stdin payload (any value; garbage yields a line with placeholders). */
export function formatStatusLine(payload) {
  const j = payload && typeof payload === 'object' ? payload : {}
  const model = j.model && typeof j.model === 'object' ? j.model : {}
  const name = typeof model.display_name === 'string' && model.display_name ? model.display_name : (typeof model.id === 'string' && model.id) || '?'
  const probe = `${typeof model.id === 'string' ? model.id : ''} ${name}`
  const level = j.effort && typeof j.effort === 'object' && typeof j.effort.level === 'string' ? j.effort.level : ''
  const ws = j.workspace && typeof j.workspace === 'object' ? j.workspace : {}
  const dir = typeof ws.current_dir === 'string' ? ws.current_dir : ''
  let s
  if (/fable/i.test(probe)) s = `\x1b[1;97;41m  ⚠ FABLE ATIVO: ${name.toUpperCase()} ⚠  \x1b[0m`
  else if (/opus/i.test(probe)) s = `\x1b[1;92m${name}\x1b[0m`
  else s = `\x1b[1;93m${name}\x1b[0m`
  if (level) s += `  \x1b[37meffort: ${level}\x1b[0m`
  if (dir) s += `  \x1b[2m${dir}\x1b[0m`
  return s
}

function main() {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { data += c })
  process.stdin.on('error', () => {})
  process.stdin.on('end', () => {
    let payload
    try { payload = JSON.parse(data) } catch { payload = undefined }
    try { process.stdout.write(formatStatusLine(payload)) } catch { /* nothing to show */ }
  })
}

// Only run when executed directly, so tests can import formatStatusLine().
const entry = process.argv[1]
if (entry && /claude-statusline\.mjs$/i.test(entry)) main()
