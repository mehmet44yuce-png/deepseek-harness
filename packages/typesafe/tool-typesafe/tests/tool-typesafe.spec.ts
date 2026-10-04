import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import {
  assertAnswerIds,
  parseDecision,
  renderDecision,
  TYPESAFE_DEFAULT_API_KEY_ENV,
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
  type Config,
} from '../src/index.ts'

/** References the stand-in credentials service answers, so a test needs no cast to seed one. */
const storedKeys = new Map<string, string>()

/** Credentials stand-in: the plugin reads it through `ctx.get('credentials')` at call time. */
class FakeCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Answer one reference from the test-owned map.
   * @param ref - the credential reference to resolve.
   * @returns the stored record, or undefined when the test stored nothing.
   */
  resolve(ref: string): Promise<{ value: string; source: 'env' } | undefined> {
    const value = storedKeys.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'env' as const })
  }
}

const RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    urgency: { type: 'noul', noul: 0.95 },
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.88, technical: 0.12 },
      confidence: 0.81,
    },
    frustration: {
      type: 'score',
      score: 1.05,
      legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
      probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
      confidence: 0.92,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
}

const QUESTIONS = [
  { id: 'urgency', type: 'noul', instructions: 'Does the message convey urgency?' },
  {
    id: 'department',
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payment issues', technical: 'Bugs' },
  },
  { id: 'frustration', type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated'] },
]

const WIRE_QUESTIONS = {
  urgency: { type: 'noul', instructions: 'Does the message convey urgency?' },
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payment issues', technical: 'Bugs' },
  },
  frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated'] },
}

const RENDERED = [
  'TypeSafe jev-1.13.0',
  'urgency: noul 0.95',
  'department: choice billing (confidence 0.81; billing 0.88, technical 0.12)',
  'frustration: score 1.05 (confidence 0.92; Calm 0, Frustrated 0.95, Very angry 0.05)',
  'tokens: 318 in, 34 out',
].join('\n')

let callCounter = 0
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  storedKeys.clear()
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Mount the real tool runtime and the real plugin.
 * @param config - plugin fields under test; `apiKey` defaults to a test key.
 * @param options - `withCredentials` mounts the credentials stand-in, `withApiKey` false omits the key.
 * @returns the mounted context.
 */
async function setup(
  config: Partial<Config> = {},
  options: { withCredentials?: boolean; withApiKey?: boolean } = {},
): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.withCredentials === true) await ctx.plugin(FakeCredentials)
  await ctx.plugin(plugin, options.withApiKey === false ? config : { apiKey: 'ts-unit-key', ...config })
  return ctx
}

/**
 * Install a fetch stand-in and return its mock.
 * @param handler - the request handler the mock delegates to.
 * @returns the mock, for request assertions.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

/** A JSON response with the given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The single request one mock received.
 * @param mock - the fetch mock.
 * @returns the URL and init.
 */
function requestOf(mock: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = mock.mock.calls[0]
  if (call === undefined) throw new Error('expected one fetch call')
  return { url: call[0], init: call[1] }
}

/**
 * Execute `typesafe_decide` through the real registry.
 * @param ctx - the mounted context.
 * @param args - tool arguments.
 * @param signal - caller cancellation, or undefined for a fresh signal.
 * @returns the tool result.
 */
function callTool(ctx: Context, args: unknown, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'typesafe_decide',
    arguments: args,
  })
}

/**
 * Join the text blocks of one result.
 * @param result - the tool result.
 * @returns the model-visible text.
 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** One compiled schema node, as the registry projects it. */
interface CompiledSchema {
  type?: string
  const?: string
  description?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, CompiledSchema>
  items?: CompiledSchema
  oneOf?: CompiledSchema[]
}

