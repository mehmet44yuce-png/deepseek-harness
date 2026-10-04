// Proves the tool composes through the real Loader: a test-only cordis.yml mounts the
// runtime pieces plus this plugin, and the loaded configuration decides the model-visible
// description, the request the tool sends, and the content the model reads back.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTypesafe from '@deepseek-ai/dsh-tool-typesafe'
import { TYPESAFE_DEFAULT_BASE_URL, TYPESAFE_DEFAULT_MODEL } from '@deepseek-ai/dsh-tool-typesafe'

const RESPONSE = {
  model: 'jev-1.13.0',
  answers: { urgency: { type: 'noul', noul: 0.98 } },
  usage: { input_tokens: 360, output_tokens: 55 },
}

const QUESTIONS = [{ id: 'urgency', type: 'noul', instructions: 'Is this urgent?' }]

let root: string | undefined
let context: Context | undefined
let callCounter = 0

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Install a fetch stand-in that answers every request with the fixture. */
function stubFetch(body: unknown = RESPONSE) {
  const mock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Boot a cordis.yml carrying the given tool config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-typesafe-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-typesafe'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-typesafe', ToolTypesafe],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/**
 * Execute `typesafe_decide` through the loaded runtime.
 * @param ctx - the booted context.
 * @param args - tool arguments.
 * @returns the tool result.
 */
function callTool(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`loader-call-${++callCounter}`),
    name: 'typesafe_decide',
    arguments: args,
  })
}

/**
 * Join one result's text blocks.
 * @param result - the tool result.
 * @returns the model-visible text.
 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-typesafe real Loader composition through cordis.yml', () => {
  it('registers the tool and sends the configured request end to end', async () => {
    const mock = stubFetch()
    const ctx = await boot([
      "    apiKey: 'loader-key'",
      "    baseURL: 'https://typesafe.test/v1'",
      '    model: jev-loader',
      '    timeoutMs: 5000',
    ])

    const description = ctx.tools.schemas().find(schema => schema.name === 'typesafe_decide')?.description ?? ''
    expect(description).toContain('TypeSafe System One model (Jev)')

    const result = await callTool(ctx, { state: 'A customer needs help.', questions: QUESTIONS })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('TypeSafe jev-1.13.0\nurgency: noul 0.98\ntokens: 360 in, 55 out')

    const call = mock.mock.calls[0]
    if (call === undefined) throw new Error('expected one fetch call')
    expect(call[0]).toBe('https://typesafe.test/v1/systemone')
    expect(JSON.parse(call[1].body as string)).toEqual({
      state: 'A customer needs help.',
      model: 'jev-loader',
      questions: { urgency: { type: 'noul', instructions: 'Is this urgent?' } },
    })
  }, 30_000)

  it('falls back to the documented endpoint and model when config omits them', async () => {
    const mock = stubFetch()
    const ctx = await boot(["    apiKey: 'loader-key'"])
    await callTool(ctx, { state: 's', questions: QUESTIONS })
    const call = mock.mock.calls[0]
    if (call === undefined) throw new Error('expected one fetch call')
    expect(call[0]).toBe(`${TYPESAFE_DEFAULT_BASE_URL}/systemone`)
    const body = JSON.parse(call[1].body as string) as { model: string }
    expect(body.model).toBe(TYPESAFE_DEFAULT_MODEL)
  }, 30_000)

  it('fails loading when timeoutMs is not a positive integer', async () => {
    await expect(boot(['    timeoutMs: 0'])).rejects.toThrow(/timeoutMs/)
  }, 30_000)
})
