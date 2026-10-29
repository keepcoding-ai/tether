// Fake tetherd: implements src/daemon/protocol.ts over the same pipe so the app can be developed and
// tested before the real daemon exists. Slots live in memory only. No PTY: every slot is a fake terminal
// that prints a banner, echoes what is typed and shows a prompt. Run: node app/fake-daemon/fake-daemon.ts
// (TETHER_PIPE must be set, or the default pipe of protocol.ts is used).
import { createServer, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { randomBytes } from 'node:crypto'
import { pipePath, PROTOCOL_VERSION, type ClientMessage, type DaemonMessage, type ErrorCode, type Request, type SlotState } from '../../src/daemon/protocol.ts'

const SCROLLBACK_LIMIT = 200_000

interface FakeSlot {
  state: SlotState
  scrollback: string
  line: string
  attached: Set<Socket>
}

const slots = new Map<string, FakeSlot>()
const clients = new Set<Socket>()
let nextPid = 40_000

function send(sock: Socket, msg: DaemonMessage): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n')
}

function broadcast(msg: DaemonMessage): void {
  for (const c of clients) send(c, msg)
}

function emitState(slot: FakeSlot): void {
  broadcast({ t: 'state', slot: { ...slot.state } })
}

/** Output of the fake process: stored in the ring buffer and streamed to attached clients. */
function output(slot: FakeSlot, data: string): void {
  slot.scrollback = (slot.scrollback + data).slice(-SCROLLBACK_LIMIT)
  for (const c of slot.attached) send(c, { t: 'data', slotId: slot.state.slotId, data })
}

function prompt(slot: FakeSlot): string {
  switch (slot.state.kind) {
    case 'shell': return `\x1b[32mPS ${slot.state.cwd}>\x1b[0m `
    default: return '\x1b[36m>\x1b[0m '
  }
}

function banner(slot: FakeSlot): string {
  const cwd = slot.state.cwd
  switch (slot.state.kind) {
    case 'claude': return `\x1b[1;35m✦ Claude Code (falso)\x1b[0m  pasta: ${cwd}\r\nDigite algo e Enter; a primeira linha vira o título da sessão.\r\n\r\n`
    case 'soul': return `\x1b[1;34m☽ soul (falso)\x1b[0m  pasta: ${cwd}\r\nDigite algo e Enter; a primeira linha vira o título da sessão.\r\n\r\n`
    case 'shell': return `\x1b[1mShell (falso)\x1b[0m  pasta: ${cwd}\r\n"exit" encerra.\r\n\r\n`
  }
}

function start(slot: FakeSlot): void {
  if (slot.state.status === 'running') return
  slot.state.status = 'running'
  slot.state.pid = nextPid++
  delete slot.state.error
  output(slot, banner(slot) + prompt(slot))
  emitState(slot)
}

function stop(slot: FakeSlot): void {
  if (slot.state.status !== 'running') return
  slot.state.status = 'exited'
  delete slot.state.pid
  output(slot, '\r\n\x1b[90m[processo encerrado]\x1b[0m\r\n')
  emitState(slot)
}

function handleInput(slot: FakeSlot, data: string): void {
  if (slot.state.status !== 'running') return
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      output(slot, '\r\n')
      const line = slot.line
      slot.line = ''
      runLine(slot, line)
    } else if (ch === '\x7f' || ch === '\b') {
      if (slot.line.length) {
        slot.line = slot.line.slice(0, -1)
        output(slot, '\b \b')
      }
    } else if (ch === '\x03') {
      slot.line = ''
      output(slot, '^C\r\n' + prompt(slot))
    } else if (ch >= ' ') {
      slot.line += ch
      output(slot, ch)
    }
  }
}

function runLine(slot: FakeSlot, line: string): void {
  if (line.trim() === 'exit') { stop(slot); return }
  if (line.trim()) output(slot, `echo: ${line}\r\n`)
  if (slot.state.kind !== 'shell' && !slot.state.title && line.trim()) {
    slot.state.title = line.trim().slice(0, 40)
    emitState(slot)
  }
  output(slot, prompt(slot))
}

