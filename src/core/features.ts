// Features (extensions/types.ts FeatureContribution): what tether offers the AI agents of its panes, as pure rules shared
// by tetherd (which features a launch gets), Electron main (the settings page's switches) and the profile validator.
//   - declared: every `contributes.features` of a list of manifests, by id; an id declared twice keeps the first;
//   - the general switch: settings.json `agents.features.<id>` (a boolean; anything else reads as the extension's default);
//   - resolution: the profile's explicit value (Profile.features) > the general switch > the extension's default;
//   - the configuration node the registry takes, so the settings page lists the general switches like any setting.
import type { ExtensionManifest, FeatureContribution } from '../../extensions/types.ts'
import type { ConfigurationNode, SettingSchema } from '../../app/shared/vscode-configuration-registry.ts'

/** A feature id: lowercase, no dot (it is a segment of `agents.features.<id>` and of the composed folder's name). */
export const FEATURE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/** Where the general switches live in settings.json. */
export const FEATURES_PREFIX = 'agents.features'

export const featureSettingKey = (id: string): string => `${FEATURES_PREFIX}.${id}`

/** One declared feature and the extension that declared it. */
export interface FeatureDecl extends FeatureContribution {
  id: string
  ext: string
}

/** What another process needs to show a feature (plain data, crosses IPC). */
export interface FeatureInfo {
  id: string
  title: string
  description?: string
  default: boolean
  /** The general switch in force (settings.json, else the default). */
  general: boolean
}

/** Every feature the manifests declare, in manifest order; an invalid or repeated id is skipped (`problems` says why). */
export function declaredFeatures(manifests: readonly ExtensionManifest[]): { features: FeatureDecl[]; problems: string[] } {
  const features: FeatureDecl[] = []
  const problems: string[] = []
  const seen = new Map<string, string>()
  for (const m of manifests) {
    for (const [id, f] of Object.entries(m.contributes?.features ?? {})) {
      if (!FEATURE_ID_RE.test(id)) { problems.push(`extensão ${m.id}: id de feature inválido ${JSON.stringify(id)}`); continue }
      const owner = seen.get(id)
      if (owner) { problems.push(`extensão ${m.id}: a feature ${id} já é da extensão ${owner}`); continue }
      seen.set(id, m.id)
      features.push({ ...f, id, ext: m.id })
    }
  }
  return { features, problems }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The general switch of `id` in the settings.json object; undefined when it is absent or not a boolean. */
export function generalSwitch(settings: unknown, id: string): boolean | undefined {
  const agents = isObject(settings) ? settings.agents : undefined
  const features = isObject(agents) ? agents.features : undefined
  const v = isObject(features) ? features[id] : undefined
  return typeof v === 'boolean' ? v : undefined
}

/** Profile explicit > general > the extension's default. */
export function resolveFeature(f: Pick<FeatureDecl, 'id' | 'default'>, settings: unknown, profile?: Readonly<Record<string, boolean>>): boolean {
  const own = profile?.[f.id]
  if (typeof own === 'boolean') return own
  return generalSwitch(settings, f.id) ?? f.default
}

/** The ids enabled for a launch, sorted (the composed folder's signature is built from this order). */
export function enabledFeatures(features: readonly Pick<FeatureDecl, 'id' | 'default'>[], settings: unknown, profile?: Readonly<Record<string, boolean>>): string[] {
  return features.filter(f => resolveFeature(f, settings, profile)).map(f => f.id).sort()
}

/** The plain-data view of the features, with the general switch in force. */
export function featureInfos(features: readonly FeatureDecl[], settings: unknown): FeatureInfo[] {
  return features.map(f => ({ id: f.id, title: f.title, ...(f.description ? { description: f.description } : {}), default: f.default, general: generalSwitch(settings, f.id) ?? f.default }))
}

/** The settings page's node: one boolean per feature under `agents.features`, in the section "Agentes". */
export const FEATURES_NODE_ID = 'agent-features'

export function featuresConfigurationNode(features: readonly FeatureDecl[]): ConfigurationNode {
  const properties: Record<string, SettingSchema> = {}
  features.forEach((f, i) => {
    properties[f.id] = {
      type: 'boolean', default: f.default, title: f.title, section: 'O que os agentes recebem', order: i,
      description: `${f.description ? `${f.description} ` : ''}Vale para todo perfil que não diga o contrário; muda no próximo lançamento do painel.`,
    }
  })
  return { id: FEATURES_NODE_ID, prefix: FEATURES_PREFIX, title: 'Agentes', order: 50, properties }
}

/** Shape check of Profile.features (validateProfile judges the ids). */
export function isFeatureMap(x: unknown): x is Record<string, boolean> {
  return isObject(x) && Object.values(x).every(v => typeof v === 'boolean')
}
