// The HTML preview (F5): what an isolated page may reach (app/main/html-preview-policy.ts: files, requests, navigations), how
// paths and file URLs convert (app/shared/html-preview.ts), and the pane's identity in the layout (app/shared/preview.ts).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideNavigation, decideRequest, fileUrlPath, isInside, isLocalHost, isPreviewPartition, pathAllowed, previewablePageUrl, rootOf } from '../../app/main/html-preview-policy.ts'
import { blockedLabel, fromFileUrl, pathKey, previewPartition, samePath, toFileUrl } from '../../app/shared/html-preview.ts'
import { isSlotlessPanelId } from '../../app/shared/empty.ts'
import { isHtmlPath, isMarkdownPath, isPreviewablePath, newPreviewPanelId, previewKindOf, previewParams, previewTitle, withPreview } from '../../app/shared/preview.ts'
import { tempDirs } from './tmp.helpers.ts'

const tmp = tempDirs('tether-htmlp-')
after(() => tmp.cleanup())

// Windows paths on any host: the policy is told the file system is case-insensitive; on a posix host `resolve` keeps `C:\` relative,
// so the path tests that need real Windows semantics run only there.
const win = process.platform === 'win32'
const onlyWin = { skip: win ? false : 'needs Windows path semantics' }
const ROOT = win ? 'C:\\pages\\demo' : '/pages/demo'
const sub = (...parts: string[]): string => (win ? [ROOT, ...parts].join('\\') : [ROOT, ...parts].join('/'))
const url = (...parts: string[]): string => toFileUrl(sub(...parts))

describe('which html files the preview opens', () => {
  test('extensions', () => {
    for (const p of ['a.html', 'A.HTM', 'x/y.xhtml', 'C:\\a b\\p.Html']) assert.equal(isHtmlPath(p), true, p)
    for (const p of ['a.md', 'a.htm.txt', 'html', 'a.html.bak', 'a.svg', '']) assert.equal(isHtmlPath(p), false, p)
    assert.equal(isPreviewablePath('r.md'), true)
    assert.equal(isPreviewablePath('r.html'), true)
    assert.equal(isPreviewablePath('r.ts'), false)
    assert.equal(isMarkdownPath('r.html'), false)
  })
  test('the page url must be a local .html file', () => {
    assert.equal(previewablePageUrl(url('index.html')), sub('index.html'))
    assert.equal(previewablePageUrl('https://example.com/index.html'), undefined)
    assert.equal(previewablePageUrl(url('notes.md')), undefined)
    assert.equal(previewablePageUrl('file://server/share/a.html'), undefined, 'a network share')
    assert.equal(previewablePageUrl(''), undefined)
  })
  test('the root of a page is its own folder', () => {
    assert.equal(rootOf(sub('index.html')), ROOT)
    assert.equal(rootOf(sub('a', 'b.html')), sub('a'))
  })
})

describe('file urls and paths', () => {
  test('toFileUrl encodes what a url cannot carry', () => {
    assert.equal(toFileUrl('D:\\a b\\x#1.html'), 'file:///D:/a%20b/x%231.html')
    assert.equal(toFileUrl('D:/pasta/ação.html'), 'file:///D:/pasta/a%C3%A7%C3%A3o.html')
    assert.equal(toFileUrl('/home/u/p q/x.html'), 'file:///home/u/p%20q/x.html')
  })
  test('fromFileUrl is the way back', () => {
    for (const p of ['D:\\a b\\x#1.html', 'C:\\pasta\\ação.html']) assert.equal(fromFileUrl(toFileUrl(p)), p)
    assert.equal(fromFileUrl('file:///home/u/x%20y.html'), '/home/u/x y.html')
    assert.equal(fromFileUrl('https://x/y.html'), undefined)
    assert.equal(fromFileUrl('file://host/share/a.html'), undefined)
    assert.equal(fromFileUrl('not a url'), undefined)
  })
  test('paths compare as Windows does', () => {
    assert.equal(samePath('D:/Pasta/X.html', 'd:\\pasta\\x.HTML'), true)
    assert.equal(pathKey('D:/A'), 'd:\\a')
    assert.equal(samePath('D:\\a', 'D:\\b'), false)
  })
  test('partition names are in memory and per pane', () => {
    const name = previewPartition('preview:0abc-1234', 2)
    assert.equal(name, 'htmlprev-preview-0abc-1234-2')
    assert.equal(isPreviewPartition(name), true)
    for (const bad of ['persist:htmlprev-a', 'htmlprev-', 'htmlprev-a b', 'other-a', 'htmlprev-../x', '', undefined, 3]) assert.equal(isPreviewPartition(bad), false, String(bad))
  })
  test('the strip counts what was refused', () => {
    assert.equal(blockedLabel(1), '1 recurso bloqueado')
    assert.equal(blockedLabel(3), '3 recursos bloqueados')
  })
})

