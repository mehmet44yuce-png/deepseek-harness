/**
 * Model-facing `typesafe_decide` tool over TypeSafe's System One API. One call posts a state and a
 * map of typed questions and returns the decoded answer envelope unchanged; question construction,
 * credential resolution, and cancellation stay here, while the HTTP boundary lives in
 * `./client.ts`. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-typesafe
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TypeSafeState } from './types.ts'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey } from './api-key.ts'
import { DEFAULT_RETRY_POLICY } from './retry.ts'
import type { RetryPolicy } from './retry.ts'
import { assertAnswerIds, SystemOneGateway, TYPESAFE_DEFAULT_BASE_URL } from './client.ts'
import { renderDecision } from './render.ts'

// The tool registers on the tool registry; credentials are read optionally at call time with
// `ctx.get`, so a composition without the credentials seam still works.
export { assertAnswerIds, parseDecision, SystemOneGateway, TYPESAFE_DEFAULT_BASE_URL } from './client.ts'
export type { TypeSafeJson, TypeSafeState } from './types.ts'
export { renderAnswers, renderDecision } from './render.ts'
export { DEFAULT_RETRY_POLICY } from './retry.ts'
export type { RetryPolicy } from './retry.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-typesafe'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

/** Default model alias; TypeSafe resolves it to the current flagship model. */
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest'

/** Default credential reference naming the API key. */
export const TYPESAFE_DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Default per-request timeout in milliseconds. */
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 40_000

/** Choice options one question accepts; TypeSafe documents 255 as the limit. */
const MAX_CHOICE_OPTIONS = 255

/** Score levels one question accepts; TypeSafe documents this inclusive range. */
const MIN_SCORE_LEVELS = 2
const MAX_SCORE_LEVELS = 10

/** Model-facing TypeSafe tool configuration. */
export interface Config {
  /**
   * Explicit API key, highest precedence. Prefer `apiKeyEnv` so the key stays out of composition
   * files; resolution falls back to the credential reference when this is omitted.
   */
  apiKey?: string
  /**
   * Credential reference naming the API key. Resolution order: `apiKey`, then this reference
   * through `ctx.credentials`, then the launching environment. Defaults to `TYPESAFE_API_KEY`.
   */
  apiKeyEnv?: string
  /** Endpoint base; `/systemone` is appended. Defaults to the public TypeSafe API. */
  baseURL?: string
  /** Model TypeSafe evaluates with. Defaults to `jev-latest`. */
  model?: string
  /** Per-request timeout in milliseconds for one attempt. Defaults to 40000. */
  timeoutMs?: number
  /** Retries after the first attempt; `0` disables retrying. Defaults to 2. */
  maxRetries?: number
  /** First retry delay in milliseconds; it doubles per attempt. Defaults to 500. */
  retryBackoffMs?: number
  /** Retry delay ceiling in milliseconds. Defaults to 5000. */
  retryBackoffMaxMs?: number
  /** Fractional jitter applied to each retry delay, from 0 to 1. Defaults to 0.25. */
  retryJitter?: number
  /** Whether a provider `Retry-After` header replaces the computed delay. Defaults to true. */
  respectRetryAfter?: boolean
  /** Ceiling for a provider-requested delay, in milliseconds. Defaults to 60000. */
  retryAfterMaxMs?: number
}

/** Schemastery configuration for the TypeSafe tool. */
export const Config: z<Config> = z.object({
  apiKey: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(TYPESAFE_DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(TYPESAFE_DEFAULT_BASE_URL),
  model: z.string().default(TYPESAFE_DEFAULT_MODEL),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(TYPESAFE_DEFAULT_TIMEOUT_MS),
  maxRetries: z.number().step(1).min(0).max(10).default(DEFAULT_RETRY_POLICY.maxRetries),
  retryBackoffMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_POLICY.backoffInitialMs),
  retryBackoffMaxMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_POLICY.backoffMaxMs),
  retryJitter: z.number().min(0).max(1).default(DEFAULT_RETRY_POLICY.jitter),
  respectRetryAfter: z.boolean().default(DEFAULT_RETRY_POLICY.respectRetryAfter),
  retryAfterMaxMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_POLICY.retryAfterMaxMs),
})

const DESCRIPTION_HEAD =
  'Evaluate a state against typed questions with the TypeSafe System One model (Jev) and get '
  + 'structured answers the next step can use directly. '

const DESCRIPTION_BODY =
  'Ask several narrow questions in one call: every question is judged against the same state '
  + 'independently and in parallel, so adding questions barely changes response time. '

