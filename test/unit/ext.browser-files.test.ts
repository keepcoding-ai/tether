// The tabs' files rules (extensions/browser/files-rules.ts, design §4.3, review M1): the download's name and ceilings, the pad's
// "Baixados", the upload dialog that names the site owning the field, and the gate's view of the package's attach.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachCarriesFiles, attachRefusal, downloadGroups, downloadOver, fieldOwnerText, formatBytes, MAX_AGENT_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES,
  originText, safeDownloadName, splitPath, uniqueName, uploadDialog, whenText, zoneIdentifier,
} from '../../extensions/browser/files-rules.ts'

describe('browser files: downloads', () => {
  test('the name loses its folder, Windows-invalid characters, trailing dots and reserved device names', () => {
    assert.equal(safeDownloadName('../../etc/passwd'), 'passwd')
    assert.equal(safeDownloadName('C:\\Users\\x\\evil.txt'), 'evil.txt')
    assert.equal(safeDownloadName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt')
    assert.equal(safeDownloadName('report.pdf. . '), 'report.pdf')
    assert.equal(safeDownloadName('..'), 'download')
    assert.equal(safeDownloadName(''), 'download')
    assert.equal(safeDownloadName('CON'), '_CON')
    assert.equal(safeDownloadName('nul.txt'), '_nul.txt')
    assert.equal(safeDownloadName('com1.log'), '_com1.log')
    assert.equal(safeDownloadName('line\nbreak.txt'), 'line_break.txt')
    assert.equal(safeDownloadName('x'.repeat(300)).length, 190)
    assert.equal(safeDownloadName('x'.repeat(200)).length, 200)
  })
  test('the name loses invisible format characters (bidi, zero width) and is NFC (review N-M1)', () => {
    assert.equal(safeDownloadName('fatura\u202Efdp.exe'), 'faturafdp.exe.download')
    assert.equal(safeDownloadName('a\u202A\u202B\u202C\u202D\u202Eb.txt'), 'ab.txt')
    assert.equal(safeDownloadName('a\u2066\u2067\u2068\u2069b.txt'), 'ab.txt')
    assert.equal(safeDownloadName('a\u200E\u200F\u061Cb.txt'), 'ab.txt')
    assert.equal(safeDownloadName('a\u200B\u200C\u200D\uFEFF\u2060b.txt'), 'ab.txt')
    assert.equal(safeDownloadName('a\u00ADb\uFE0F\u{E0041}.txt'), 'ab.txt')
    assert.equal(safeDownloadName('nota.txt\u202E'), 'nota.txt')
    assert.equal(safeDownloadName('cafe\u0301.txt'), 'caf\u00e9.txt')
    assert.equal(safeDownloadName('a\u0085b.txt'), 'a_b.txt')
  })
  test('a dangerous type is made inert with .download; reserved names with spaces or superscripts are prefixed (review N-M1)', () => {
    for (const ext of ['exe', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'msi', 'scr', 'cpl', 'reg', 'jar', 'lnk', 'url', 'scf', 'library-ms', 'searchConnector-ms', 'desktop']) {
      assert.equal(safeDownloadName(`x.${ext}`), `x.${ext}.download`, ext)
    }
    assert.equal(safeDownloadName('X.URL'), 'X.URL.download')
    assert.equal(safeDownloadName('evil.url. . '), 'evil.url.download')
    assert.equal(safeDownloadName('desktop.ini'), 'desktop.ini.download')
    assert.equal(safeDownloadName('Desktop.INI'), 'Desktop.INI.download')
    assert.equal(safeDownloadName('report.pdf'), 'report.pdf')
    assert.equal(safeDownloadName('x.exe.download'), 'x.exe.download')
    assert.equal(safeDownloadName('con .txt'), '_con .txt')
    assert.equal(safeDownloadName('COM\u00b9.log'), '_COM\u00b9.log')
    assert.equal(safeDownloadName('lpt\u00b3'), '_lpt\u00b3')
    assert.equal(safeDownloadName('CONIN$'), '_CONIN$')
    assert.equal(safeDownloadName('conout$.txt'), '_conout$.txt')
    const long = safeDownloadName(`${'y'.repeat(300)}.exe`)
    assert.equal(long.length, 190)
    assert.ok(long.endsWith('.exe.download'), long)
  })
  test('idempotent: every name it gives comes back unchanged (the pad finds the file by it)', () => {
    for (const raw of ['x.url', 'fatura\u202Efdp.exe', `${'y'.repeat(300)}.lnk`, `${'z'.repeat(300)}.txt`, 'CON', 'desktop.ini', 'a.exe-1.download']) {
      const once = safeDownloadName(raw)
      assert.equal(safeDownloadName(once), once, raw)
      const second = uniqueName(once, n => n === once)
      assert.equal(safeDownloadName(second), second, second)
    }
  })
  test('the Mark of the Web: Internet zone with the origin only', () => {
    assert.equal(zoneIdentifier('https://site.example:8443/a/b.exe?token=SECRET#x'), '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://site.example:8443\r\nHostUrl=https://site.example:8443\r\n')
    assert.equal(zoneIdentifier('blob:https://site.example/1234-uuid'), '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://site.example\r\nHostUrl=https://site.example\r\n')
    assert.equal(zoneIdentifier('data:text/plain,hi'), '[ZoneTransfer]\r\nZoneId=3\r\n')
    assert.equal(zoneIdentifier('not a url'), '[ZoneTransfer]\r\nZoneId=3\r\n')
  })
  test('never overwrites: a numeric suffix before the extension', () => {
    const have = new Set(['a.txt', 'a-1.txt', 'b'])
    assert.equal(uniqueName('a.txt', n => have.has(n)), 'a-2.txt')
    assert.equal(uniqueName('b', n => have.has(n)), 'b-1')
    assert.equal(uniqueName('c.txt', n => have.has(n)), 'c.txt')
    assert.equal(uniqueName('.env', n => n === '.env'), '.env-1')
  })
  test("the package's ceilings: 50 MB per file, 200 MB per agent", () => {
    assert.equal(MAX_DOWNLOAD_BYTES, 50 * 1024 * 1024)
    assert.equal(MAX_AGENT_DOWNLOAD_BYTES, 200 * 1024 * 1024)
    assert.equal(downloadOver(MAX_DOWNLOAD_BYTES, 0), null)
    assert.equal(downloadOver(MAX_DOWNLOAD_BYTES + 1, 0), 'file')
    assert.equal(downloadOver(10, MAX_AGENT_DOWNLOAD_BYTES - 10), null)
    assert.equal(downloadOver(11, MAX_AGENT_DOWNLOAD_BYTES - 10), 'agent')
  })
  test('the pad: sizes, when, and groups by agent with the newest first', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(12 * 1024), '12 KB')
    assert.equal(formatBytes(3.4 * 1024 * 1024), '3,4 MB')
    assert.equal(formatBytes(42 * 1024 * 1024), '42 MB')
    assert.equal(whenText(1000, 30_000), 'agora')
    assert.equal(whenText(0, 5 * 60_000), 'há 5 min')
    assert.equal(whenText(0, 2 * 3_600_000), 'há 2 h')
    const g = downloadGroups([
      { slotId: 'a', name: 'old', bytes: 1, at: 1 }, { slotId: 'b', name: 'b1', bytes: 1, at: 5 }, { slotId: 'a', name: 'new', bytes: 1, at: 9 },
    ])
    assert.deepEqual(g.map(x => [x.slotId, x.files.map(f => f.name)]), [['a', ['new', 'old']], ['b', ['b1']]])
  })
})

