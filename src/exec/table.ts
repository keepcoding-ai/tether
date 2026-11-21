// The closed table: operation name -> implementation. Merges every ops-*.ts. Only workers and the inline fallback
// load it (never the coordinator graph, see test/unit/arch.sync-ratchet.test.ts); a new ops file is added here.
// ops-fs is light and loaded eagerly; ops-agents / ops-ext / ops-os pull heavy graphs, so each of their operations is a stub
// that imports its module on the first call (a respawned worker stays fast). The name lists are checked against OpName by tsc
// and test/unit/exec.table.test.ts checks them against what the modules really export.
import type { OpName, OpArgs, OpValue } from './protocol.ts'
import { fsOps } from './ops-fs.ts'

export type OpTable = { [K in OpName]: (...args: OpArgs<K>) => OpValue<K> | Promise<OpValue<K>> }

type Loader = () => Promise<Record<string, (...a: never[]) => unknown>>
const loaders = {
  agents: (() => import('./ops-agents.ts').then((m) => m.agentOps)) as unknown as Loader,
  ext: (() => import('./ops-ext.ts').then((m) => m.extOps)) as unknown as Loader,
  os: (() => import('./ops-os.ts').then((m) => m.osOps)) as unknown as Loader,
  hands: (() => import('./ops-hands.ts').then((m) => m.handsOps)) as unknown as Loader,
}

/** The operations each lazy module exports (exec.table.test.ts checks the lists against the modules). */
export const lazyNames = {
  agents: ['resolveClaude', 'resolveCodex', 'ensureSettingsFile', 'hasStatusLine', 'userNotify', 'resolveShell', 'resolveSoul', 'soulLaunch', 'renamedNode', 'loadSkills', 'materializeSkills'],
  ext: ['writeTextAtomicDir'],
  hands: ['resolveHands', 'handsLaunch'],
  os: ['killTree', 'sampleProcessTable', 'listListeners', 'startTime', 'startTimeInfo', 'stopStartTimeHelper', 'ensurePrivateDir', 'procPlan', 'identifyProcess', 'listeningOwner'],
} as const

const lazy: Record<string, (...a: unknown[]) => Promise<unknown>> = {}
for (const [group, names] of Object.entries(lazyNames) as [keyof typeof lazyNames, readonly string[]][]) {
  for (const name of names) {
    lazy[name] = async (...a) => {
      const ops = await loaders[group]()
      return (ops[name] as (...x: unknown[]) => unknown)(...a)
    }
  }
}

export const table = { ...fsOps, ...lazy } as unknown as OpTable
