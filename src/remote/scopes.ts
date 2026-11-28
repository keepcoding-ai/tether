// The one table of remote operations (fio-spec 7.2, plano §2 "Escopos"): every request type of the remote protocol, with the
// scope a device needs, its presence class (7.3), whether it changes state, whether it is a gesture (E-11), the strict keys
// of its body and the pipe messages it may emit. The portal's gate decides by this table alone, by the 16-bit `op`, before
// the body is parsed. An `op` without a line is refused (0x02).
//
// Totality is a compile error, not a convention: OP_CODES is the protocol (the codes the wire carries) and OP_TABLE must
// have a line for each of its names (`satisfies` a mapped type), so a code added without a line, or a line without a
// declared scope, does not compile; test/unit/remote.scopes.test.ts checks the same at run time. The events (house →
// device) have their own table under the same rule. Pure: no node:*, no DOM.

/** The scope families a device may hold (plano §2). All on at pairing, adjustable on the machine. */
export const SCOPE_FAMILIES = [
  'attention', 'channels', 'regency:read', 'manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive',
  'peek:terminal:read', 'peek:terminal:write', 'peek:browser',
] as const
export type ScopeFamily = (typeof SCOPE_FAMILIES)[number]

/** The scope of a line. `session` is the family every session has: what remains when the session is locked. */
export type OpScope = 'session' | ScopeFamily

/** Presence classes (spec 7.3). `fresh-pair`: only in the session that concluded the pairing (7.4 point 1). */
export type PresenceClass = 'none' | 'unlocked' | 'window' | 'per-act' | 'fresh-pair'

/** The scopes each range of `op` may use (spec 7.2): 0x00 session, 0x01 attention, 0x02 channels, 0x03 regency, 0x04 management, 0x05 peek, 0x06 devices. */
export const RANGE_SCOPES: Readonly<Record<number, readonly OpScope[]>> = {
  0x00: ['session'],
  0x01: ['attention'],
  // Closing a channel from afar destroys (RR5): it reuses manage:destructive, as the devices' range does.
  0x02: ['channels', 'manage:destructive'],
  0x03: ['regency:read'],
  0x04: ['manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive'],
  0x05: ['peek:terminal:read', 'peek:terminal:write', 'peek:browser'],
  // The devices reuse manage:destructive (spec 7.2): the wire fixes the code and the presence class, not this scope.
  0x06: ['manage:destructive'],
}