describe('browser files: the upload consent', () => {
  const ask = { id: '1', tabId: 't', agent: 'Sonda', fileName: 'nota.txt', folder: 'C:\\Users\\x\\Downloads', frameOrigin: 'http://127.0.0.1:5001', pageOrigin: 'http://localhost:5000' }
  test('the field owner is said in words, and the page when it is another site', () => {
    assert.equal(fieldOwnerText('https://a.test', 'https://a.test'), 'O campo é de https://a.test.')
    assert.equal(fieldOwnerText('https://evil.test', 'https://bank.test'), 'O campo é de https://evil.test, dentro de https://bank.test.')
    assert.equal(originText('https://a.test/'), 'https://a.test')
    assert.equal(originText('evil\nline'), '"evil\\nline"')
  })
  test('the dialog names the agent, the file, its folder and the frame that owns the field; Enter and Esc refuse', () => {
    const d = uploadDialog(ask)
    assert.equal(d.title, 'Permitir que Sonda envie nota.txt para http://127.0.0.1:5001?')
    assert.match(d.message!, /^O campo é de http:\/\/127\.0\.0\.1:5001, dentro de http:\/\/localhost:5000\. É outro site, embutido na página\./)
    assert.deepEqual(d.context, { icon: 'file', name: 'nota.txt', lines: ['C:\\Users\\x\\Downloads', 'Pedido por Sonda'] })
    assert.deepEqual(d.choices.map(c => [c.id, c.label, c.tone]), [['allow', 'Permitir', 'neutral'], ['deny', 'Não permitir', 'safe']])
    assert.equal(d.defaultChoice, 'deny')
    assert.equal(d.escChoice, 'deny')
    assert.equal(d.image, undefined)
    assert.deepEqual(uploadDialog({ ...ask, image: 'data:image/jpeg;base64,AA' }).image, { src: 'data:image/jpeg;base64,AA', alt: 'A página agora' })
    const same = uploadDialog({ ...ask, frameOrigin: 'http://localhost:5000' })
    assert.equal(same.message, 'O campo é de http://localhost:5000. O conteúdo do arquivo vai para esse site.')
  })
  test('a path splits into folder and name', () => {
    assert.deepEqual(splitPath('C:\\a\\b.txt'), { folder: 'C:\\a', name: 'b.txt' })
    assert.deepEqual(splitPath('/x/y'), { folder: '/x', name: 'y' })
    assert.deepEqual(splitPath('solo'), { folder: '', name: 'solo' })
  })
})