function fail(sock: Socket, id: number, code: ErrorCode, message: string): void {
  send(sock, { t: 'error', id, code, message })
}

function handleRequest(sock: Socket, req: Request): void {
  const id = req.id
  const need = (slotId: string): FakeSlot | undefined => {
    const s = slots.get(slotId)
    if (!s) fail(sock, id, 'unknown-slot', `slot desconhecido: ${slotId}`)
    return s
  }
  switch (req.t) {
    case 'hello':
      send(sock, { t: 'ok', id, hello: { v: PROTOCOL_VERSION, pid: process.pid, version: 'fake' } })
      return
    case 'list':
      send(sock, { t: 'ok', id, slots: [...slots.values()].map(s => ({ ...s.state })) })
      return
    case 'create': {
      if (!existsSync(req.cwd)) { fail(sock, id, 'cwd-missing', `pasta não existe: ${req.cwd}`); return }
      const slotId = randomBytes(4).toString('hex')
      const slot: FakeSlot = {
        state: { slotId, kind: req.kind, cwd: req.cwd, status: 'exited', ...(req.name ? { name: req.name } : {}) },
        scrollback: '', line: '', attached: new Set(),
      }
      slots.set(slotId, slot)
      if (req.start) start(slot)
      emitState(slot)
      send(sock, { t: 'ok', id, slot: { ...slot.state } })
      return
    }
    case 'start': {
      const s = need(req.slotId); if (!s) return
      start(s)
      send(sock, { t: 'ok', id, slot: { ...s.state } })
      return
    }
    case 'attach': {
      const s = need(req.slotId); if (!s) return
      s.attached.add(sock)
      send(sock, { t: 'ok', id, slot: { ...s.state }, scrollback: s.scrollback })
      return
    }
    case 'detach': {
      const s = need(req.slotId); if (!s) return
      s.attached.delete(sock)
      send(sock, { t: 'ok', id })
      return
    }
    case 'resize': {
      const s = need(req.slotId); if (!s) return
      send(sock, { t: 'ok', id })
      return
    }
    case 'stop': {
      const s = need(req.slotId); if (!s) return
      stop(s)
      send(sock, { t: 'ok', id, slot: { ...s.state } })
      return
    }
    case 'forget': {
      const s = need(req.slotId); if (!s) return
      stop(s)
      slots.delete(req.slotId)
      send(sock, { t: 'ok', id })
      broadcast({ t: 'removed', slotId: req.slotId })
      return
    }
    case 'rename-slot': {
      const s = need(req.slotId); if (!s) return
      s.state.name = req.name
      emitState(s)
      send(sock, { t: 'ok', id, slot: { ...s.state } })
      return
    }
    case 'shutdown':
      send(sock, { t: 'ok', id })
      setTimeout(() => process.exit(0), 50)
      return
    default:
      fail(sock, id, 'bad-request', `mensagem desconhecida: ${(req as { t: string }).t}`)
  }
}

function handleMessage(sock: Socket, msg: ClientMessage): void {
  if (msg.t === 'input') {
    const s = slots.get(msg.slotId)
    if (s) handleInput(s, msg.data)
    return
  }
  handleRequest(sock, msg)
}

const pipe = pipePath(homedir(), userInfo().username)
const server = createServer(sock => {
  clients.add(sock)
  let buffer = ''
  sock.setEncoding('utf8')
  sock.on('data', chunk => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      try { handleMessage(sock, JSON.parse(line) as ClientMessage) } catch { /* malformed line: ignored */ }
    }
  })
  const gone = (): void => {
    clients.delete(sock)
    for (const s of slots.values()) s.attached.delete(sock)
  }
  sock.on('close', gone)
  sock.on('error', gone)
})

server.listen(pipe, () => {
  console.log(`tetherd falso ouvindo em ${pipe} (pid ${process.pid})`)
})
