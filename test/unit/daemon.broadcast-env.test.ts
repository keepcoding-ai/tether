// A-1, third layer: a value of an environment variable never goes out in a broadcast. Profiles and process cards reach
// every identified client with the NAMES of their variables only; the value stays in tetherd, which launches with it, and
// in the reply to whoever asks for the profiles by name (the profile editor). Played against a bench tetherd with a canary
// value under a name that does not look secret (the old mask went by the name): every byte an identified client receives
// is searched for it.
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { encode } from '../../src/daemon/ndjson.ts'
import { clientProof, newNonce, readPipeKey } from '../../src/daemon/pipe-key.ts'
import { ENV_VALUE_HIDDEN } from '../../src/daemon/env-names.ts'
import type { ProcState, Profile } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { hostStore } from '../../src/procd/run-store.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const CANARY = 'canario-env-a1-52c0d1'

/** An identified connection that keeps every raw byte it receives (the handshake done by hand, as pipe-key.ts says). */
async function listener(pipe: string, home: string): Promise<{ socket: Socket; bytes: () => string }> {
  const socket = connect(pipe)
  await new Promise<void>((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
  socket.setEncoding('utf8')
  let got = ''
  socket.on('data', (c: string) => { got += c })
  socket.on('error', () => {})
  const nonce = newNonce()
  socket.write(encode({ t: 'auth', id: 0, nonce }))
  await waitUntil(() => got.includes('"auth"'), 5_000, 'auth reply')
  const auth = (JSON.parse(got.split('\n')[0]!) as { auth: { nonce: string } }).auth
  socket.write(encode({ t: 'hello', id: 1, v: 2, client: 'test', proof: clientProof((await readPipeKey(home))!, nonce, auth.nonce) }))
  await waitUntil(() => got.split('\n').filter(Boolean).length >= 2, 5_000, 'hello reply')
  return { socket, bytes: () => got }
}

describe('broadcasts carry the names of environment variables, never their values', () => {
  const home = tempHome()
  const hostPipe = uniquePipe(home)
  let host: ProcHost
  let daemon: Daemon
  let rec: Recorder
  const heard: { profiles: Profile[][]; procs: ProcState[] } = { profiles: [], procs: [] }

  before(async () => {
    host = new ProcHost({ home, pipe: hostPipe, store: hostStore })
    await host.listen()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, connectProcHost: () => HostClient.open(hostPipe) })
    rec = await Recorder.connect(daemon.pipe)
    rec.client.on('profiles', (p) => heard.profiles.push(p))
    rec.client.on('proc', (p) => heard.procs.push(p))
  })
  after(async () => {
    try { await rec?.client.request({ t: 'proc-stop', name: 'canario' }) } catch { /* not running */ }
    rec?.close()
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  test('profile and process with a canary value: broadcasts keep the name, never the value; the process runs with it', async () => {
    const l = await listener(daemon.pipe, home)
    const saved = await rec.client.request({ t: 'profile-save', profile: { name: 'Canário', agent: 'shell', args: [], env: { CANARY_VAR: CANARY } } })
    // The reply to whoever saved (and profiles-list, the editor's read) still carries the value.
    assert.equal(saved.profile!.env!.CANARY_VAR, CANARY)
    assert.equal((await rec.client.request({ t: 'profiles-list' })).profiles!.find((p) => p.id === saved.profile!.id)!.env!.CANARY_VAR, CANARY)
    // The process prints its variable: it got the value from tetherd, which no broadcast carried.
    const started = await rec.client.request({
      t: 'proc-start', name: 'canario',
      recipe: { command: 'node', args: ['-e', 'console.log("got " + process.env.CANARY_VAR); setInterval(() => {}, 1000)'], cwd: home, env: { CANARY_VAR: CANARY } },
    })
    assert.equal(started.proc!.status, 'running')
    await waitUntil(() => heard.profiles.some((ps) => ps.some((p) => p.name === 'Canário')) && heard.procs.some((p) => p.name === 'canario' && p.status === 'running'), 10_000, 'the broadcasts')
    await waitUntil(() => l.bytes().includes('"canario"') && l.bytes().includes('Canário'), 10_000, 'the listener heard both')

    const profile = heard.profiles.flat().find((p) => p.name === 'Canário')!
    assert.deepEqual(profile.env, { CANARY_VAR: ENV_VALUE_HIDDEN }, 'the profile broadcast keeps the name only')
    const proc = heard.procs.find((p) => p.name === 'canario')!
    assert.deepEqual(proc.card.env, { CANARY_VAR: ENV_VALUE_HIDDEN }, 'the process broadcast keeps the name only')
    assert.ok(!l.bytes().includes(CANARY), 'a broadcast carried the canary value')

    let out = ''
    rec.client.on('proc-data', (name, data) => { if (name === 'canario') out += data })
    out += (await rec.client.request({ t: 'proc-attach', name: 'canario' })).scrollback ?? ''
    await waitUntil(() => out.includes(`got ${CANARY}`), 10_000, 'the process ran with the value')
    l.socket.destroy()
  })
})