const DESCRIPTION_TYPES =
  'Use `choice` to pick one option from a labelled set, where `criteria` maps each option to the '
  + 'situation it describes; `score` to rate the state against ordered level descriptions in '
  + '`criteria`; and `noul` for a yes/no question that returns the probability of yes. A `noul` value '
  + 'is a probability, not a grade: ask a `score` question when you need a position on a scale. '

const DESCRIPTION_TAIL =
  'Every question needs a unique `id`, and each answer comes back under that id. Prefer this over '
  + 'guessing a classification, probability, or rating. Choice and score answers carry '
  + '`confidence`: report it, and treat a low-confidence answer as uncertain instead of decided.'

/** The model-facing description of `typesafe_decide`. */
const DESCRIPTION = DESCRIPTION_HEAD + DESCRIPTION_BODY + DESCRIPTION_TYPES + DESCRIPTION_TAIL

const STATE_DESCRIPTION =
  'The content the questions judge: text, or structured JSON when the questions refer to fields. '
  + 'Include only the context the questions need.'

const QUESTIONS_DESCRIPTION =
  'Questions to judge against `state`. Each is evaluated on its own, so ask one narrow thing per '
  + 'question instead of one broad question.'

const QUESTION_ID_DESCRIPTION = 'Unique id for this question; its answer returns under the same id.'

const INSTRUCTIONS_DESCRIPTION =
  'The question to answer about `state`: a string, or structured JSON that holds the question in '
  + 'one field and the data it refers to in others.'

const CHOICE_CRITERIA_DESCRIPTION =
  'Every option the answer may choose, mapped to the situation that option describes.'

const SCORE_CRITERIA_DESCRIPTION =
  'Level descriptions from lowest to highest; the answer scores against them.'

const NOUL_CRITERIA_DESCRIPTION = 'Optional descriptions of what yes and no mean, keyed `true` and `false`.'

/** One schema-checked question argument: the union the parameter schema infers. */
type QuestionArgs =
  | { id: string; type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { id: string; type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { id: string; type: 'score'; instructions: unknown; criteria: unknown[] }

/**
 * Register the `typesafe_decide` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment endpoints, model, timeout, and credential reference.
 */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? TYPESAFE_DEFAULT_API_KEY_ENV
  const baseURL = (config.baseURL ?? TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = config.model ?? TYPESAFE_DEFAULT_MODEL
  const timeoutMs = config.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS
  const retry: RetryPolicy = {
    maxRetries: config.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    backoffInitialMs: config.retryBackoffMs ?? DEFAULT_RETRY_POLICY.backoffInitialMs,
    backoffMaxMs: config.retryBackoffMaxMs ?? DEFAULT_RETRY_POLICY.backoffMaxMs,
    jitter: config.retryJitter ?? DEFAULT_RETRY_POLICY.jitter,
    respectRetryAfter: config.respectRetryAfter ?? DEFAULT_RETRY_POLICY.respectRetryAfter,
    retryAfterMaxMs: config.retryAfterMaxMs ?? DEFAULT_RETRY_POLICY.retryAfterMaxMs,
  }
  const gateway = new SystemOneGateway({ baseURL, timeoutMs, retry })

  /**
   * Resolve the API key at call time so a rotated credential reaches the next call.
   * @returns the trimmed, usable key.
   * @throws Error when no layer supplies a key or the supplied key is unusable; the message names
   *   the reference, never the key.
   */
  const resolveApiKey = async (): Promise<string> => {
    if (config.apiKey !== undefined) return assertUsableApiKey(config.apiKey, 'the configured `apiKey`')
    if (!isCredentialRefName(apiKeyEnv)) {
      throw new Error(`tool-typesafe: apiKeyEnv ${JSON.stringify(apiKeyEnv)} is not an environment-variable name`)
    }
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, apiKeyEnv)
    } else {
      // Without the seam the launching environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, apiKeyEnv)
    }
    throw new Error(
      `tool-typesafe: no TypeSafe API key; store ${apiKeyEnv} through the credentials service (the web `
      + `Models page writes it), set the plugin's \`apiKey\` config field, or export ${apiKeyEnv} in the `
      + 'launching environment',
    )
  }

  ctx.tools.register(defineTool({
    name: 'typesafe_decide',
    description: DESCRIPTION,
    parameters: {
      state: { type: 'json', required: true, description: STATE_DESCRIPTION },
      questions: {
        type: 'array',
        required: true,
        description: QUESTIONS_DESCRIPTION,
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: QUESTION_ID_DESCRIPTION },
                type: { type: 'string', required: true, const: 'choice', description: 'Pick one option from `criteria`.' },
                instructions: { type: 'json', required: true, description: INSTRUCTIONS_DESCRIPTION },
                criteria: { type: 'object', required: true, additionalProperties: true, description: CHOICE_CRITERIA_DESCRIPTION },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: QUESTION_ID_DESCRIPTION },
                type: { type: 'string', required: true, const: 'noul', description: 'Answer a yes/no question with the probability of yes.' },
                instructions: { type: 'json', required: true, description: INSTRUCTIONS_DESCRIPTION },
                criteria: {
                  type: 'object',
                  additionalProperties: false,
                  description: NOUL_CRITERIA_DESCRIPTION,
                  properties: {
                    true: { type: 'json', description: 'What yes means.' },
                    false: { type: 'json', description: 'What no means.' },
                  },
                },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: QUESTION_ID_DESCRIPTION },
                type: { type: 'string', required: true, const: 'score', description: 'Score the state against ordered levels.' },
                instructions: { type: 'json', required: true, description: INSTRUCTIONS_DESCRIPTION },
                criteria: { type: 'array', required: true, items: { type: 'json' }, description: SCORE_CRITERIA_DESCRIPTION },
              },
            },
          ],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          answers: { type: 'object', required: true, additionalProperties: true },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input_tokens: { type: 'integer', required: true },
              output_tokens: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDecision(value) }],
    },
    async execute(args, exec) {
      const state = normalizeState(args.state)
      const questions = toWireQuestions(args.questions)
      const apiKey = await resolveApiKey()
      const decision = await gateway.evaluate(apiKey, { state, model, questions }, exec.signal)
      assertAnswerIds(Object.keys(questions), decision.answers)
      return decision
    },
    presentCall: args => ({ card: 'generic', title: 'TypeSafe decide', kind: 'other', rawInput: args.questions }),
  }))
}

