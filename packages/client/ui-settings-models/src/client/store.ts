/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials/describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns declared rows followed by live routes with no declaration.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Whether new models are written straight into settings on load. */
  autoSyncEnabled: boolean
  /** Progress of the auto/manual "sync models" action. */
  sync: ModelsSyncState
}

/** Progress of the bulk "sync models" action (an add-only catalog refresh). */
export type ModelsSyncState =
  | { status: 'idle'; message: string | null; added: number }
  | { status: 'running' }
  | { status: 'done'; message: string | null; added: number }
  | { status: 'error'; message: string }

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** LocalStorage key holding the value of the auto-sync toggle. */
const AUTO_SYNC_KEY = 'dsh.modelsSettings.autoSync'

/**
 * Read the persisted auto-sync toggle. Unset defaults to **off**: the page is
 * meant to keep a route's models current only when the user opts in, since the
 * action interrogates every configured pi-ai endpoint over the wire. Storage is
 * unavailable in a fresh test env, so an unreadable flag falls back to off.
 */
function readAutoSyncFlag(): boolean {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) === '1'
  } catch {
    return false
  }
}

/** The existing model entries a profile already serves, as an array. */
function modelsEntriesOf(
  path: readonly string[],
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): readonly { id: string }[] {
  /* v8 ignore next -- syncModelsNow only calls this with a resolved namespace */
  if (namespace === undefined) return []
  const found = schema.getPath(namespace.value, path)
  return Array.isArray(found)
    ? found.filter((value): value is { id: string } =>
      typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string')
    : []
}

/** Read a rejection's message, stringifying anything else a catch may carry. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
    autoSyncEnabled: readAutoSyncFlag(), sync: { status: 'idle', message: null, added: 0 },
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /** Routes the auto-sync already wrote this mount, so load() never re-fires it. */
  private autoSynced = new Set<string>()

  /**
   * @param ctx - the page plugin's context, whose `remote.llm` and
   * `remote.credentials` namespaces carry the directory and credential reads.
   * @param schema - settings-owned schema and immutable path operations.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const [registered, declared] = await Promise.all([
      this.ctx.remote.llm.listProviders(),
      this.ctx.remote.llm.listConfigurableProviders(),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) { this.failLoad(generation, registered.error.message); return }
    if (!declared.ok) { this.failLoad(generation, declared.error.message); return }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.ctx.remote.credentials.describe(refs)
      // Credential state is an enrichment for the Models page: a failure
      // degrades the badge instead of failing the load. The onboarding
      // projection below retains the failure distinction.
      if (response.ok) credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map((row) => {
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
      s.namespaces = namespaces
    })
    // Keep a route's models current without a manual refresh: once per mount,
    // for each configured pi-ai route not yet written this session.
    void this.syncNowIfAuto()
  }

  /** Publish one load's failure text, unless a newer load already took over. */
  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }

  /**
   * Toggle the auto-sync, persisting the choice. A toggle clears the per-mount
   * "written" set so a re-enabled mount will consider a route again.
   * @param enabled - whether new models are written straight into settings.
   */
  setAutoSync(enabled: boolean): void {
    try {
      localStorage.setItem(AUTO_SYNC_KEY, enabled ? '1' : '0')
    } catch {
      // Storage unavailable: the in-memory flag still governs this mount.
    }
    this.autoSynced.clear()
    this.store.update((s) => { s.autoSyncEnabled = enabled })
  }

  /** Run the auto-sync when enabled and a mount has not already done so. */
  private syncNowIfAuto(): void {
    if (this.store.getSnapshot().autoSyncEnabled) void this.syncModelsNow()
  }

  /**
   * Ask every configured pi-ai route what its endpoint serves right now
   * (`forceLive`, so even a catalog route is interrogated over the wire), and
   * write the new models straight into settings — add-only, with the picks the
   * live list introduced. Nothing is ever removed; a route the user tuned keeps
   * its entries, and a model already served is never duplicated.
   * @returns nothing; the snapshot carries the sync outcome.
   */
  async syncModelsNow(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.status !== 'ready') return
    this.store.update((s) => { s.sync = { status: 'running' } })
    const namespace = state.namespaces.get('llm-pi-ai')
    if (namespace === undefined) {
      this.store.update((s) => { s.sync = { status: 'error', message: 'no llm-pi-ai namespace' } })
      return
    }
    const ops: SettingsPathOpView[] = []
    let addedTotal = 0
    const failures: string[] = []
    for (const row of state.rows) {
      if (!row.configured || row.entry.settingsNs !== 'llm-pi-ai') continue
      if (this.autoSynced.has(row.entry.provider)) continue
      try {
        const response = await this.ctx.remote.llm.discoverModels(row.entry.settingsNs, {
          provider: row.entry.provider,
          forceLive: true,
        })
        this.autoSynced.add(row.entry.provider)
        if (!response.ok) {
          failures.push(`${row.entry.provider}: ${response.error.message}`)
          continue
        }
        const live = response.value
        const path = [...row.entry.settingsPath, 'models']
        const known = new Set(modelsEntriesOf(path, namespace, this.schema).map(entry => entry.id))
        const newIds = live.map(model => model.id).filter(id => id.length > 0 && !known.has(id))
        if (newIds.length === 0) continue
        ops.push({
          op: 'set',
          path,
          value: [...modelsEntriesOf(path, namespace, this.schema), ...newIds.map(id => ({ id }))],
        })
        addedTotal += newIds.length
      } catch (error) {
        this.autoSynced.add(row.entry.provider)
        failures.push(`${row.entry.provider}: ${messageOf(error)}`)
      }
    }
    if (ops.length > 0) {
      try {
        const response = await this.ctx.remote.settings.mutate('llm-pi-ai', ops, namespace.revision)
        if (!response.ok) {
          this.store.update((s) => { s.sync = { status: 'error', message: response.error.message } })
          return
        }
      } catch (error) {
        this.store.update((s) => { s.sync = { status: 'error', message: messageOf(error) } })
        return
      }
      await this.load()
    }
    const message = failures.length > 0 ? failures.join('; ') : null
    this.store.update((s) => { s.sync = { status: 'done', message, added: addedTotal } })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
