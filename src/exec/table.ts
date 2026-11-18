// The closed table: operation name -> implementation. Merges every ops-*.ts. Only workers and the inline fallback
// load it (never the coordinator graph, see test/unit/arch.sync-ratchet.test.ts); a new ops file is added here.
import type { OpName, OpArgs, OpValue } from './protocol.ts'
import { fsOps } from './ops-fs.ts'

export type OpTable = { [K in OpName]: (...args: OpArgs<K>) => OpValue<K> }

export const table: OpTable = { ...fsOps }
