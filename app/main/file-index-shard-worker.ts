// One scoring shard of Quick Open (built into app/dist/file-index-shard-worker.cjs); see app/main/file-index-shard.ts.
import { parentPort, workerData } from 'node:worker_threads'
import { Shard, type ShardReply, type ShardRequest } from './file-index-shard.ts'

const latest = new Int32Array((workerData as { latest: SharedArrayBuffer }).latest)
const sessions = new Map<number, Shard>()

parentPort?.on('message', (msg: ShardRequest) => {
  if (msg.op === 'load') { sessions.set(msg.sid, new Shard(msg.rels)); return }
  if (msg.op === 'drop') { sessions.delete(msg.sid); return }
  const shard = sessions.get(msg.sid)
  // A newer keystroke is already waiting (or the session is gone): the answer would be thrown away.
  if (!shard || Atomics.load(latest, 0) !== msg.seq) { parentPort!.postMessage({ job: msg.job, stale: true } satisfies ShardReply); return }
  parentPort!.postMessage({ job: msg.job, rels: shard.top(msg.query, msg.max).rels } satisfies ShardReply)
})