/** The request types of the remote protocol: name → 16-bit `op`. A name here needs a line in OP_TABLE to compile. */
export const OP_CODES = {
  'session.info': 0x0001,
  'admit.renew': 0x0002,
  'uv.challenge': 0x0003,
  'uv.assert': 0x0004,
  'uv.register': 0x0005,
  'device.revoke-self': 0x0006,
  'session.lock': 0x0007,
  'house.key-rotate.ack': 0x0008,
  'session.visible': 0x0009,
  'attention.list': 0x0100,
  'attention.watch': 0x0101,
  'attention.push-key': 0x0102,
  'attention.push-on': 0x0103,
  'attention.push-off': 0x0104,
  'channels.marks': 0x0200,
  'channels.page': 0x0201,
  'channels.say': 0x0202,
  'channels.react': 0x0203,
  'channels.vote': 0x0204,
  'channels.poll': 0x0205,
  'channels.seen': 0x0206,
  'channels.file': 0x0207,
  'channels.upload': 0x0208,
  'channels.upload-cancel': 0x0209,
  // Managing a channel from afar (RR5, fio-spec 18): the person as she manages it in the app.
  'channels.create': 0x020a,
  'channels.join': 0x020b,
  'channels.remove': 0x020c,
  'channels.mute': 0x020d,
  'channels.unmute': 0x020e,
  'channels.close': 0x020f,
  'channels.reopen': 0x0210,
  'channels.poll-close': 0x0211,
  'regency.tree': 0x0300,
  // Management (RR5 5.2, fio-spec 16): direct acts on tetherd, each one pipe message of its own.
  'agents.stop': 0x0400,
  'agents.start': 0x0401,
  'agents.restart': 0x0402,
  'agents.rename': 0x0403,
  'agents.forget': 0x0404,
  'ronda.get': 0x0410,
  'ronda.set': 0x0411,
  'ronda.off': 0x0412,
  'procs.list': 0x0420,
  'procs.info': 0x0421,
  'procs.start': 0x0422,
  'procs.stop': 0x0423,
  'procs.stop-force': 0x0424,
  'procs.restart': 0x0425,
  'procs.restart-force': 0x0426,
  'procs.use': 0x0427,
  'procs.release': 0x0428,
  'procs.forget': 0x0429,
  'procs.forget-force': 0x042a,
  // "Novo processo" from afar (RR5 5.5, fio-spec 18): a recipe of the person's, its env by name and value, never echoed.
  'procs.new': 0x042b,
  // The gestures only the app knows (RR5 5.1, fio-spec 17): through tetherd to the app's bridge, `regency/act`.
  'desks.hibernate': 0x0430,
  'desks.wake': 0x0431,
  'desks.create': 0x0432,
  'desks.rename': 0x0433,
  'desks.color': 0x0434,
  'desks.close': 0x0435,
  'panes.hibernate': 0x0440,
  'panes.wake': 0x0441,
  'panes.suspend': 0x0442,
  'panes.move': 0x0443,
  'panes.close': 0x0444,
  'closed.reopen': 0x0448,
  'closed.forget': 0x0449,
  'owners.give': 0x0450,
  'owners.revoke': 0x0451,
  'owners.take': 0x0452,
  'owners.return': 0x0453,
  // "+ Novo" from afar (RR5 5.3, fio-spec 18): the choices, then an agent or a terminal (tetherd alone), a note or a tab (the app).
  'create.options': 0x0460,
  'create.agent': 0x0461,
  'create.terminal': 0x0462,
  'create.note': 0x0463,
  'create.browser': 0x0464,
  'device.list': 0x0600,
  'device.revoke': 0x0601,
} as const
export type OpName = keyof typeof OP_CODES

export interface OpRule {
  /** Required: a line without a declared scope does not compile. */
  readonly scope: OpScope
  readonly presence: PresenceClass
  /** A line that changes state must come with an `actId` (rule 7). */
  readonly mutates: boolean
  /** Only a line triggered by the person's input resets the idle clock (rule 8, E-11). Decided here, not by the PWA. */
  readonly gesture: boolean
  /** Declared exception to E-8 (Q19): allowed to a device without a presence credential although it changes state. */
  readonly allowedWithoutCredential?: boolean
  /** The strict keys of the body: any other key is refused (0x01). Absent while the op has no handler (answered `not-implemented`). */
  readonly body?: readonly string[]
  /** The request types of the pipe this op may send to tetherd (rule 2). The portal never forwards a pipe object whole. */
  readonly pipe: readonly string[]
}

