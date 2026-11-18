// Child of daemon.store-writes.test.ts (C4): a daemon with the worker executor, N slots, then rename loops without end until the
// parent kills this process. Each reply means the name is on disk (the rename barrier): it prints `ack <id> <round>`, so the
// parent knows which writes were promised before the kill.
import { DaemonClient } from '../../src/daemon/client.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createExecutor } from '../../src/exec/executor.ts'

const [home, pipe, n] = process.argv.slice(2)
const executor = createExecutor({ mode: 'worker' })
await startDaemon({ home: home!, pipe: pipe!, executor, memoryIntervalMs: 0 })
const client = await DaemonClient.open(pipe!, 'test')
const ids: string[] = []
for (let i = 0; i < Number(n); i++) ids.push((await client.request({ t: 'create', kind: 'shell', cwd: home!, name: 'r-0' })).slot!.slotId)
process.stdout.write(`ready ${JSON.stringify(ids)}\n`)
// One rename loop per slot, the next sent as soon as the previous is acknowledged: the io lane always holds a queue (one write
// per slot), and no path is rewritten faster than it drains (a barrier waits for its path to go idle).
let started = 0
const loop = (id: string, r: number): void => {
  client.request({ t: 'rename-slot', slotId: id, name: `r-${r}` }).then(() => {
    process.stdout.write(`ack ${id} ${r}\n`)
    if (r === 3 && ++started === ids.length) process.stdout.write('burst\n')
    loop(id, r + 1)
  }, (e: Error) => process.stderr.write(`rejected: ${e.message}\n`))
}
for (const id of ids) loop(id, 1)
