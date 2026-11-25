// The verbs of the `channels` namespace (contract 3): what an agent does in channels. Each verb is a file of verbs/; this
// registers them with the door (`verbs.register`, both exits: MCP tool `mcp__tether__channels_<name>` and CLI
// `tether channels <name>`), wraps each in the shared handling and adds the paragraph of the server's instructions.
//
// The shared handling: an error thrown below a verb (a `VerbError`: anything with a `code`) is the verb's error result, the same
// on both exits; a call whose caller did not prove its identity (`caller.proven === false`, B4) runs the same and leaves marked
// `proven: false` in its data and text; nothing is refused for want of proof.
//
// Wiring in daemon.ts, one line over `channels.ready`:   `...registerVerbs(api, channels.ready)`
import type { IDisposable } from '../../../app/shared/vscode-lifecycle.ts'
import type { VerbCaller, VerbResult } from '../../../src/daemon/ext-api.ts'
import { VERB_NS } from '../manifest.ts'
import type { Channels } from './fanout.ts'
import { claudeToolName } from './notices.ts'
import { closeVerb } from './verbs/close.ts'
import { failOf, type VerbApi, type VerbDef, type VerbDeps } from './verbs/common.ts'
import { createVerb } from './verbs/create.ts'
import { joinVerb } from './verbs/join.ts'
import { leaveVerb } from './verbs/leave.ts'
import { listVerb } from './verbs/list.ts'
import { membersVerb } from './verbs/members.ts'
import { muteVerb } from './verbs/mute.ts'
import { pollCloseVerb } from './verbs/poll-close.ts'
import { pollVerb } from './verbs/poll.ts'
import { voteVerb } from './verbs/vote.ts'
import { reactVerb } from './verbs/react.ts'
import { readVerb } from './verbs/read.ts'
import { removeVerb } from './verbs/remove.ts'
import { reopenVerb } from './verbs/reopen.ts'
import { sayVerb } from './verbs/say.ts'
import { unmuteVerb } from './verbs/unmute.ts'

/** The verbs: those of the contract's table 3.1, then `reopen` (C7), `react` and the poll's three. */
export const CHANNEL_VERBS: readonly VerbDef[] = [
  listVerb, createVerb, membersVerb, readVerb, closeVerb, reopenVerb,
  joinVerb, leaveVerb, removeVerb, muteVerb, unmuteVerb, sayVerb, reactVerb, pollVerb, voteVerb, pollCloseVerb,
]

const TOOLS = ['say', 'list', 'read'].map((v) => `\`${claudeToolName(v)}\``).join(', ')

/** The reactions, in the fewest words: every agent pays for each one in every session. */
export const REACTIONS_TEXT = 'A reaction (`channels_react` on a line\'s `seq`) is a light signal that opens no turn in anyone: 👀 `seen`, 👍 `agree`, ✅ `done`, ❌ `disagree`, ❓ `question`; any other emoji has no agreed meaning. React when a signal is enough and nobody owes you an answer; speak when you need one. Reactions to your lines come in the `reactions` attribute of your next message from that room (and in `channels_read`); answer a ❓ or ❌ when you next speak there, if it still matters.'

/** The polls, as short: how to open one, how to answer one, and that a vote is not speech. */
export const POLLS_TEXT = 'Open a poll (`channels_poll`) when you need each member\'s answer by a deadline. One reaches you as `kind="request"` with `ref`, `options` and `closes`: answer ONLY with `channels_vote` (`poll` is the number after `#` in `ref`; the option\'s number; a short `reason` for a no). A vote opens no turn and is not speech: do not also say it in the channel. Vote what you owe before opening a poll. Its author gets the result once, when it closes.'

export const INSTRUCTIONS ='You may be in channels of the tether: rooms where agents of any engine and the person talk. Messages reach you as `<channel source="tether" origin="channels" room="…" …>`; `room` is the channel, `from` and `role` who spoke, `to` whom it addresses: `to` with your name there (shown when you enter and in `channels_list`) is for you; a line to another name is information. Speak with `channels_say` naming the room. What you write in your own turn does NOT go to the channel and nobody there sees it: to answer a message, call `channels_say` with the `room` of that message. `channels_list` shows your channels and how to find your way again after compacting; `channels_read` shows what you missed. ' + REACTIONS_TEXT + ' ' + POLLS_TEXT + ' A muted member still hears. `role="moderator"` is the person; the owner of a channel speaks as a member. These are the `channels_say`, `channels_list` and `channels_read` tools of this server (in Claude Code: ' + TOOLS + '). These tools may be deferred: if one is not loaded, load it with your tool search before concluding it does not exist.'

const NOT_PROVEN_CALLER = 'chamador sem prova de identidade'

/** A call that came without the proof of identity runs and leaves marked, in the data, the text and the log. */
function mark(r: VerbResult, caller: VerbCaller, name: string, log: (m: string) => void): VerbResult {
  if (caller.proven) return r
  log(`channels ${name} chamado por ${caller.slotId} sem prova de identidade (${caller.via})`)
  const data = typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? r.data : {}
  return { ...r, text: `${r.text} (${NOT_PROVEN_CALLER})`, data: { ...data, proven: false } }
}

/** Registers at once (the tools exist from the first `initialize`); a call waits for the record to open, which `ready` says. */
export function registerVerbs(api: VerbApi, ready: Promise<Channels>): IDisposable[] {
  const out: IDisposable[] = []
  for (const def of CHANNEL_VERBS) {
    out.push(api.verbs.register({
      ns: VERB_NS, name: def.name, description: def.description, help: def.help, input: def.input,
      ...(def.positional ? { positional: def.positional } : {}),
      run: async (caller, args) => {
        let r: VerbResult
        try {
          const deps: VerbDeps = { api, channels: await ready }
          r = await def.run(deps, caller, args)
        } catch (e) { r = failOf(e); if ((r.data as { error?: string }).error === 'internal') api.log(`channels ${def.name}: ${(e as Error).stack ?? (e as Error).message}`) }
        return mark(r, caller, def.name, (m) => api.log(m))
      },
    }))
  }
  out.push(api.verbs.instructions(INSTRUCTIONS))
  return out
}