/** The table. Read it with `opByCode`; OPS is the same table as rows. */
export const OP_TABLE = {
  'session.info': { scope: 'session', presence: 'none', mutates: false, gesture: false, body: [], pipe: [] },
  'admit.renew': { scope: 'session', presence: 'none', mutates: true, gesture: false, body: ['pubA'], pipe: [] },
  'uv.challenge': { scope: 'session', presence: 'none', mutates: false, gesture: false, body: ['purpose', 'op'], pipe: [] },
  'uv.assert': { scope: 'session', presence: 'none', mutates: true, gesture: true, body: [], pipe: [] },
  'uv.register': { scope: 'session', presence: 'fresh-pair', mutates: true, gesture: true, body: ['clientDataJSON', 'attestationObject'], pipe: [] },
  'device.revoke-self': { scope: 'session', presence: 'none', mutates: true, gesture: true, body: [], pipe: [] },
  'session.lock': { scope: 'session', presence: 'none', mutates: true, gesture: true, body: [], pipe: [] },
  'house.key-rotate.ack': { scope: 'session', presence: 'unlocked', mutates: true, gesture: false, allowedWithoutCredential: true, pipe: [] },
  'attention.list': { scope: 'attention', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: [] },
  'attention.watch': { scope: 'attention', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: [] },
  // Web Push (step 4.4, fio-spec 15). Whether the page is on the person's screen now: the portal does not push to a device
  // that has a session live and visible. A hint kept in the session's memory only (like attention.watch), so no state of
  // the house changes and no actId; any session may say it, the locked one too (the person is in front of it all the same).
  'session.visible': { scope: 'session', presence: 'none', mutates: false, gesture: false, body: ['visible'], pipe: [] },
  // The house's VAPID public key (K_V, RFC 8292), which the browser needs to subscribe, and whether this device is subscribed.
  'attention.push-key': { scope: 'attention', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: [] },
  // The device's subscription (PushSubscription.toJSON): kept by the registry's writer, one per device. The endpoint comes
  // from outside: the portal takes only a public push service of the list (src/remote/webpush.ts pushEndpointCheck, M-11).
  'attention.push-on': { scope: 'attention', presence: 'unlocked', mutates: true, gesture: true, body: ['endpoint', 'p256dh', 'auth'], pipe: [] },
  // The device turns its notices off: the subscription goes.
  'attention.push-off': { scope: 'attention', presence: 'unlocked', mutates: true, gesture: true, body: [], pipe: [] },
  // The three reads of an extension (step 3.4a): each reaches the pipe as the ONE `ext-request` its pair names in
  // src/remoted/reach.ts EXT_READS (a closed list by op), never as a request the device spells.
  // The channels' marks as tetherd computes them (ext `channels`, `marks`).
  'channels.marks': { scope: 'channels', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: ['ext-request'] },
  // One page of a channel, the latest or the one before a cursor (ext `channels`, `history`).
  'channels.page': { scope: 'channels', presence: 'unlocked', mutates: false, gesture: false, body: ['channel', 'before', 'limit'], pipe: ['ext-request'] },
  // The person talks from afar (step 4.2a): each line reaches the pipe as the ONE `ext-request` its pair names in
  // src/remoted/reach.ts EXT_WRITES, the person as moderator (extensions/channels/daemon/requests.ts gate `person`). Class
  // `unlocked` (fio-spec 7.3: "ler, conversar, reagir, votar"), so a device without a presence credential gets 0x05 (E-8).
  // The bodies are checked field by field by src/remote/talk.ts before the pipe. A speech's `files` are the indexes of
  // the files uploaded under its own actId (`channels.upload`, step 4.3): the portal gives tetherd their paths, never the device.
  // A speech, to every member of the channel (`to`: the names it is addressed to, an address, not a filter).
  'channels.say': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'text', 'to', 'files'], pipe: ['ext-request'] },
  // A reaction on one message, added or (`remove: true`) taken back: explicit, so a repeat changes nothing.
  'channels.react': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'seq', 'reaction', 'remove'], pipe: ['ext-request'] },
  // The person's vote on a poll that calls her, by the option's number.
  'channels.vote': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'poll', 'vote', 'reason'], pipe: ['ext-request'] },
  // A poll the person opens.
  'channels.poll': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'question', 'options', 'to', 'timeoutMs'], pipe: ['ext-request'] },
  // The person saw a channel up to `seq`. It changes state (her marks, on every screen), so it needs an actId and a
  // credential; it is NO gesture: the screen sends it on its own when lines come into view, and a phone left open on a
  // channel that keeps talking must still lock when idle (E-11).
  'channels.seen': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: false, body: ['channel', 'seq'], pipe: ['ext-request'] },
  // The files of a speech from afar (step 4.3; src/remote/files.ts, src/remoted/files.ts). A device names a file by the line
  // and its index on it, never by a path: the portal finds the path on the line tetherd keeps (EXT_READS `history`) and gives
  // only a file that lives inside that channel's folder. One chunk per request; the chunk ops count against the device's
  // bytes of files a minute, not its requests.
  'channels.file': { scope: 'channels', presence: 'unlocked', mutates: false, gesture: false, body: ['channel', 'seq', 'file', 'offset'], pipe: ['ext-request'] },
  // One chunk of a file of a speech still to be said, under that speech's actId (`act`). The portal writes it to a temporary
  // file in the channel's folder; nothing reaches tetherd until the speech (`channels.say` with `files`). No gesture: the
  // speech is.
  'channels.upload': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: false, body: ['channel', 'act', 'file', 'name', 'size', 'offset', 'data'], pipe: [] },
  // The person gives up a file (or all) of a speech still to be said: its temporary files go.
  'channels.upload-cancel': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['act', 'file'], pipe: [] },
  // Managing a channel from afar (RR5, fio-spec 18): each line reaches the pipe as the ONE `ext-request` its pair names in
  // EXT_WRITES, the person managing (extensions/channels/daemon/requests.ts gate `manager`, which takes `app` and `remote`),
  // and from afar the system line that says who did it carries the mark "(de longe)". The light acts are of the channels'
  // scope, unlocked; closing a channel ends it for every member, so it is `manage:destructive` with a proof per act.
  // Reopening only gives back what closing took, as `owners.revoke` only lowers: unlocked. Agents and the channel by id.
  'channels.create': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['name'], pipe: ['ext-request'] },
  'channels.join': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'agent'], pipe: ['ext-request'] },
  'channels.remove': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'agent'], pipe: ['ext-request'] },
  'channels.mute': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'agent'], pipe: ['ext-request'] },
  'channels.unmute': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'agent'], pipe: ['ext-request'] },
  'channels.close': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['channel'], pipe: ['ext-request'] },
  'channels.reopen': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel'], pipe: ['ext-request'] },
  'channels.poll-close': { scope: 'channels', presence: 'unlocked', mutates: true, gesture: true, body: ['channel', 'poll'], pipe: ['ext-request'] },
  // The Regency's tree as tetherd keeps it (ext `regency`, `tree.read`).
  'regency.tree': { scope: 'regency:read', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: ['ext-request'] },
  // Management from afar (RR5 5.2, fio-spec 16). Each line sends tetherd the ONE pipe message of its `pipe`, built by
  // src/remote/manage.ts from the checked body, and tetherd takes from a `remote` client only the keys and values
  // src/remoted/reach.ts REMOTE_ACT_ARGS lists for that type (never `by`, a recipe or a wait). The target is named by its
  // real id (a slot's, a process's) and resolved by tetherd; a stale id is 0x06. What destroys (forgetting a slot or a
  // process) is `manage:destructive` with a proof per act; forcing over another's use is an op of its own, with a reason.
  // A slot: stop (its intent becomes `ended`), start or resume, restart in place, rename; forget is destructive.
  'agents.stop': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId'], pipe: ['stop'] },
  'agents.start': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId', 'choice'], pipe: ['start'] },
  'agents.restart': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId'], pipe: ['restart'] },
  'agents.rename': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId', 'name'], pipe: ['rename-slot'] },
  'agents.forget': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['slotId'], pipe: ['forget'] },
  // A slot's ronda: see it, switch it on or reassemble it, switch it off (always forced, as the app does).
  'ronda.get': { scope: 'manage:agents', presence: 'unlocked', mutates: false, gesture: false, body: ['slotId'], pipe: ['ronda-get'] },
  'ronda.set': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId', 'interval', 'nudge', 'criterion'], pipe: ['ronda-set'] },
  'ronda.off': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId'], pipe: ['ronda-off'] },
  // The background processes: list and see (src/remote/projection.ts remoteProc: env by names only), start the stored recipe
  // (a new recipe is step 5.5), stop, restart, hold and let go; refused "in use" comes back with who, until when and what
  // for, and going ahead anyway is the `-force` op with a reason. Forgetting is destructive.
  'procs.list': { scope: 'manage:procs', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: ['proc-list'] },
  'procs.info': { scope: 'manage:procs', presence: 'unlocked', mutates: false, gesture: false, body: ['name'], pipe: ['proc-info'] },
  'procs.start': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name'], pipe: ['proc-start'] },
  'procs.stop': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'reason'], pipe: ['proc-stop', 'proc-info'] },
  'procs.stop-force': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'reason'], pipe: ['proc-stop'] },
  'procs.restart': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'reason'], pipe: ['proc-restart', 'proc-info'] },
  'procs.restart-force': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'reason'], pipe: ['proc-restart'] },
  'procs.use': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'duration', 'purpose'], pipe: ['proc-use'] },
  'procs.release': { scope: 'manage:procs', presence: 'unlocked', mutates: true, gesture: true, body: ['name'], pipe: ['proc-release'] },
  'procs.forget': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['name'], pipe: ['proc-forget', 'proc-info'] },
  'procs.forget-force': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['name', 'reason'], pipe: ['proc-forget'] },
  // "Novo processo" (RR5 5.5; src/remote/procs-new.ts): the command as the person types it, a folder of the known list by its
  // id (resolved by the portal from tetherd's `create.options`, never a path from the device), ports, a description and
  // variables. It runs a command on the machine: a proof per act. A name or a value that looks like a secret, or a command
  // that carries one, is refused (no "anyway" from afar); a value never comes back, nor goes to the audit, a log or the
  // actId's cache. Only a name no process has (`proc-info` first): from afar a recipe never replaces another.
  'procs.new': { scope: 'manage:procs', presence: 'per-act', mutates: true, gesture: true, body: ['name', 'command', 'folder', 'ports', 'description', 'env'], pipe: ['proc-info', 'proc-start'] },
  // The gestures only the app knows how to do (RR5 5.1, fio-spec 17). Each reaches tetherd as the ONE `ext-request` of
  // EXT_WRITES (`regency/act`) with its act's name and fields (src/remote/app-acts.ts, the closed list tetherd takes field by
  // field); tetherd confers what it can alone (the desk, the pane in that desk, the slot, the person typing there), refuses
  // `no-app` at once when no app holds the tree's lease, and hands the act to the app, which does it as its own gesture with
  // no dialog and without changing the desk in view. Targets by their real ids; the pane with the desk the device saw it in.
  // A desk: hibernate and wake, create (a name, a colour), rename, recolour; closing it is destructive (its panes go to the
  // neighbour, or stop and close).
  'desks.hibernate': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId'], pipe: ['ext-request'] },
  'desks.wake': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId'], pipe: ['ext-request'] },
  'desks.create': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['name', 'color'], pipe: ['ext-request'] },
  'desks.rename': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'name'], pipe: ['ext-request'] },
  'desks.color': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'color'], pipe: ['ext-request'] },
  'desks.close': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['deskId', 'panes'], pipe: ['ext-request'] },
  // A pane: hibernate, wake (the slot's start, which tetherd does alone), suspend, move to another desk; closing it is
  // destructive (the agent keeps running without a pane, or stops).
  'panes.hibernate': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  'panes.wake': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  'panes.suspend': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  'panes.move': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId', 'to'], pipe: ['ext-request'] },
  'panes.close': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['deskId', 'paneId', 'process'], pipe: ['ext-request'] },
  // "Fechadas": a closed session reopened on a desk; forgetting it is destructive.
  'closed.reopen': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['slotId', 'deskId'], pipe: ['ext-request'] },
  'closed.forget': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['slotId'], pipe: ['ext-request'] },
  // The agents' ownership, the app's own writes (for-agents' gestures, never `object-set` from the portal). Giving a desk or a
  // pane to an agent, and giving the command back, widen an agent's power: the elevation window (7.3). Taking it away
  // ("Tirar a mesa de <nome>") and "Assumir o comando" only lower it: unlocked.
  'owners.give': { scope: 'manage:agents', presence: 'window', mutates: true, gesture: true, body: ['deskId', 'paneId', 'to'], pipe: ['ext-request'] },
  'owners.revoke': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  'owners.take': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  'owners.return': { scope: 'manage:agents', presence: 'window', mutates: true, gesture: true, body: ['deskId', 'paneId'], pipe: ['ext-request'] },
  // "+ Novo" from afar (RR5 5.3; src/remote/create.ts). The choices: engines, profiles by name (never their env), queue desks
  // and the known folders by id and label (ext `regency`, `create.options`). An agent or a terminal born in a desk, which
  // tetherd creates alone (ext `regency`, `create`: it resolves the folder id, the profile's name and the desk itself); a note
  // in a known folder and a browser tab of the person's, which only the app makes (the bridge of acts, `regency/act`, with
  // `no-app`). The agent is of `manage:agents`, the rest of `manage:desks`.
  'create.options': { scope: 'manage:desks', presence: 'unlocked', mutates: false, gesture: false, body: [], pipe: ['ext-request'] },
  'create.agent': { scope: 'manage:agents', presence: 'unlocked', mutates: true, gesture: true, body: ['engine', 'profile', 'deskId', 'folder', 'name'], pipe: ['ext-request'] },
  'create.terminal': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['profile', 'deskId', 'folder', 'name'], pipe: ['ext-request'] },
  'create.note': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId', 'folder'], pipe: ['ext-request'] },
  'create.browser': { scope: 'manage:desks', presence: 'unlocked', mutates: true, gesture: true, body: ['deskId'], pipe: ['ext-request'] },
  'device.list': { scope: 'manage:destructive', presence: 'unlocked', mutates: false, gesture: false, pipe: [] },
  'device.revoke': { scope: 'manage:destructive', presence: 'per-act', mutates: true, gesture: true, body: ['deviceId'], pipe: [] },
} as const satisfies { readonly [K in OpName]: OpRule }