describe('typesafe_decide schema', () => {
  it('registers the state and questions parameters with a three-branch question union', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'typesafe_decide')
    expect(schema).toBeDefined()
    const parameters = schema?.parameters as unknown as CompiledSchema
    expect(Object.keys(parameters.properties ?? {})).toEqual(['state', 'questions'])
    expect(parameters.required).toEqual(['state', 'questions'])
    const questions = parameters.properties?.['questions']
    expect(questions?.type).toBe('array')
    const branches = questions?.items?.oneOf ?? []
    expect(branches).toHaveLength(3)
    expect(branches.map(branch => branch.properties?.['type']?.const)).toEqual(['choice', 'noul', 'score'])
    expect(branches.every(branch => branch.additionalProperties === false)).toBe(true)
    expect(branches.every(branch => branch.properties?.['id']?.type === 'string')).toBe(true)
    // A JSON-valued parameter projects as an open schema: no constraining type, with the accepted
    // forms named in the description the model reads.
    expect(parameters.properties?.['state']?.type).toBeUndefined()
    expect(parameters.properties?.['state']?.description).toContain('structured JSON')
    expect(branches.every(branch => branch.properties?.['instructions']?.type === undefined)).toBe(true)
  })

  it('sends a structured state and structured instructions unchanged', async () => {
    const mock = stubFetch(async () => jsonResponse({ model: 'jev-1.13.0', answers: { urgency: { type: 'noul', noul: 0.9 } } }))
    const ctx = await setup()
    const state = { subject: 'Payouts failing', attempts: 3 }
    const instructions = { question: 'Does \`candidate\` describe the same person?', candidate: { name: 'A' } }
    const result = await callTool(ctx, { state, questions: [{ id: 'urgency', type: 'noul', instructions }] })
    expect(result.isError).toBe(false)
    const body = JSON.parse(requestOf(mock).init.body as string) as { state: unknown; questions: Record<string, unknown> }
    expect(body.state).toEqual(state)
    expect(body.questions['urgency']).toEqual({ type: 'noul', instructions })
  })

  it('accepts structured score levels', async () => {
    const mock = stubFetch(async () => jsonResponse({ model: 'jev-1.13.0', answers: { frustration: { type: 'score', score: 1, legend: { '0': 'calm', '1': 'angry' }, probabilities: { '0': 0, '1': 1 }, confidence: 1 } } }))
    const ctx = await setup()
    const criteria = [{ level: 'calm' }, { level: 'angry' }]
    await callTool(ctx, { state: 's', questions: [{ id: 'frustration', type: 'score', instructions: 'How frustrated?', criteria }] })
    const body = JSON.parse(requestOf(mock).init.body as string) as { questions: Record<string, { criteria: unknown }> }
    expect(body.questions['frustration']?.criteria).toEqual(criteria)
  })

  it('rejects a state that is neither text nor a structure', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, { state: 42, questions: QUESTIONS })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be a string, an object, or an array')
  })

  it('rejects an empty structured state and a scalar instruction', async () => {
    const ctx = await setup()
    const emptyState = await callTool(ctx, { state: {}, questions: QUESTIONS })
    expect(text(emptyState)).toContain('must not be an empty object or array')
    const scalarInstruction = await callTool(ctx, { state: 's', questions: [{ id: 'q', type: 'noul', instructions: 7 }] })
    expect(text(scalarInstruction)).toContain('must be a string, an object, or an array')
  })

  it('writes the description from the model perspective', async () => {
    const ctx = await setup()
    const description = ctx.tools.schemas().find(candidate => candidate.name === 'typesafe_decide')?.description ?? ''
    expect(description).toContain('TypeSafe System One model (Jev)')
    expect(description).toContain('Prefer this over guessing a classification')
    expect(description).toContain('low-confidence answer as uncertain')
  })
})

describe('typesafe_decide request and result', () => {
  it('posts the configured endpoint, model, and id-keyed questions and returns the decision', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    const ctx = await setup({ baseURL: 'https://typesafe.test/v1', model: 'jev-test' })
    const result = await callTool(ctx, { state: 'A customer needs help.', questions: QUESTIONS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual(RESPONSE)
    expect(text(result)).toBe(RENDERED)

    const { url, init } = requestOf(mock)
    expect(url).toBe('https://typesafe.test/v1/systemone')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer ts-unit-key')
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'A customer needs help.',
      model: 'jev-test',
      questions: WIRE_QUESTIONS,
    })
  })

  it('defaults the endpoint and model', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    const ctx = await setup()
    await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(requestOf(mock).url).toBe(`${TYPESAFE_DEFAULT_BASE_URL}/systemone`)
    const body = JSON.parse(requestOf(mock).init.body as string) as { model: string }
    expect(body.model).toBe(TYPESAFE_DEFAULT_MODEL)
  })

  it('omits usage when TypeSafe reports none', async () => {
    stubFetch(async () => jsonResponse({ model: 'jev-1.13.0', answers: { urgency: { type: 'noul', noul: 1 } } }))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ model: 'jev-1.13.0', answers: { urgency: { type: 'noul', noul: 1 } } })
  })
})