/**
 * Validate the constraints the parameter schema cannot express and project the question array into
 * the id-keyed map TypeSafe expects.
 *
 * The DSL expresses types, required keys, literal constraints, and exact-one unions, but not a
 * non-empty string, a key unique across array items, a bounded item count, or which JSON value
 * kinds a Choice description admits, so those checks live here. A rejected question never reaches
 * the API.
 * @param questions - schema-checked question arguments.
 * @returns the wire map: one question per id.
 * @throws Error naming the question and the violated constraint.
 */
function toWireQuestions(questions: readonly QuestionArgs[]): Record<string, unknown> {
  if (questions.length === 0) throw new Error('invalid questions: at least one question is required')
  const wire: Record<string, unknown> = {}
  for (const question of questions) {
    const id = question.id.trim()
    if (id.length === 0) throw new Error('invalid question: `id` must be a non-empty string')
    if (Object.hasOwn(wire, id)) throw new Error(`invalid questions: duplicate id ${JSON.stringify(id)}`)
    wire[id] = toWireQuestion(id, question)
  }
  return wire
}

/**
 * Project one question into its wire body.
 * @param id - the trimmed question id, used in diagnostics.
 * @param question - the schema-checked question.
 * @returns the wire question.
 * @throws Error when the question violates a constraint the schema cannot express.
 */
function toWireQuestion(id: string, question: QuestionArgs): Record<string, unknown> {
  const instructions = requireContent(id, question.instructions, 'instructions')
  if (question.type === 'choice') return choiceQuestion(id, instructions, question.criteria)
  if (question.type === 'score') return scoreQuestion(id, instructions, question.criteria)
  return noulQuestion(id, instructions, question.criteria)
}

/**
 * Build one Choice question body.
 * @param id - the question id, used in diagnostics.
 * @param instructions - the trimmed question.
 * @param criteria - option to description map.
 * @returns the wire question.
 * @throws Error for an empty or oversized option set, a blank option name, or a description that
 *   is not a string, object, array, or null.
 */
function choiceQuestion(id: string, instructions: unknown, criteria: Record<string, unknown>): Record<string, unknown> {
  const options = Object.entries(criteria)
  if (options.length === 0) {
    throw new Error(`invalid question ${JSON.stringify(id)}: \`criteria\` needs at least one option`)
  }
  if (options.length > MAX_CHOICE_OPTIONS) {
    throw new Error(`invalid question ${JSON.stringify(id)}: \`criteria\` accepts at most ${String(MAX_CHOICE_OPTIONS)} options`)
  }
  for (const [option, description] of options) {
    if (option.trim().length === 0) {
      throw new Error(`invalid question ${JSON.stringify(id)}: every \`criteria\` key must be a non-empty option name`)
    }
    if (!isStructuredDescription(description)) {
      throw new Error(`invalid question ${JSON.stringify(id)}: the description for option ${JSON.stringify(option)} must be a string, object, array, or null`)
    }
  }
  return { type: 'choice', instructions, criteria }
}

