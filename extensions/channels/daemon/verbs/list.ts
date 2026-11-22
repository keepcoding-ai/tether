// `channels list`: the channels I am in (and, with `all`, the open ones I am not); the way to find my way again after compacting.
import { roleIn } from '../../rules.ts'
import { me, optFlag, ownerRow, ok, type VerbDef } from './common.ts'

export const listVerb: VerbDef = {
  name: 'list',
  description: 'List the channels you are in: id, name, owner, your role, who spoke last. `all` adds the open channels you are not in; `closed` adds the closed ones. Run it to find your way again after compacting.',
  help: 'Lista os canais em que você está (all: também os abertos em que não está; closed: também os encerrados).',
  input: { type: 'object', properties: { all: { type: 'boolean' }, closed: { type: 'boolean' } } },
  async run(deps, caller, args) {
    const all = optFlag(args, 'all')
    const closed = optFlag(args, 'closed')
    const store = deps.channels.store
    const pool = all ? store.channels() : store.channelsOf(caller.slotId)
    const rows = await Promise.all(pool.filter((ch) => closed || !ch.closed).map(async (ch) => {
      const last = (await store.history(ch.id, undefined, 1))[0]
      const mine = ch.members[caller.slotId]
      return {
        id: ch.id, name: ch.name, title: ch.title,
        ...(ch.desk !== undefined ? { desk: ch.desk } : {}),
        owner: ownerRow(deps, ch),
        role: roleIn(caller.slotId, ch) as 'owner' | 'member' | undefined,
        muted: mine?.muted !== undefined,
        members: Object.keys(ch.members).length,
        ...(last ? { last: { seq: last.seq, at: last.at, from: last.from.name } } : {}),
        ...(mine ? { since: mine.since } : {}),
        ...(ch.closed ? { closed: ch.closed.at } : {}),
      }
    }))
    rows.sort((a, b) => (b.last?.at ?? '').localeCompare(a.last?.at ?? ''))
    const text = rows.length === 0
      ? 'Nenhum canal.'
      : rows.map((r) => `#${r.name} (${r.id}) ${r.role ?? 'fora'}${r.closed ? ', encerrado' : ''}${r.muted ? ', calado' : ''}, ${r.members} membro(s); dono ${r.owner.name}`).join('\n')
    return ok(text, { me: me(deps, caller), channels: rows })
  },
}