/** One row of the table: its code, its name and its rule. */
export type OpLine = OpRule & { readonly code: number; readonly name: OpName }

const OP_NAMES = Object.keys(OP_CODES) as OpName[]

/** The table as rows, in code order. */
export const OPS: readonly OpLine[] = OP_NAMES.map((name): OpLine => ({ code: OP_CODES[name], name, ...OP_TABLE[name] }))

const BY_CODE = new Map<number, OpLine>(OPS.map(l => [l.code, l]))
const BY_NAME = new Map<string, OpLine>(OPS.map(l => [l.name, l]))

/** The line of an `op`, or undefined: an `op` without a line is answered with status 0x02 (rule 3). */
export const opByCode = (code: number): OpLine | undefined => BY_CODE.get(code)
export const opByName = (name: string): OpLine | undefined => BY_NAME.get(name)

/** An event (house → device, rule 6): like an operation, it has a line with the scope and the presence a device needs to get it. */
export interface EvtLine {
  readonly code: number
  readonly name: string
  readonly scope: OpScope
  /** The presence the session must have for the event to go: a locked session keeps only the session family (7.3). */
  readonly presence: 'none' | 'unlocked'
}

/** Events fixed in this version. The portal emits one only to a session whose device has its scope and presence. */
export const EVT = {
  attentionChanged: { code: 0x0100, name: 'attention.changed', scope: 'attention', presence: 'unlocked' },
  // Thin notices (step 3.4a): which channels changed, and that the Regency's tree changed. No content: the device reads again.
  channelsChanged: { code: 0x0200, name: 'channels.changed', scope: 'channels', presence: 'unlocked' },
  regencyChanged: { code: 0x0300, name: 'regency.changed', scope: 'regency:read', presence: 'unlocked' },
} as const satisfies Record<string, EvtLine>
export type EvtName = (typeof EVT)[keyof typeof EVT]['name']

const EVT_BY_CODE = new Map<number, EvtLine>(Object.values(EVT).map(l => [l.code, l]))

/** The line of an event code, or undefined for an event this version does not know. */
export const evtByCode = (code: number): EvtLine | undefined => EVT_BY_CODE.get(code)

/** Only these scopes are kept from the registry's list (an unknown string grants nothing and never reaches a device). */
export function knownScopes(scopes: readonly unknown[]): ScopeFamily[] {
  return SCOPE_FAMILIES.filter(s => scopes.includes(s))
}