/**
 * Build one Score question body.
 * @param id - the question id, used in diagnostics.
 * @param instructions - the trimmed question.
 * @param criteria - ordered level descriptions.
 * @returns the wire question.
 * @throws Error for a level count outside the supported range or a blank level description.
 */
function scoreQuestion(id: string, instructions: unknown, criteria: readonly unknown[]): Record<string, unknown> {
  if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
    throw new Error(
      `invalid question ${JSON.stringify(id)}: \`criteria\` needs ${String(MIN_SCORE_LEVELS)} to `
      + `${String(MAX_SCORE_LEVELS)} levels, from lowest to highest`,
    )
  }
  const levels = criteria.map(level => requireContent(id, level, 'criteria level', true))
  return { type: 'score', instructions, criteria: levels }
}

/**
 * Build one Noul question body.
 * @param id - the question id, used in diagnostics.
 * @param instructions - the trimmed question.
 * @param criteria - optional yes/no descriptions.
 * @returns the wire question.
 * @throws Error when `criteria` is present but carries no usable description.
 */
function noulQuestion(
  id: string,
  instructions: unknown,
  criteria?: { true?: unknown; false?: unknown },
): Record<string, unknown> {
  if (criteria === undefined) return { type: 'noul', instructions }
  const described: Record<string, unknown> = {}
  if (criteria.true !== undefined) described['true'] = requireContent(id, criteria.true, 'true', true)
  if (criteria.false !== undefined) described['false'] = requireContent(id, criteria.false, 'false', true)
  if (Object.keys(described).length === 0) {
    throw new Error(`invalid question ${JSON.stringify(id)}: \`criteria\` needs a \`true\` or \`false\` description when present`)
  }
  return { type: 'noul', instructions, criteria: described }
}

/**
 * Normalize one supplied `state`. Text keeps its trimmed form; an object or array travels unchanged
 * so the questions can refer to its fields.
 * @param value - the schema-checked `state` argument.
 * @returns the state to send.
 * @throws Error when the value is neither non-empty text nor a non-empty object or array.
 */
function normalizeState(value: unknown): TypeSafeState {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new Error('invalid state: `state` must be a non-empty string')
    return trimmed
  }
  if (typeof value === 'object' && value !== null) {
    if (!isNonEmptyStructure(value)) throw new Error('invalid state: `state` must not be an empty object or array')
    return value as TypeSafeState
  }
  throw new Error('invalid state: `state` must be a string, an object, or an array')
}

/**
 * Normalize one instructions or criteria value and reject the shapes TypeSafe does not accept.
 * @param id - the question id, used in diagnostics.
 * @param value - the supplied value.
 * @param field - the field name the thrown message names.
 * @returns the trimmed string, or the structure unchanged.
 * @throws Error when the value is neither non-empty text nor a non-empty object or array.
 */
function requireContent(id: string, value: unknown, field: string, allowNull = false): unknown {
  if (value === null && allowNull) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      throw new Error(`invalid question ${JSON.stringify(id)}: \`${field}\` must be a non-empty string`)
    }
    return trimmed
  }
  if (typeof value === 'object' && value !== null) {
    if (!isNonEmptyStructure(value)) {
      throw new Error(`invalid question ${JSON.stringify(id)}: \`${field}\` must not be an empty object or array`)
    }
    return value
  }
  throw new Error(`invalid question ${JSON.stringify(id)}: \`${field}\` must be a string, an object, or an array`)
}

/**
 * True when a structure carries content: a non-empty array, or an object with at least one key.
 * @param value - the object or array to inspect.
 * @returns whether the structure is non-empty.
 */
function isNonEmptyStructure(value: object): boolean {
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
}

/**
 * True for a Choice description: a string, an object, an array, or null, which is what TypeSafe
 * accepts. A number or boolean is rejected rather than silently forwarded.
 * @param value - the supplied description.
 * @returns whether TypeSafe accepts the description.
 */
function isStructuredDescription(value: unknown): boolean {
  if (typeof value === 'string' || value === null) return true
  return typeof value === 'object'
}
