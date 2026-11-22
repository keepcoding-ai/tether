// `channels create`: a channel I own. Each of `members` joins as in `join` by the owner; the ones that fail go in `failed` and
// the channel is born anyway.
import { refOf, ok, optString, optStrings, resolveAgent, settle, wantString, type VerbDef } from './common.ts'

export const createVerb: VerbDef = {
  name: 'create',
  description: 'Create a channel you own and join it. `name`: lowercase letters, digits and hyphens (1 to 40), unique among the open channels. `members`: agents to join at once (slot ids or pane names); one that fails is reported in `failed` and the channel is created anyway.',
  help: 'Cria um canal de que você é dono (--title, --members A --members B).',
  input: {
    type: 'object',
    properties: { name: { type: 'string' }, title: { type: 'string' }, members: { type: 'array', items: { type: 'string' } } },
    required: ['name'],
  },
  positional: ['name'],
  async run(deps, caller, args) {
    const name = wantString(args, 'name')
    const title = optString(args, 'title')
    const members = optStrings(args, 'members') ?? []
    const made = settle(await deps.channels.create(caller.slotId, { name, ...(title !== undefined ? { title } : {}) }))
    const joined: { id: string; name: string }[] = []
    const failed: { agent: string; error: string }[] = []
    for (const ref of members) {
      try {
        const id = resolveAgent(deps, ref)
        const r = await deps.channels.join(caller.slotId, made.channel.id, id)
        if (!r.ok) { failed.push({ agent: ref, error: r.error }); continue }
        joined.push({ id, name: deps.channels.nameOf(id) })
      } catch (e) {
        failed.push({ agent: ref, error: (e as { code?: string }).code ?? 'internal' })
      }
    }
    const text = `Canal #${made.channel.name} criado.${joined.length ? ` Juntou: ${joined.map((j) => j.name).join(', ')}.` : ''}${failed.length ? ` Falhou: ${failed.map((f) => `${f.agent} (${f.error})`).join(', ')}.` : ''}`
    return ok(text, { channel: refOf(made.channel), joined, ...(failed.length ? { failed } : {}) })
  },
}