describe("browser files: the gate's view of the attach", () => {
  const util = { value: '([injected, node, files]) => injected.setInputFiles(node, files)' }
  test("playwright-core's attach with files is recognised; the empty list and other calls are not", () => {
    assert.equal(attachCarriesFiles({ functionDeclaration: 'function(){}', arguments: [util, { value: { o: [{ k: 'buffer', v: { s: 'QUJD' } }] } }] }), true)
    assert.equal(attachCarriesFiles({ functionDeclaration: 'f => f.setInputFiles(x, files)', arguments: [{ value: [{ name: 'a', buffer: 'QUJD' }] }] }), true)
    assert.equal(attachCarriesFiles({ functionDeclaration: 'function(){}', arguments: [util, { value: { a: [] } }] }), false)
    assert.equal(attachCarriesFiles({ functionDeclaration: 'function(){ return 1 }', arguments: [{ value: 'buffer' }] }), false)
    assert.equal(attachCarriesFiles({}), false)
  })
  test('the attach goes only under a fresh grant into a frame of the origin asked', () => {
    const grant = { origin: 'http://127.0.0.1:5001', until: 1000 }
    assert.equal(attachRefusal(grant, 'http://127.0.0.1:5001', 999), null)
    assert.match(attachRefusal(undefined, 'http://127.0.0.1:5001', 0)!, /no consent/)
    assert.match(attachRefusal(grant, 'http://127.0.0.1:5001', 1001)!, /ran out/)
    assert.match(attachRefusal(grant, 'http://localhost:5000', 0)!, /now in http:\/\/localhost:5000/)
    assert.match(attachRefusal(grant, undefined, 0)!, /could not be read/)
  })
})
