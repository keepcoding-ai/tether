// Preload of a surface's input shield (app/main/surfaces.ts): the transparent view over a surface takes the person's mouse,
// wheel and keys, keeps them from doing anything, and tells main where they were (coordinates in the shield's own space; main
// adds the shield's position). Built as CommonJS (app/dist/surface-shield.cjs): the shield runs sandboxed, with nothing exposed.
import { ipcRenderer } from 'electron'

const CHANNEL = 'surface:shield'
const MOVE_EVERY_MS = 50
let lastMove = 0

const send = (input: Record<string, unknown>): void => { ipcRenderer.send(CHANNEL, input) }

window.addEventListener('mousedown', e => { e.preventDefault(); send({ kind: 'down', x: e.clientX, y: e.clientY, button: e.button }) }, true)
window.addEventListener('mousemove', e => {
  const now = Date.now()
  if (now - lastMove < MOVE_EVERY_MS) return
  lastMove = now
  send({ kind: 'move', x: e.clientX, y: e.clientY })
}, true)
window.addEventListener('wheel', e => { e.preventDefault(); send({ kind: 'wheel', x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY }) }, { capture: true, passive: false })
window.addEventListener('keydown', e => { e.preventDefault(); send({ kind: 'key', x: 0, y: 0, key: e.key, code: e.code }) }, true)
window.addEventListener('contextmenu', e => { e.preventDefault() }, true)
window.addEventListener('dragover', e => { e.preventDefault() }, true)
window.addEventListener('drop', e => { e.preventDefault() }, true)