describe('typesafe_decide argument validation', () => {
  it('rejects an empty state before any request', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    const ctx = await setup()
    const result = await callTool(ctx, { state: '   ', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be a non-empty string')
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects an empty question list', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at least one question is required')
  })

  it('rejects duplicate question ids', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0], QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('duplicate id')
  })

  it('rejects a choice question with no options', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, {
      state: 's',
      questions: [{ id: 'area', type: 'choice', instructions: 'Which?', criteria: {} }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at least one option')
  })

  it('rejects a numeric choice description', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, {
      state: 's',
      questions: [{ id: 'area', type: 'choice', instructions: 'Which?', criteria: { payments: 3 } }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be a string, object, array, or null')
  })

  it('rejects a score question outside the level range', async () => {
    const ctx = await setup()
    const single = await callTool(ctx, {
      state: 's',
      questions: [{ id: 'f', type: 'score', instructions: 'How?', criteria: ['only'] }],
    })
    expect(single.isError).toBe(true)
    expect(text(single)).toContain('2 to 10 levels')
  })

  it('rejects a noul question carrying an empty criteria object', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, {
      state: 's',
      questions: [{ id: 'u', type: 'noul', instructions: 'Urgent?', criteria: {} }],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('needs a `true` or `false` description')
  })

  it('rejects a question field the schema does not declare', async () => {
    const ctx = await setup()
    const result = await callTool(ctx, {
      state: 's',
      questions: [{ id: 'u', type: 'noul', instructions: 'Urgent?', weight: 1 }],
    })
    expect(result.isError).toBe(true)
  })
})

