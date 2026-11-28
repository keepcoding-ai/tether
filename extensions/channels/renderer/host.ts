// What the channel's view (channel-pane.ts) asks of where it runs. The view is DOM over this host and nothing else: it knows
// neither the app's `TetherUi` nor the dockview. Two hosts exist: the app's (local-panes.ts, which wraps `TetherUi`, the
// extension's ipc and the marks) and the remote web client's (remote/web/src/host.ts: the same view over the relay, reading
// only). The names of the members follow the app's own (`ui.links.follow`, `ui.panes.peek`...), so the app's host is a
// pass-through and the view behaves as it always did.
import type { ContextMenuEntry, PaneEmblem } from '../../../app/renderer/ext-api.ts'
import type { DialogAnswer, DialogSpec } from '../../../app/shared/dialog.ts'
import type { LinkTarget } from '../../../app/shared/links.ts'
import type { ChannelSummary } from '../daemon/requests.ts'
import type { FileLook, FileView } from '../ipc.ts'
import type { ChannelMarks, PollOwed } from '../mark-board.ts'
import type { Ask } from '../rules.ts'
import type { AttachDeps } from './attach-box.ts'
import type { ViewerTexts } from './viewer.ts'

export interface HostDisposable { dispose(): void }

/** How a followed link opens (the app's LinkOrigin, the part the view uses). */
export interface FollowOptions { side?: boolean; peek?: boolean }

/** The marks of the channels, the part the view reads and tells (marks.ts `Marks` satisfies it). */
export interface ChannelHostMarks {
  of(channelId: string): ChannelMarks
  asksOf(channelId: string): Ask[]
  owedOf(channelId: string): PollOwed[]
  /** The view shows the end of the conversation to the person: up to `seq` is seen. */
  viewed(channelId: string, seq: number): void
  /** The view has the speech an ask is on in view: it asks no more. */
  attended(channelId: string, seq: number): void
  /** A channel's view appeared or went. */
  paneChanged(channelId: string): void
  onDidChange(listener: () => void): HostDisposable
}

/** The files of the speeches and of the speaking box (the app's main process looks at the disk; the remote has none). */
export interface ChannelHostFiles extends AttachDeps {
  look(paths: string[]): Promise<FileLook[]>
  view(path: string): Promise<FileView>
  /** The image viewer in the host's words (the remote's "open" downloads, and it has no file menu). Absent: the app's. */
  readonly viewer?: ViewerTexts
}

/** The key table, the part the view reads (the label of the key a command is bound to). */
export interface HostKeyTable {
  bindingsOf(command: string): readonly unknown[]
  hint(command: string): string
}

export interface ChannelHost {
  /**
   * The view only reads (the remote, while it has no speaking): no speaking box (a calm line says where to answer), no
   * reaction, vote, menu or gesture on a member, and nothing is told as seen.
   */
  readonly readOnly?: boolean
  /**
   * The view converses and manages nothing (the remote of a device that may speak): the speaking box (no files), reactions,
   * votes, opening a poll and "seen" are on; joining, muting, taking out, closing or reopening the channel, closing a poll
   * early, the channel's menu and the menus of a member are away, and an agent's name only peeks. Ignored with `readOnly`.
   */
  readonly talkOnly?: boolean
  /**
   * With `talkOnly`: the view also attaches files, by the host's own `files` (the remote's picker and uploads, within the
   * `limits` its `files` gives). Absent: a view that only converses has no clip.
   */
  readonly attachTalk?: boolean
  /**
   * With `talkOnly`: the view also manages the channel from afar, by `run` (the commands' ids and arguments), `ask` and
   * `request('poll-close')`: calling, muting and giving the voice back, taking out, reopening, closing a poll early, the
   * channel's menu and the menus of a member, and closing the channel while `close` says so. What goes to a tab stays away
   * (an agent's name still peeks; no "Ir até a guia", emblem, link, "Abrir como guia"). Read at every paint: undefined, the
   * view only converses. Ignored without `talkOnly` (the app manages it all).
   */
  manageAfar?(): { close: boolean } | undefined
  /** A request to the channels' daemon half (`history`, `members`, `say`...). */
  request<T>(name: string, args?: Record<string, unknown>): Promise<T>
  /** The daemon half's events (`line`, `channel`, `reaction`, `poll`). */
  onEvent<T>(name: string, listener: (ev: T) => void): HostDisposable
  readonly marks: ChannelHostMarks
  /** The channels known, open and closed. */
  channels(): readonly ChannelSummary[]
  /** An agent by its slot id: its engine, and whether a pane shows it (`placed: false`: its name peeks instead of going to a tab). */
  agent(id: string): { kind: string; placed?: boolean } | undefined
  /** The emblem the person put on the agent's tab. */
  personEmblem(id: string): PaneEmblem | undefined
  /** An emblem changed (undefined: the library did). */
  onDidChangeEmblems(listener: (paneId: string | undefined) => void): HostDisposable
  /** The person's name in the channels (the setting `moderatorName`; undefined: the default). */
  moderatorName(): string | undefined
  readonly files: ChannelHostFiles
  /** Follows a link the way the app does. */
  follow(target: LinkTarget, opts?: FollowOptions): void
  /** The right-click menu of a link at page coordinates. */
  linkMenu(x: number, y: number, target: LinkTarget): void
  /** A floating context menu at page coordinates. */
  menu(x: number, y: number, entries: ContextMenuEntry[]): void
  ask(spec: DialogSpec): Promise<DialogAnswer>
  /** Runs a command of the app by its id. */
  run(command: string, args?: unknown): Promise<unknown>
  /** The quick view of a pane. */
  peek(paneId: string): void
  copyLink(paneId: string): void
  emblemMenu(paneId: string, x: number, y: number): void
  movePane(paneId: string): void
  closePane(paneId: string): void
  /** The menu of the channel's tab (a view that is a tab of the app). */
  tabMenu(paneId: string, x: number, y: number, opener?: HTMLElement): void
  writeClipboard(text: string): void
  keyTable(): HostKeyTable
}

/**
 * Where a channel's view lives: a tab (`pane`: its title is the tab's) or embedded in another surface (`embed`: no tab title
 * to set, its menu has no "Fechar painel", "Mover" nor the pane's link).
 */
export interface ChannelFrame {
  readonly kind: 'pane' | 'embed'
  /** The pane id the core knows the channel by (`channel:<id>`), for both kinds. */
  readonly id: string
  title(): string | undefined
  setTitle(title: string): void
  showMenu(x: number, y: number, opener?: HTMLElement): void
}

/** The tab the view is the content of, as much as the view uses of it (dockview's panel api satisfies it). */
export interface ChannelTabApi {
  readonly id: string
  readonly title: string | undefined
  setTitle(title: string): void
}