describe('file access: the page\'s folder and below, nothing else', () => {
  test('lexical containment (case-insensitive when told so)', () => {
    if (!win) return
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\demo\\a\\b.png', true), true)
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\demo', true), true)
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\DEMO\\x.js', true), true)
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\demo2\\x.js', true), false, 'a sibling that shares the prefix')
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\other.js', true), false)
    assert.equal(isInside('C:\\pages\\demo', 'C:\\pages\\demo\\..\\other.js', true), false, '.. is resolved first')
    assert.equal(isInside('C:\\pages\\demo', 'D:\\pages\\demo\\x.js', true), false, 'another drive')
    assert.equal(isInside('C:\\pages\\demo', 'relative\\x.js', true), false)
  })
  test('posix containment', () => {
    if (win) return
    assert.equal(isInside('/pages/demo', '/pages/demo/a/b.png', false), true)
    assert.equal(isInside('/pages/demo', '/pages/demo2/x', false), false)
    assert.equal(isInside('/pages/demo', '/pages/demo/../x', false), false)
  })
  test('file urls: inside is allowed; traversal, encoded traversal and other folders are not', onlyWin, () => {
    const ok = (u: string): boolean => decideRequest(u, ROOT).allow
    assert.equal(ok(url('index.html')), true)
    assert.equal(ok(url('img', 'a.png')), true)
    assert.equal(ok('file:///C:/pages/demo/img/../a.png'), true, 'resolves back inside')
    assert.equal(ok('file:///C:/pages/demo/../secret.txt'), false)
    assert.equal(ok('file:///C:/pages/demo/%2e%2e/secret.txt'), false)
    assert.equal(ok('file:///C:/pages/demo/%2E%2E%2Fsecret.txt'), false)
    assert.equal(ok('file:///C:/pages/demo/..%5Csecret.txt'), false, 'an encoded backslash is a separator on Windows')
    assert.equal(ok('file:///C:/pages/demo/img/..%5C..%5Csecret.txt'), false)
    assert.equal(ok('file:///C:/pages/other/a.png'), false)
    assert.equal(ok('file:///C:/Windows/win.ini'), false)
    assert.equal(ok('file:///D:/pages/demo/a.png'), false, 'another drive')
    assert.equal(ok('file:///C:/pages/demo2/a.png'), false, 'a sibling folder with the same prefix')
  })
  test('network shares are never reached (the system would send credentials)', onlyWin, () => {
    for (const u of ['file://server/share/a.png', 'file:////server/share/a.png', 'file:///\\\\server\\share\\a.png', 'file://192.168.0.5/c$/x']) {
      assert.equal(fileUrlPath(u), undefined, u)
      assert.equal(decideRequest(u, ROOT).allow, false, u)
    }
    assert.equal(fileUrlPath('file://localhost/C:/pages/demo/a.png'), 'C:\\pages\\demo\\a.png', 'localhost is this machine')
  })
  test('a link inside the folder that leads out is followed and refused', onlyWin, () => {
    const base = tmp.make()
    const root = join(base, 'page')
    const outside = join(base, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(root, 'ok.txt'), 'inside')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    let linked = false
    try { symlinkSync(outside, join(root, 'door'), 'junction'); linked = true } catch { /* no permission to link */ }
    const real = (p: string): string => realpathSync.native(p)
    assert.equal(pathAllowed(root, join(root, 'ok.txt'), { realpath: real }), true)
    assert.equal(pathAllowed(root, join(root, 'missing.txt'), { realpath: real }), true, 'a file that does not exist cannot leak; the load fails by itself')
    if (linked) {
      assert.equal(pathAllowed(root, join(root, 'door', 'secret.txt')), true, 'lexically inside')
      assert.equal(pathAllowed(root, join(root, 'door', 'secret.txt'), { realpath: real }), false, 'but it lives outside')
      assert.equal(decideRequest(toFileUrl(join(root, 'door', 'secret.txt')), root, { realpath: real }).allow, false)
    }
  })
})

