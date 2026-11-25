// The pure rules of the image viewer and of the drop zone (slice A3): which image comes before and after, the footer's position, the
// subtitle, and which drags are files of the system (a tab of the app being moved is not).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DROP_SUB, DROP_TITLE, dragHasFiles, neighbourOf, positionText, viewerSubtitle } from '../../extensions/channels/renderer/viewer-rules.ts'

describe('viewer rules', () => {
  const ps = ['a.png', 'b.png', 'c.png']
  test('the arrows walk the conversation\'s images and stop at the ends', () => {
    assert.equal(neighbourOf(ps, 'b.png', -1), 'a.png')
    assert.equal(neighbourOf(ps, 'b.png', 1), 'c.png')
    assert.equal(neighbourOf(ps, 'a.png', -1), undefined)
    assert.equal(neighbourOf(ps, 'c.png', 1), undefined)
    assert.equal(neighbourOf(ps, 'x.png', 1), undefined, 'an image that left the conversation has no neighbour')
    assert.equal(neighbourOf([], 'a.png', 1), undefined)
  })
  test('the position is said only when there is more than one image', () => {
    assert.equal(positionText(ps, 'b.png'), '2 de 3')
    assert.equal(positionText(['a.png'], 'a.png'), '')
    assert.equal(positionText(ps, 'x.png'), '')
  })
  test('the subtitle adds the picture size when it is known', () => {
    assert.equal(viewerSubtitle('Imagem · 412 KB', { width: 1280, height: 800 }), 'Imagem · 412 KB · 1280 x 800')
    assert.equal(viewerSubtitle('Imagem · 412 KB'), 'Imagem · 412 KB')
    assert.equal(viewerSubtitle('Imagem · 412 KB', { width: 0, height: 0 }), 'Imagem · 412 KB')
  })
  test('only a drag of files of the system lights the drop zone', () => {
    assert.equal(dragHasFiles(['Files']), true)
    assert.equal(dragHasFiles(['text/uri-list', 'Files']), true)
    assert.equal(dragHasFiles(['text/plain']), false, 'a tab of the app drags text/plain')
    assert.equal(dragHasFiles([]), false)
    assert.equal(dragHasFiles(undefined), false)
  })
  test('the zone says the channel and the limits', () => {
    assert.equal(DROP_TITLE('horizontes'), 'Solte para anexar ao #horizontes')
    assert.equal(DROP_SUB, 'Até 10 arquivos, 20 MB cada. Todos os membros poderão ler.')
  })
})
