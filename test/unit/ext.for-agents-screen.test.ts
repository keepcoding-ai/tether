// The screen as text (5.4): the raw of an agent's PTY becomes the text a person sees. The samples in test/fixtures/screen/
// are raw output recorded by the probes, with the text each probe recorded beside it; the reader must give the same text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ScreenRead } from '../../src/daemon/protocol.ts'
import { createScreenReaders, historyString, MAX_READERS, screenString } from '../../extensions/for-agents/screen/index.ts'
import { createXtermLoader, DEFAULT_VENDOR_DIR } from '../../extensions/for-agents/screen/loader.ts'

/** A sample: the raw, the text the probe recorded, the PTY size. Stored as JSON so git's line-ending conversion cannot touch the raw's CRs. */
interface Sample { name: string; raw: string; text: string; cols: number; rows: number }
const sample = (file: string): Sample => {
  const j = JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/screen/${file}.json`, import.meta.url)), 'utf8')) as { raw: string; expected: string; cols: number; rows: number }
  return { name: file.replace('-', ' '), raw: j.raw, text: j.expected, cols: j.cols, rows: j.rows }
}

/** The samples: codex 120x40 (codex-*), a synthetic TUI, the alternate screen and cmd 100x30 (tela-*). */
const SAMPLES: Sample[] = ['codex-s1-gap150', 'codex-s2-chunk', 'codex-s3-tab', 'codex-s5-n', 'tela-agent', 'tela-alt', 'tela-shell'].map(sample)

/** A fake slot ring: what the daemon's `readScreen(slotId, since)` answers over a raw that grows (`avail` chars so far). */
class FakeRing {
  readonly raw: string
  avail: number
  cols: number
  rows: number
  /** The `since` of every fetch, in order. */
  fetches: (number | undefined)[] = []
  lostBefore = 0
  constructor(raw: string, cols: number, rows: number, avail = raw.length) { this.raw = raw; this.avail = avail; this.cols = cols; this.rows = rows }
  fetch = (since?: number): ScreenRead => {
    this.fetches.push(since)
    const reset = since !== undefined && since < this.lostBefore
    const from = since === undefined || reset ? this.lostBefore : since
    return { data: this.raw.slice(from, this.avail), cols: this.cols, rows: this.rows, start: this.lostBefore, end: this.avail, reset }
  }
}

const rawRead = (raw: string, cols: number, rows: number): FakeRing => new FakeRing(raw, cols, rows)

describe('a tela como texto: as amostras das sondas', () => {
  for (const s of SAMPLES) {
    test(`${s.name}: uma linha por linha da tela, igual ao texto gravado`, async () => {
      const readers = createScreenReaders({ joinWrapped: false })
      const t = await readers.read('slot', rawRead(s.raw, s.cols, s.rows).fetch)
      assert.equal(screenString(t), s.text.trimEnd())
      assert.equal(t.cols, s.cols)
      assert.equal(t.rows, s.rows)
      assert.equal(t.end, s.raw.length)
      readers.dispose()
    })

    test(`${s.name}: alimentar por trechos dá o mesmo que de uma vez`, async () => {
      const whole = createScreenReaders()
      const want = await whole.read('slot', rawRead(s.raw, s.cols, s.rows).fetch)
      for (const step of [37, 1000]) {
        const readers = createScreenReaders()
        const ring = new FakeRing(s.raw, s.cols, s.rows, 0)
        let got = await readers.read('slot', ring.fetch)
        for (let n = step; ; n += step) {
          ring.avail = Math.min(n, s.raw.length)
          got = await readers.read('slot', ring.fetch)
          if (ring.avail === s.raw.length) break
        }
        assert.deepEqual(got, want, `trechos de ${step}`)
        assert.ok(ring.fetches.slice(1).every(since => since !== undefined), 'só a primeira leitura pede o anel inteiro')
        readers.dispose()
      }
      whole.dispose()
    })
  }

  test('a tela de agora e o histórico saem separados', async () => {
    const agent = SAMPLES.find(s => s.name === 'tela agent')!
    const readers = createScreenReaders()
    const t = await readers.read('slot', rawRead(agent.raw, agent.cols, agent.rows).fetch)
    assert.ok(t.history.length > 0)
    assert.equal(t.history[0], '[hist 1] tool call output line 1 with some text')
    assert.ok(!screenString(t).includes('[hist 1]'))
    assert.ok(screenString(t).includes('FINAL-AGENT-MARK'))
    assert.equal(historyString(t).split('\n')[0], t.history[0])
    const alt = SAMPLES.find(s => s.name === 'tela alt')!
    const a = await readers.read('alt', rawRead(alt.raw, alt.cols, alt.rows).fetch)
    assert.deepEqual(a.history, [], 'a tela alternada não tem histórico')
    readers.dispose()
  })
})

describe('a tela como texto: o que o leitor faz', () => {
  test('linha quebrada (isWrapped) sai junta, e com joinWrapped falso sai uma por linha da tela', async () => {
    const raw = `${'a'.repeat(25)}${'b'.repeat(5)}\r\nfim\r\n`
    const joined = await createScreenReaders().read('s', rawRead(raw, 10, 6).fetch)
    assert.deepEqual(joined.screen, ['a'.repeat(25) + 'b'.repeat(5), 'fim', '', ''])
    const rows = await createScreenReaders({ joinWrapped: false }).read('s', rawRead(raw, 10, 6).fetch)
    assert.deepEqual(rows.screen, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5) + 'b'.repeat(5), 'fim', '', ''])
  })

  test('o espaço no fim de uma linha quebrada não se perde na junção', async () => {
    const raw = 'abcd efgh ijkl'
    const t = await createScreenReaders().read('s', rawRead(raw, 5, 4).fetch)
    assert.equal(t.screen[0], 'abcd efgh ijkl')
  })

  test('mudou o tamanho: o terminal é refeito do anel inteiro', async () => {
    const raw = SAMPLES.find(s => s.name === 'tela agent')!.raw
    const readers = createScreenReaders()
    const ring = new FakeRing(raw, 100, 30, Math.floor(raw.length / 2))
    await readers.read('slot', ring.fetch)
    ring.avail = raw.length
    ring.cols = 80
    ring.rows = 24
    const after = await readers.read('slot', ring.fetch)
    assert.deepEqual(ring.fetches, [undefined, Math.floor(raw.length / 2), undefined], 'pede o novo, vê o tamanho mudar e pede o anel inteiro')
    const fresh = await createScreenReaders().read('slot', rawRead(raw, 80, 24).fetch)
    assert.deepEqual(after, fresh)
    assert.equal(after.cols, 80)
    assert.equal(after.rows, 24)
    readers.dispose()
  })

  test('reset: o anel perdeu o que o since pedia, o terminal é refeito do que veio', async () => {
    const raw = SAMPLES.find(s => s.name === 'tela agent')!.raw
    const readers = createScreenReaders()
    const ring = new FakeRing(raw, 100, 30, 3000)
    await readers.read('slot', ring.fetch)
    ring.avail = raw.length
    ring.lostBefore = 3500 // the ring lost the part the next since (3000) asked for
    const after = await readers.read('slot', ring.fetch)
    const fresh = await createScreenReaders().read('slot', new FakeRing(raw.slice(3500), 100, 30).fetch)
    assert.deepEqual(after.screen, fresh.screen)
    assert.equal(after.end, raw.length)
    readers.dispose()
  })

  test('since(): onde a próxima leitura começa; drop e dispose soltam os terminais', async () => {
    const readers = createScreenReaders()
    assert.equal(readers.since('a'), undefined)
    await readers.read('a', rawRead('um\r\n', 20, 3).fetch)
    await readers.read('b', rawRead('dois\r\n', 20, 3).fetch)
    assert.equal(readers.since('a'), 4)
    assert.equal(readers.since('b'), 6)
    assert.equal(readers.size, 2)
    readers.drop('a')
    assert.equal(readers.since('a'), undefined)
    assert.equal(readers.size, 1)
    readers.dispose()
    assert.equal(readers.size, 0)
  })

  test('no máximo MAX_READERS terminais: sai o menos usado, e a limpeza é no acesso (sem timer)', async () => {
    assert.equal(MAX_READERS, 8)
    const readers = createScreenReaders({ max: 3 })
    for (const id of ['a', 'b', 'c']) await readers.read(id, rawRead(`${id}\r\n`, 20, 3).fetch)
    await readers.read('a', rawRead('a\r\n', 20, 3).fetch) // a is the most recent now
    await readers.read('d', rawRead('d\r\n', 20, 3).fetch)
    assert.equal(readers.size, 3)
    assert.equal(readers.since('b'), undefined, 'b era o menos usado')
    assert.notEqual(readers.since('a'), undefined)
    assert.notEqual(readers.since('c'), undefined)
    assert.notEqual(readers.since('d'), undefined)
    readers.dispose()
  })

  test('duas leituras ao mesmo tempo no mesmo slot não alimentam o mesmo trecho duas vezes', async () => {
    const raw = SAMPLES.find(s => s.name === 'tela agent')!.raw
    const readers = createScreenReaders()
    const ring = new FakeRing(raw, 100, 30, 0)
    ring.avail = Math.floor(raw.length / 3)
    const first = readers.read('slot', ring.fetch)
    ring.avail = raw.length
    const [a, b] = await Promise.all([first, readers.read('slot', ring.fetch)])
    assert.equal(a.end, raw.length)
    assert.deepEqual(b, await createScreenReaders().read('slot', rawRead(raw, 100, 30).fetch))
    readers.dispose()
  })

  test('uma leitura que falha não trava as seguintes', async () => {
    const readers = createScreenReaders()
    await assert.rejects(readers.read('s', () => { throw new Error('unknown-slot') }), /unknown-slot/)
    const t = await readers.read('s', rawRead('ok\r\n', 20, 3).fetch)
    assert.equal(t.screen[0], 'ok')
    readers.dispose()
  })

  test('carga preguiçosa: o pacote só é pedido na leitura', async () => {
    const real = createXtermLoader(DEFAULT_VENDOR_DIR)
    let loads = 0
    const readers = createScreenReaders({ load: () => { loads++; return real() } })
    readers.since('x')
    readers.drop('x')
    readers.dispose()
    assert.equal(loads, 0, 'criar, consultar e soltar não carregam')
    await readers.read('x', rawRead('a\r\n', 20, 3).fetch)
    await readers.read('y', rawRead('b\r\n', 20, 3).fetch)
    await readers.read('x', rawRead('a\r\n', 20, 3).fetch)
    assert.equal(loads, 3, 'cada leitura pede o carregador; o carregador importa o pacote uma vez (ext.for-agents-vendor)')
    readers.dispose()
  })

  test('um milhão de caracteres: a tela sai em tempo curto', async () => {
    let raw = ''
    for (let i = 0; raw.length < 1_000_000; i++) raw += `\x1b[2m[linha ${i}]\x1b[0m saída de ferramenta com algum texto ${'x'.repeat(i % 60)}\r\n`
    const readers = createScreenReaders()
    await readers.read('warm', rawRead('a\r\n', 100, 30).fetch) // the package load is not part of the cost
    const t0 = performance.now()
    const t = await readers.read('big', rawRead(raw, 100, 30).fetch)
    const ms = performance.now() - t0
    console.log(`1M caracteres: ${ms.toFixed(0)} ms, ${t.history.length} linhas de histórico`)
    assert.ok(t.history.length > 0 && t.history.length <= 5000)
    assert.ok(ms < 3000, `${ms} ms`)
    readers.dispose()
  })
})