describe('typesafe_decide credential resolution', () => {
  it('prefers the explicit apiKey over the credentials service', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    storedKeys.set(TYPESAFE_DEFAULT_API_KEY_ENV, 'seam-key')
    const ctx = await setup({}, { withCredentials: true })
    await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    const headers = requestOf(mock).init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer ts-unit-key')
  })

  it('resolves and trims the key through the credentials service', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    storedKeys.set(TYPESAFE_DEFAULT_API_KEY_ENV, '  seam-key  ')
    const ctx = await setup({}, { withCredentials: true, withApiKey: false })
    await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    const headers = requestOf(mock).init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer seam-key')
  })

  it('resolves the key from the launching environment without the credentials service', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    const previous = process.env[TYPESAFE_DEFAULT_API_KEY_ENV]
    process.env[TYPESAFE_DEFAULT_API_KEY_ENV] = 'env-key'
    try {
      const ctx = await setup({}, { withApiKey: false })
      await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
      const headers = requestOf(mock).init.headers as Record<string, string>
      expect(headers['authorization']).toBe('Bearer env-key')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, TYPESAFE_DEFAULT_API_KEY_ENV)
      else process.env[TYPESAFE_DEFAULT_API_KEY_ENV] = previous
    }
  })

  it('fails loud when no layer supplies a key', async () => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    const previous = process.env[TYPESAFE_DEFAULT_API_KEY_ENV]
    Reflect.deleteProperty(process.env, TYPESAFE_DEFAULT_API_KEY_ENV)
    try {
      const ctx = await setup({}, { withApiKey: false })
      const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('no TypeSafe API key')
      expect(text(result)).toContain(TYPESAFE_DEFAULT_API_KEY_ENV)
      expect(mock).not.toHaveBeenCalled()
    } finally {
      if (previous !== undefined) process.env[TYPESAFE_DEFAULT_API_KEY_ENV] = previous
    }
  })

  it.each([
    { label: 'blank', value: '   ', expected: 'is blank' },
    { label: 'untransmittable', value: 'sk-😀supersecret', expected: 'no HTTP header can carry' },
  ])('rejects a $label stored key without echoing it', async ({ value, expected }) => {
    const mock = stubFetch(async () => jsonResponse(RESPONSE))
    storedKeys.set(TYPESAFE_DEFAULT_API_KEY_ENV, value)
    const ctx = await setup({}, { withCredentials: true, withApiKey: false })
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
    expect(text(result)).not.toContain('supersecret')
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('typesafe_decide retries', () => {
  it('retries a rate limit and returns the next attempt', async () => {
    let calls = 0
    const mock = stubFetch(async () => {
      calls += 1
      return calls === 1 ? jsonResponse({ error: 'slow down' }, 429) : jsonResponse(RESPONSE)
    })
    const ctx = await setup({ maxRetries: 1, retryBackoffMs: 1, retryJitter: 0 })
    const result = await callTool(ctx, { state: 'A customer needs help.', questions: QUESTIONS })
    expect(result.isError).toBe(false)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(text(result)).toBe(RENDERED)
  })

  it('retries a transport failure and returns the next attempt', async () => {
    let calls = 0
    const mock = stubFetch(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed', { cause: new Error('socket hang up') })
      return jsonResponse(RESPONSE)
    })
    const ctx = await setup({ maxRetries: 1, retryBackoffMs: 1, retryJitter: 0 })
    const result = await callTool(ctx, { state: 'A customer needs help.', questions: QUESTIONS })
    expect(result.isError).toBe(false)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('honors a provider Retry-After delay and stops at maxRetries', async () => {
    const mock = stubFetch(async () => new Response(JSON.stringify({ error: 'overloaded' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
    }))
    const ctx = await setup({ maxRetries: 1 })
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(text(result)).toContain('HTTP 429')
  })

  it('does not retry a status TypeSafe does not document as retryable', async () => {
    const mock = stubFetch(async () => jsonResponse({ error: 'bad key' }, 401))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe('typesafe_decide HTTP failures', () => {
  it.each([
    { status: 400, expected: 'HTTP 400' },
    { status: 401, expected: 'HTTP 401' },
    { status: 403, expected: 'HTTP 403' },
    { status: 429, expected: 'HTTP 429' },
    { status: 500, expected: 'HTTP 500' },
    { status: 529, expected: 'HTTP 529' },
  ])('maps HTTP $status to an explicit failure', async ({ status, expected }) => {
    stubFetch(async () => jsonResponse({ error: 'provider said no' }, status))
    // No retries here: this test asserts one resolved failure, not the retry policy.
    const ctx = await setup({ maxRetries: 0 })
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
    expect(text(result)).toContain('tool-typesafe:')
  })

  it('quotes the body detail for a validation rejection', async () => {
    stubFetch(async () => jsonResponse({ error: 'questions.urgency is malformed' }, 422))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('HTTP 422')
    expect(text(result)).toContain('questions.urgency is malformed')
  })

  it('never echoes the key from a credential rejection body', async () => {
    stubFetch(async () => jsonResponse({ error: 'invalid key ts-unit-key' }, 401))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('ts-unit-key')
  })

  it('refuses to follow a redirect rather than forward the key', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect response') })
    })
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('refusing to forward the API key')
  })

  it('reports an unreadable body', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not JSON')
  })

  it('reports a response missing its answers', async () => {
    stubFetch(async () => jsonResponse({ model: 'jev-1.13.0' }))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unexpected response from TypeSafe')
  })

  it('reports a missing answer id instead of defaulting', async () => {
    stubFetch(async () => jsonResponse({ model: 'jev-1.13.0', answers: { urgency: { type: 'noul', noul: 1 }, other: { type: 'noul', noul: 1 } } }))
    const ctx = await setup()
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('answer for unknown question')
  })

  it('times out with the configured budget', async () => {
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    const ctx = await setup({ timeoutMs: 20 })
    const result = await callTool(ctx, { state: 's', questions: [QUESTIONS[0]] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('did not answer within 20 ms')
  })

  it('abandons the request when the caller cancels', async () => {
    let aborted = false
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      })
    }))
    const ctx = await setup()
    const controller = new AbortController()
    const pending = callTool(ctx, { state: 's', questions: [QUESTIONS[0]] }, controller.signal)
    setTimeout(() => { controller.abort() }, 5)
    const result = await pending
    expect(aborted).toBe(true)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cancelled')
  })
})

describe('decision decoding', () => {
  it('requires every requested id and no others', () => {
    expect(() => { assertAnswerIds(['a'], { a: { type: 'noul', noul: 1 } }) }).not.toThrow()
    expect(() => { assertAnswerIds(['a'], {}) }).toThrow('no answer for question')
    expect(() => { assertAnswerIds(['a'], { a: {}, b: {} }) }).toThrow('answer for unknown question')
  })

  it('rejects an unknown answer type', () => {
    expect(() => parseDecision({ model: 'm', answers: { a: { type: 'verdict' } } })).toThrow('unknown type')
  })

  it('renders a decision without a legend verbatim by key', () => {
    expect(renderDecision({
      model: 'jev-1.13.0',
      answers: { area: { type: 'choice', choice: 'payments', probabilities: { payments: 1 }, confidence: 1 } },
    })).toBe('TypeSafe jev-1.13.0\narea: choice payments (confidence 1; payments 1)')
  })
})
