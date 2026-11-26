// The channels extension in the app. The channel's pane (reading) is here (U1a); the speaking box comes in its own slice (U1b);
// the commands, the picker and the menus are U2 (renderer/commands.ts, renderer/menus.ts); the marks (unread, "to you") and the
// top bar icon are U3 (renderer/marks.ts, renderer/status.ts).
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { createChannelPanes } from './renderer/channel-pane.ts'
import { createChannel, createCommands, createDirectory, joinAgent } from './renderer/commands.ts'
import { holds } from './renderer/holds.ts'
import { channelEmbeds } from './renderer/embed.ts'
import { createMarks } from './renderer/marks.ts'
import { createMenus } from './renderer/menus.ts'
import { createStatus } from './renderer/status.ts'
import { failedDialog, refusalWords } from './renderer/texts.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): Disposable[] {
  const directory = createDirectory(ui)
  // The marks hear the daemon's `line` before the panes do: a line seen the moment it comes never counts as unread.
  const marks = createMarks(ui, directory)
  const panes = createChannelPanes(ui, marks, directory.list)
  // `#name` of an existing channel is a link on every surface, and tether://channel/<id> opens it: the core asks this cache, never the daemon.
  const links = ui.links.provideChannels({
    list: () => directory.list().map(c => ({ id: c.id, name: c.name, ...(c.closed !== undefined ? { closed: true } : {}) })),
    open: id => {
      const c = directory.list().find(x => x.id === id)
      if (c) panes.open(c.id, c.name)
      else void ui.dialogs.ask(failedDialog('Abrir canal', 'unknown-channel')).catch(() => undefined)
    },
  })
  // Feed C: what the Regency reads of the channels (the directory, the marks as counts) and the channel's view it embeds.
  // The marks notify after each directory refresh too (their sync asks the directory), so one subscription covers both.
  const feed = channelEmbeds.publish({
    list: directory.list,
    marksOf: id => ({ unread: marks.of(id).unread, toMe: marks.of(id).toMe, asks: marks.asksOf(id).length, owed: marks.owedOf(id).length }),
    onDidChange: marks.onDidChange,
    mount: (host, channelId, opts) => panes.mountEmbed(host, channelId, opts),
    create: async name => {
      const r = await createChannel(ui, name)
      if (!('channel' in r)) return { refusal: refusalWords(r.code) }
      await directory.refresh().catch(() => {})
      return { ok: true, id: r.channel.id }
    },
    join: async (channelId, agent) => {
      const r = await joinAgent(ui, channelId, agent)
      if (!('ok' in r)) return { refusal: refusalWords(r.code) }
      await directory.refresh().catch(() => {})
      return { ok: true }
    },
    openOn: (channelId, deskId) => {
      const name = directory.list().find(c => c.id === channelId)?.name
      return panes.openOn(channelId, deskId, name) ? { ok: true } : { refusal: 'Não foi possível abrir o canal nessa mesa.' }
    },
  })
  return [
    feed,
    links,
    ...directory.disposables, ...marks.disposables, ...panes.disposables,
    ...createStatus(ui, marks, directory.list),
    ...createCommands(ui, { open: panes.open, directory }),
    ...createMenus(ui, directory, panes.open),
    ...holds(ui, directory.memberIds),
  ]
}
