// The browser extension's disk work on the launch path (E3.6c): a daemon with a WORKER executor whose io lane is slow
// (an injected delay per operation) launches an agent with the browser served. What must hold:
//   - the event loop never stops for 100 ms or more while the launch runs (the key, the MCP file and the probes go through
//     `api.io`, on the worker; the owner-only check of the folders runs as child processes, off the loop);
//   - the key and the MCP file are on disk when the agent is born: the launch middleware's writes are awaited before the spawn.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { AgentRegistry } from '../../src/agents/registry.ts'
import type { AgentAdapter } from '../../src/agents/types.ts'
import { ProfileStore } from '../../src/core/profile.ts'
import { UserSettings } from '../../src/core/user-settings.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { createExecutor } from '../../src/exec/executor.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

describe('browser launch on a slow io lane', () => {
  const homes: string[] = []
  after(async () => { for (const h of homes) await removeHome(h) })

  test('the loop never stops for 100 ms and the key and the MCP file are on disk before the agent is born', async () => {
    const home = tempHome()
    homes.push(home)
    const cwd = join(home, 'work')
    mkdirSync(cwd)
    // Serve the browser to every agent (the default is per profile).
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { serveToAgents: 'all' } } }))
    const executor = createExecutor({ mode: 'worker', ioDelayMs: 200 })
    const logs: string[] = []
    // The sampler watches the launch middlewares (where the extension's disk work runs). The daemon's own pre-spawn work and the
    // pty spawn block the loop for ~100 ms with or without the browser (the system slice, E3.7): not this test's subject.
    let sampling = false
    const log = (m: string): void => { logs.push(m) }
    const registry = new AgentRegistry()
    const profileStore = new ProfileStore(home, executor, log)
    const userSettings = new UserSettings(home, executor, process.env, log)
    await userSettings.fresh()
    const host = new DaemonExtensionHost({
      home, log, agents: registry, executor, profileStore, settings: userSettings,
      extensions: daemonIndex.filter(e => e.manifest.id === 'claude' || e.manifest.id === 'browser'),
    })
    host.activate()
    assert.ok(host.activated.includes('browser'), `browser activated (failed: ${JSON.stringify(host.failed)})`)
    // The agent checks the files named by --mcp-config (and the key beside it) first thing, then stays up.
    const probe = join(home, 'probe.cjs')
    writeFileSync(probe, [
      'const a=process.argv;const f=a[a.indexOf("--mcp-config")+1];const fs=require("fs"),p=require("path");',
      'const slot=p.basename(f,".json");const key=p.join(p.dirname(f),"..","keys",slot+".key");',
      'process.stdout.write(fs.existsSync(f)&&fs.existsSync(key)?"BROWSER-ON-DISK\\n":"BROWSER-MISSING "+f+"\\n");setInterval(()=>{},1000)',
    ].join('\n'))
    const fakeClaude: AgentAdapter = {
      name: 'claude',
      plan: (input) => ({ command: process.execPath, args: [probe], cwd: input.slot.cwd, env: inheritedEnv() }),
      sessionExists: async () => 'unknown',
      title: async (b) => b.title,
    }
    const daemon: Daemon = await startDaemon({
      home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0, memoryIntervalMs: 0, log,
      executor, profileStore, userSettings, adapters: { claude: fakeClaude }, transformPlan: async (plan, meta, state) => { sampling = true; last = performance.now(); try { return await host.transformPlan(plan, meta, state) } finally { sampling = false } }, onSlot: host.emitSlot,
    })
    const rec = await Recorder.connect(daemon.pipe)
    // Loop-lag sampler: the longest gap between two ticks of a 5 ms timer while the launch runs, while the middlewares run.
    let last = performance.now()
    let worst = 0
    const sampler = setInterval(() => { const t = performance.now(); if (sampling) worst = Math.max(worst, t - last - 5); last = t }, 5)
    try {
      last = performance.now()
      const { slot } = await rec.client.request({ t: 'create', kind: 'claude', cwd, start: true })
      const id = slot!.slotId
      const attached = await rec.client.request({ t: 'attach', slotId: id, cols: 200, rows: 30 })
      const seen = (): string => (attached.scrollback ?? '') + rec.text(id)
      let m: RegExpExecArray | null = null
      await waitUntil(() => (m = /BROWSER-ON-DISK|BROWSER-MISSING[^\r\n]*/.exec(seen())) !== null, 60_000, 'the agent\'s report').catch((e: Error) => {
        throw new Error(`${e.message}; log: ${logs.slice(-12).join(' | ')}; output: ${seen().slice(-500)}`)
      })
      assert.equal(m![0], 'BROWSER-ON-DISK', `the agent saw: ${m![0]}; log: ${logs.slice(-12).join(' | ')}`)
      assert.ok(worst < 100, `the loop stopped for ${Math.round(worst)} ms while the browser launched`)
    } finally {
      clearInterval(sampler)
      rec.close()
      await daemon.close()
      host.dispose()
      await executor.close()
    }
  })
})
