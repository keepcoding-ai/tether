// The renderer's process store never holds a value of an environment variable: tetherd's direct replies (proc-list,
// proc-start, proc-info) mask by name only, so the store keeps the names and hides every value. `create` sends the recipe
// in the same proc-start the CLI sends, and nothing else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProcsStore } from '../../app/renderer/procs-store.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import type { Reply } from '../../src/daemon/protocol.ts'
import type { RequestBody } from '../../app/shared/api.ts'

const CANARY = 'canario-store-7d1e'
const state = (name: string): ProcState => ({
  name, status: 'running', run: 1,
  card: { v: 1, name, command: 'node', args: ['a.js'], cwd: 'C:/w', env: { MODO: CANARY, API_KEY: '•••' }, ports: [], stopGraceMs: 2000, info: {}, registeredBy: { kind: 'app' }, createdAt: '2026-11-26T00:00:00.000Z' },
})

test('proc-list, the proc event and proc-start replies: the names stay, the values go', async () => {
  const sent: RequestBody[] = []
  const store = new ProcsStore(async body => {
    sent.push(body)
    if (body.t === 'proc-list') return { t: 'ok', id: 1, procs: [state('a')] } as unknown as Reply
    if (body.t === 'proc-start') return { t: 'ok', id: 1, proc: state((body as { name: string }).name) } as unknown as Reply
    if (body.t === 'proc-info') {
      const events: ProcEvent[] = [{ v: 1, ts: 'x', kind: 'recipe-changed', before: { env: { MODO: CANARY } }, after: { env: { MODO: 'y' } } }]
      return { t: 'ok', id: 1, proc: state('a'), events } as unknown as Reply
    }
    return { t: 'ok', id: 1 } as unknown as Reply
  })
  await store.refresh(false)
  assert.deepEqual(Object.keys(store.get('a')!.card.env), ['MODO', 'API_KEY'])
  assert.ok(!JSON.stringify(store.list()).includes(CANARY))
  store.onEvent({ t: 'proc', proc: state('b') })
  assert.ok(!JSON.stringify(store.get('b')).includes(CANARY))

  const recipe = { command: 'node', args: ['a.js'], cwd: 'C:/w', env: { MODO: CANARY }, ports: [3000] }
  const reply = await store.create('c', recipe)
  assert.deepEqual(sent.at(-1), { t: 'proc-start', name: 'c', recipe }, 'the CLI\'s request, with the recipe')
  assert.ok(!JSON.stringify(reply).includes(CANARY), 'the reply comes back with names only')
  const info = await store.info('a')
  assert.ok(!JSON.stringify(info).includes(CANARY), 'info: the card and the history with names only')
})
