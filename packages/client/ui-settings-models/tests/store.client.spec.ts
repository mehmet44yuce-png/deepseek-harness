/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it, vi } from 'vitest'
import type { LlmModelDiscoveryRequest, RpcResponse, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'gateway/internal', message, details: {} } } }
}

/** Answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function remoteOk<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function remoteFail<T>(message: string): RemoteAnswer<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: readonly string[]) => Promise<RemoteAnswer<Record<string, unknown>>>
  discoverModels?: (settingsNs: string, request: LlmModelDiscoveryRequest) => Promise<RemoteAnswer<{ id: string }[]>>
  mutate?: (ns: string, ops: SettingsPathOpView[], revision: number) => Promise<RemoteAnswer<unknown>>
} = {}) {
  const seenRefs: string[][] = []
  const providers = overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY })))
  const discoverModels = overrides.discoverModels ?? (() => Promise.resolve(remoteOk([])))
  const mutate = overrides.mutate ?? (() => Promise.resolve(remoteFail('the store spec issues no writes')))
  let providerBatch: Promise<RpcResponse<{ providers: typeof DIRECTORY }>> | undefined
  let providerBatchReads = 0
  const readProviderBatch = (): Promise<RpcResponse<{ providers: typeof DIRECTORY }>> => {
    providerBatch ??= providers()
    const current = providerBatch
    providerBatchReads += 1
    if (providerBatchReads % 2 === 0) providerBatch = undefined
    return current
  }
  const mapProviderBatch = async <T>(
    project: (rows: typeof DIRECTORY) => T,
  ): Promise<RemoteAnswer<T>> => {
    const response = await readProviderBatch()
    return response.result.ok
      ? remoteOk(project(response.result.value.providers))
      : remoteFail(response.result.error.message)
  }
  const face = {
    llm: {
      listProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.active)
        .map(row => ({ id: row.provider, name: row.displayName }))),
      listConfigurableProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.settingsNs !== '')
        .map(({ active: _active, ...row }) => row)),
      discoverModels: (settingsNs: string, request: LlmModelDiscoveryRequest) => discoverModels(settingsNs, request),
    },
    settings: {
      describe: overrides.describeSettings
        ?? (() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      mutate: (ns: string, ops: SettingsPathOpView[], revision: number) => mutate(ns, ops, revision),
    },
    credentials: {
      describe: (refs: readonly string[]) => {
        seenRefs.push([...refs])
        return (overrides.describeCredentials ?? (asked => Promise.resolve(remoteOk(
          Object.fromEntries(asked.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        ))))(refs)
      },
      set: () => Promise.resolve(remoteOk(undefined)),
      unset: () => Promise.resolve(remoteOk(undefined)),
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: face } as never
  return { ctx, face, mirror: new SettingsDescribeMirror(ctx), seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { ctx, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    // Named references first (rows order), then the derived <ROUTE>_API_KEY
    // of every row whose profile names none — one batched describe.
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHOST_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { ctx, mirror } = api({ describeCredentials: () => Promise.resolve(remoteFail('no provider')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { ctx, mirror } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.ctx, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a configurable-provider directory failure', async () => {
    const { ctx, face, mirror } = api()
    const llm = (face as unknown as {
      llm: { listConfigurableProviders: () => Promise<RemoteAnswer<never>> }
    }).llm
    llm.listConfigurableProviders = () => Promise.resolve(remoteFail<never>('configuration directory down'))
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'configuration directory down',
    })
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('describes the derived reference for a row whose profile names none', async () => {
    const { ctx, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
      describeCredentials: refs => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
      )),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    // The dormant row names no reference, so the join asks about the page's
    // own derived <ROUTE>_API_KEY — what the editor would display for it.
    expect(seenRefs).toEqual([['ANTHROPIC_API_KEY']])
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows[0]?.credential).toBeUndefined()
    expect(state.rows[0]?.derivedCredential).toMatchObject({ configured: true })
  })

  it('surfaces a settings describe failure', async () => {
    const { ctx, mirror } = api({ describeSettings: () => Promise.resolve(remoteFail('settings down')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { ctx } = api()
    const store = new ModelsSettingsStore(
      ctx,
      settingsSchema,
      new SettingsDescribeMirror(ctx, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { ctx, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1
          ? remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : remoteFail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})

describe('ModelsSettingsStore syncModelsNow', () => {
  it('force-live-fetches configured pi-ai routes and writes new models add-only', async () => {
    const discover: Array<{ settingsNs: string; request: LlmModelDiscoveryRequest }> = []
    const mutateCalls: Array<{ ns: string; ops: SettingsPathOpView[]; revision: number }> = []
    const { ctx, mirror } = api({
      discoverModels: (settingsNs, request) => {
        discover.push({ settingsNs, request })
        return Promise.resolve(remoteOk([{ id: 'nvidia/new-1' }, { id: 'nvidia/new-2' }]))
      },
      mutate: (ns, ops, revision) => {
        mutateCalls.push({ ns, ops, revision })
        return Promise.resolve(remoteOk({ revision: 1 }))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()

    // The only configured pi-ai route in the fixture is openai. It is asked
    // force-live, and the new models are written as bare entries, never
    // removing the existing profile fields.
    expect(discover).toEqual([{ settingsNs: 'llm-pi-ai', request: { provider: 'openai', forceLive: true } }])
    expect(mutateCalls).toHaveLength(1)
    expect(mutateCalls[0]!.ns).toBe('llm-pi-ai')
    const op = (mutateCalls[0]!.ops as { op: string; path: string[]; value: { id: string }[] }[])[0]!
    expect(op.op).toBe('set')
    expect(op.path).toEqual(['providers', 'openai', 'models'])
    expect(op.value).toEqual([{ id: 'nvidia/new-1' }, { id: 'nvidia/new-2' }])
    const sync = store.store.getSnapshot().sync
    expect(sync.status).toBe('done')
    if (sync.status === 'done') expect(sync.added).toBe(2)
  })

  it('never duplicates a model the profile already serves, and keeps its entries', async () => {
    const seeded = NAMESPACES.map(view => view.ns === 'llm-pi-ai'
      ? { ...view, value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'existing-1', contextWindow: 1000 }] } } } }
      : view) as typeof NAMESPACES
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: seeded })),
      discoverModels: () => Promise.resolve(remoteOk([{ id: 'existing-1' }, { id: 'new-2' }])),
      mutate: () => Promise.resolve(remoteOk({ revision: 1 })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    // existing-1 is already served, so it is kept verbatim and only new-2 joins.
    const state = store.store.getSnapshot()
    expect(state.sync).toMatchObject({ status: 'done', added: 1 })
  })

  it('reports a missing pi-ai namespace as a sync error rather than writing nothing', async () => {
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-deepseek', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync).toMatchObject({ status: 'error', message: 'no llm-pi-ai namespace' })
  })

  it('runs the auto-sync on load once the toggle is enabled', async () => {
    const discover: Array<{ provider: string; forceLive: boolean }> = []
    const { ctx, mirror } = api({
      discoverModels: (_settingsNs, request) => {
        discover.push({ provider: request.provider ?? '', forceLive: request.forceLive === true })
        return Promise.resolve(remoteOk([]))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(true)
    await store.load()
    // load() fires the auto-sync once, force-live, for the configured pi-ai route.
    expect(discover).toEqual([{ provider: 'openai', forceLive: true }])
  })

  it('returns before syncing when the page snapshot is not ready', async () => {
    const discover = vi.fn()
    const { ctx, mirror } = api({
      discoverModels: (_settingsNs, _request) => {
        discover()
        return Promise.resolve(remoteOk([]))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.syncModelsNow()
    expect(discover).not.toHaveBeenCalled()
  })

  it('keeps the provider failure text when a route cannot be probed live', async () => {
    const { ctx, mirror } = api({
      discoverModels: () => Promise.reject(new Error('probe blew up')),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync)
      .toMatchObject({ status: 'done', message: 'openai: probe blew up' })
  })

  it('stringifies a non-Error probe rejection', async () => {
    const { ctx, mirror } = api({
      discoverModels: () => Promise.reject('plain rejected string'),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync)
      .toMatchObject({ status: 'done', message: 'openai: plain rejected string' })
  })

  it('records a refused route as a failure instead of a thrown error', async () => {
    const { ctx, mirror } = api({
      discoverModels: () => Promise.resolve(remoteFail('network refused')),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync)
      .toMatchObject({ status: 'done', message: 'openai: network refused' })
  })

  it('reports a settings mutate refusal as a sync error', async () => {
    const { ctx, mirror } = api({
      discoverModels: () => Promise.resolve(remoteOk([{ id: 'new-1' }])),
      mutate: () => Promise.resolve(remoteFail('write refused')),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync).toMatchObject({ status: 'error', message: 'write refused' })
  })

  it('reports a settings mutate rejection as a sync error', async () => {
    const { ctx, mirror } = api({
      discoverModels: () => Promise.resolve(remoteOk([{ id: 'new-1' }])),
      mutate: () => Promise.reject(new Error('write blew up')),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(store.store.getSnapshot().sync).toMatchObject({ status: 'error', message: 'write blew up' })
  })

  it('leaves a route untouched when the live list adds nothing new', async () => {
    const mutate = vi.fn()
    const { ctx, mirror } = api({
      discoverModels: () => Promise.resolve(remoteOk([])),
      mutate: (_ns, _ops, _revision) => { mutate(); return Promise.resolve(remoteOk({ revision: 1 })) },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    expect(mutate).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().sync).toMatchObject({ status: 'done', added: 0 })
  })

  it('skips a route this mount already synced', async () => {
    let calls = 0
    const { ctx, mirror } = api({
      discoverModels: () => { calls += 1; return Promise.resolve(remoteOk([])) },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    store.setAutoSync(false)
    await store.load()
    await store.syncModelsNow()
    await store.syncModelsNow()
    expect(calls).toBe(1)
  })
})