describe('web access: https for sub-resources, never this machine, top-level only inside the folder', () => {
  test('sub-resources', () => {
    const ok = (u: string): boolean => decideRequest(u, ROOT).allow
    for (const u of ['https://cdn.jsdelivr.net/npm/x/y.js', 'https://fonts.googleapis.com/css2?family=Inter', 'wss://example.com/socket', 'data:image/png;base64,AAAA', 'blob:null/1234', 'about:blank']) assert.equal(ok(u), true, u)
    for (const u of ['http://example.com/x.js', 'ws://example.com/s', 'ftp://example.com/x', 'chrome-extension://abc/x.js', 'devtools://devtools/bundled/x', 'view-source:https://example.com', 'javascript:alert(1)', 'not a url', 'filesystem:https://example.com/temporary/x']) assert.equal(ok(u), false, u)
  })
  test('this machine and its network are not reachable even over https', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[::]', '[fd12:3456::1]', '[fe80::1]', 'printer.local', 'db.internal', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:192.168.0.1]', '2130706433']) {
      assert.equal(decideRequest(`https://${host}/x`, ROOT).allow, false, host)
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '[2606:4700::1111]', 'cdn.jsdelivr.net']) assert.equal(decideRequest(`https://${host}/x`, ROOT).allow, true, host)
    assert.equal(isLocalHost('LOCALHOST.'), true)
    assert.equal(isLocalHost(''), true)
  })
  test('navigation: inside the folder moves the page; the web leaves for the browser; the rest is dropped', onlyWin, () => {
    assert.deepEqual(decideNavigation(url('other.html'), ROOT), { kind: 'allow' })
    assert.deepEqual(decideNavigation(url('sub', 'p.html'), ROOT), { kind: 'allow' })
    assert.equal(decideNavigation('file:///C:/pages/secret.html', ROOT).kind, 'block')
    assert.equal(decideNavigation('file://server/share/a.html', ROOT).kind, 'block')
    assert.deepEqual(decideNavigation('https://example.com/a?b=1#c', ROOT), { kind: 'external', url: 'https://example.com/a?b=1#c' })
    assert.deepEqual(decideNavigation('http://example.com/', ROOT), { kind: 'external', url: 'http://example.com/' })
    assert.deepEqual(decideNavigation('https://localhost:8080/', ROOT), { kind: 'external', url: 'https://localhost:8080/' }, 'the browser is the person\'s choice, not the page\'s')
    for (const u of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x/y', 'chrome://settings', 'mailto:a@b.c', 'tel:123', 'zzz']) assert.equal(decideNavigation(u, ROOT).kind, 'block', u)
    assert.deepEqual(decideNavigation('about:blank', ROOT), { kind: 'allow' })
  })
})

describe('the pane in the layout', () => {
  test('params carry the kind and the scroll; markdown params are as before', () => {
    assert.deepEqual(previewParams({ preview: { path: 'D:\\a\\x.html', kind: 'html', scroll: { x: 0, y: 340 } } }), { path: 'D:\\a\\x.html', kind: 'html', scroll: { x: 0, y: 340 } })
    assert.deepEqual(previewParams({ preview: { path: 'D:\\a\\x.md', line: 4 } }), { path: 'D:\\a\\x.md', line: 4 })
    assert.deepEqual(previewParams({ preview: { path: 'x.html', kind: 'evil', scroll: { x: -1, y: 2 } } }), { path: 'x.html' }, 'unknown kind and a negative scroll are dropped')
    assert.equal(previewKindOf({ preview: { path: 'x.html', kind: 'html' } }), 'html')
    assert.equal(previewKindOf({ preview: { path: 'x.md' } }), 'md')
    assert.equal(previewKindOf(undefined), 'md')
    const params = withPreview({ other: 1 }, { path: 'D:\\a\\x.html', kind: 'html', scroll: { x: 3, y: 4 } })
    assert.deepEqual(params, { other: 1, preview: { path: 'D:\\a\\x.html', kind: 'html', scroll: { x: 3, y: 4 } } })
    assert.deepEqual(previewParams(params), { path: 'D:\\a\\x.html', kind: 'html', scroll: { x: 3, y: 4 } })
  })
  test('the tab says "Prévia: nome.html"; an html preview is never pruned as an orphan', () => {
    assert.equal(previewTitle('D:\\a\\demo.html'), 'Prévia: demo.html')
    assert.equal(isSlotlessPanelId(newPreviewPanelId()), true)
  })
})
