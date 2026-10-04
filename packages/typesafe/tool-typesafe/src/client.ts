/**
 * HTTP gateway for TypeSafe's System One endpoint, the response decoder, and the HTTP-status
 * diagnostics. One request carries a state and a map of typed questions; the response carries one
 * answer per question id.
 * @module @deepseek-ai/dsh-tool-typesafe/client
 */

import { isRetryableStatus, retryAfterMs, retryDelayMs } from './retry.ts'
import type { RetryPolicy } from './retry.ts'
import type { TypeSafeAnswer, TypeSafeDecision, TypeSafeJson, TypeSafeState, TypeSafeUsage } from './types.ts'

/** Vendor default endpoint; the `systemone` operation is appended. */
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'

/** Attribution header sent on every request; versionless because the package version is the release's. */
const USER_AGENT = 'deepseek-harness'

/** Longest provider diagnostic quoted into an error message. */
const MAX_ERROR_DETAIL = 300

/** One System One request body. */
export interface SystemOneRequest {
  /** The content the questions judge. */
  readonly state: TypeSafeState
  /** The model TypeSafe evaluates with. */
  readonly model: string
  /** Questions keyed by the id their answer must come back under. */
  readonly questions: Readonly<Record<string, unknown>>
}

/** Resolved gateway options, supplied by the plugin config. */
export interface SystemOneGatewayOptions {
  /** Endpoint base; `/systemone` is appended. */
  readonly baseURL: string
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Policy applied to retryable failures. */
  readonly retry: RetryPolicy
}

/**
 * Failure the gateway may retry. It carries the delay the provider asked for, when it sent one, so
 * the retry loop can honor `Retry-After` instead of its own backoff.
 */
class RetryableFailure extends Error {
  /** Provider-requested delay before the next attempt, when it sent one. */
  readonly retryAfterMs: number | undefined

  /**
   * @param message - the diagnostic the model reads when retries are exhausted.
   * @param retryAfterMs - provider-requested delay in milliseconds.
   */
  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Wait before one retry, abandoning the wait when the caller cancels.
 * @param ms - the delay in milliseconds.
 * @param signal - caller cancellation.
 * @returns a promise settled after the delay.
 * @throws Error when the caller cancels during the wait.
 */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('tool-typesafe: the TypeSafe request was cancelled before it answered'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sends System One evaluations over HTTPS. The request refuses redirects so the API key cannot be
 * forwarded to another origin, and the caller's cancellation signal is fused with a per-request
 * timeout.
 */
export class SystemOneGateway {
  constructor(private readonly options: SystemOneGatewayOptions) {}

  /**
   * Evaluate one request and decode the answer envelope.
   * @param apiKey - usable API key, already trimmed and checked.
   * @param request - state, model, and questions.
   * @param signal - caller cancellation; aborting it abandons the request.
   * @returns the decoded decision.
   * @throws Error for cancellation, timeout, transport, HTTP-status, and undecodable-body failures.
   */
  async evaluate(apiKey: string, request: SystemOneRequest, signal: AbortSignal): Promise<TypeSafeDecision> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(apiKey, request, signal)
      } catch (error: unknown) {
        if (!(error instanceof RetryableFailure) || attempt >= this.options.retry.maxRetries || signal.aborted) throw error
        await delay(retryDelayMs(this.options.retry, attempt, error.retryAfterMs), signal)
      }
    }
  }

  /**
   * Send one attempt and decode its answer envelope.
   * @param apiKey - usable API key, already trimmed and checked.
   * @param request - state, model, and questions.
   * @param signal - caller cancellation; aborting it abandons the request.
   * @returns the decoded decision.
   * @throws RetryableFailure for retryable statuses and transport failures, and Error otherwise.
   */
  private async attempt(apiKey: string, request: SystemOneRequest, signal: AbortSignal): Promise<TypeSafeDecision> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const fused = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/systemone`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(request),
        signal: fused,
      })
    } catch (error: unknown) {
      throw transportFailure(error, signal, timeout, this.options)
    }
    if (!response.ok) throw await httpFailure(response)
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      // A body that fails mid-read is a transport fact when the caller or the timeout aborted it;
      // otherwise the body was not JSON, which no HTTP status reports.
      if (signal.aborted || timeout.aborted) throw transportFailure(error, signal, timeout, this.options)
      throw new Error('tool-typesafe: TypeSafe returned a body that is not JSON')
    }
    return parseDecision(payload)
  }
}

/**
 * Classify one failed fetch. Cancellation and the timeout stay separate from a transport failure,
 * because the caller must tell a stopped request from an unreachable TypeSafe.
 * @param error - the rejection from `fetch` or from reading its body.
 * @param signal - the caller cancellation signal.
 * @param timeout - the per-request timeout signal.
 * @param options - resolved gateway options, for the timeout value in the message.
 * @returns the error to throw.
 */
function transportFailure(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  options: SystemOneGatewayOptions,
): Error {
  if (signal.aborted) return new Error('tool-typesafe: the TypeSafe request was cancelled before it answered')
  if (timeout.aborted) {
    return new RetryableFailure(`tool-typesafe: the TypeSafe request did not answer within ${String(options.timeoutMs)} ms`)
  }
  const detail = errorChain(error)
  if (/redirect/i.test(detail)) {
    return new Error('tool-typesafe: TypeSafe answered with a redirect; refusing to forward the API key to another origin')
  }
  return new RetryableFailure(`tool-typesafe: the TypeSafe request could not be completed: ${detail}`)
}

/**
 * Join one error and its causes into a single diagnostic line.
 * @param error - the thrown value.
 * @returns the message chain, or the stringified value when it is not an `Error`.
 */
function errorChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if (current.message.length > 0) parts.push(current.message)
    current = current.cause
  }
  return parts.length > 0 ? parts.join(': ') : String(error)
}

/**
 * Map one non-2xx response to the error the model and the operator see. The credential-rejection
 * path never reads the body, so a provider echo cannot leak the key.
 * @param response - the non-2xx response.
 * @returns the error to throw.
 */
async function httpFailure(response: Response): Promise<Error> {
  const status = response.status
  const trace = requestIdSuffix(response)
  if (status === 401) {
    return new Error(`tool-typesafe: TypeSafe rejected the API key (HTTP 401); check the configured key or credential reference${trace}`)
  }
  if (status === 422) {
    const detail = await errorDetail(response)
    const suffix = detail === undefined ? '' : `: ${detail}`
    return new Error(`tool-typesafe: TypeSafe rejected the request body (HTTP 422); check the questions and the state against its limits${suffix}${trace}`)
  }
  if (isRetryableStatus(status)) {
    const requested = retryAfterMs(response.headers)
    if (status === 429) {
      return new RetryableFailure(`tool-typesafe: TypeSafe rate limit exceeded (HTTP 429); retry after a short delay${trace}`, requested)
    }
    if (status === 408) {
      return new RetryableFailure(`tool-typesafe: TypeSafe timed out the request (HTTP 408); retry after a short delay${trace}`, requested)
    }
    return new RetryableFailure(
      `tool-typesafe: TypeSafe is unavailable or overloaded (HTTP ${String(status)}); retry after a short delay${trace}`,
      requested,
    )
  }
  const detail = await errorDetail(response)
  const suffix = detail === undefined ? '' : `: ${detail}`
  return new Error(`tool-typesafe: TypeSafe rejected the request (HTTP ${String(status)})${suffix}${trace}`)
}

/**
 * Name the provider's request id, which its support uses to trace one call.
 * @param response - the failing response.
 * @returns the message suffix, empty when the provider sent no request id.
 */
function requestIdSuffix(response: Response): string {
  const id = response.headers.get('x-typesafe-request-id')
  return id === null || id.length === 0 ? '' : ` [request id ${id}]`
}

/**
 * Read a bounded diagnostic from a provider error body.
 * @param response - the non-2xx response whose body may describe the rejection.
 * @returns the trimmed detail, truncated to a bounded length, or undefined for an empty body.
 */
async function errorDetail(response: Response): Promise<string | undefined> {
  let text = ''
  try {
    text = await response.text()
  } catch (error: unknown) {
    // Ignored: a body that cannot be read costs only a richer diagnostic. The status is already
    // named by the caller, and the read failure cannot change the diagnosis.
    void error
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed
}

/**
 * Decode one response body into the canonical decision, rejecting any field the tool could not
 * report honestly. TypeSafe is a wire boundary, so this validates rather than trusting the body.
 * @param payload - the parsed JSON body.
 * @returns the canonical decision.
 * @throws Error naming the field that failed.
 */
export function parseDecision(payload: unknown): TypeSafeDecision {
  if (!isRecord(payload)) throw invalidResponse('the body is not an object')
  const model = payload['model']
  if (typeof model !== 'string' || model.length === 0) throw invalidResponse('`model` is missing')
  const rawAnswers = payload['answers']
  if (!isRecord(rawAnswers)) throw invalidResponse('`answers` is missing')
  const answers: Record<string, TypeSafeAnswer> = {}
  for (const [id, raw] of Object.entries(rawAnswers)) answers[id] = parseAnswer(id, raw)
  const usage = parseUsage(payload['usage'])
  return usage === undefined ? { model, answers } : { model, answers, usage }
}

/**
 * Decode one answer by its discriminant.
 * @param id - the question id the answer belongs to, used in diagnostics.
 * @param raw - the raw answer value.
 * @returns the decoded answer.
 * @throws Error when the discriminant is unknown or a required field is missing or mistyped.
 */
function parseAnswer(id: string, raw: unknown): TypeSafeAnswer {
  const where = `answer ${JSON.stringify(id)}`
  if (!isRecord(raw)) throw invalidResponse(`${where} is not an object`)
  const type = raw['type']
  switch (type) {
    case 'noul':
      return { type: 'noul', noul: readNumber(raw, 'noul', where) }
    case 'choice':
      return {
        type: 'choice',
        choice: readString(raw, 'choice', where),
        probabilities: readNumberMap(raw, 'probabilities', where),
        confidence: readNumber(raw, 'confidence', where),
      }
    case 'score':
      return {
        type: 'score',
        score: readNumber(raw, 'score', where),
        legend: readLegendMap(raw, 'legend', where),
        probabilities: readNumberMap(raw, 'probabilities', where),
        confidence: readNumber(raw, 'confidence', where),
      }
    default:
      throw invalidResponse(`${where} has unknown type ${JSON.stringify(type)}`)
  }
}

/**
 * Decode the optional usage counters.
 * @param raw - the raw `usage` value, or undefined when TypeSafe reported none.
 * @returns the decoded usage, or undefined.
 * @throws Error when usage is present but malformed.
 */
function parseUsage(raw: unknown): TypeSafeUsage | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw invalidResponse('`usage` is not an object')
  return {
    input_tokens: readInteger(raw, 'input_tokens', 'usage'),
    output_tokens: readInteger(raw, 'output_tokens', 'usage'),
  }
}

/**
 * Read one finite number field.
 * @param source - the object holding the field.
 * @param key - the field name.
 * @param where - the owning value, named in the failure.
 * @returns the finite number.
 * @throws Error when the field is missing or not a finite number.
 */
function readNumber(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidResponse(`${where} has no finite number at '${key}'`)
  return value
}

/**
 * Read one non-negative integer field.
 * @param source - the object holding the field.
 * @param key - the field name.
 * @param where - the owning value, named in the failure.
 * @returns the integer.
 * @throws Error when the field is missing or not a non-negative integer.
 */
function readInteger(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidResponse(`${where} has no non-negative integer at '${key}'`)
  }
  return value
}

/**
 * Read one non-empty string field.
 * @param source - the object holding the field.
 * @param key - the field name.
 * @param where - the owning value, named in the failure.
 * @returns the string.
 * @throws Error when the field is missing or not a string.
 */
function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw invalidResponse(`${where} has no string at '${key}'`)
  return value
}

/**
 * Read one `{key: number}` map.
 * @param source - the object holding the map.
 * @param key - the field name.
 * @param where - the owning value, named in the failure.
 * @returns the copied map.
 * @throws Error when the field is missing, not an object, or holds a non-finite value.
 */
function readNumberMap(source: Record<string, unknown>, key: string, where: string): Record<string, number> {
  const raw = source[key]
  if (!isRecord(raw)) throw invalidResponse(`${where} has no '${key}' object`)
  const map: Record<string, number> = {}
  for (const [entry, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidResponse(`${where} has no finite number at '${key}.${entry}'`)
    }
    map[entry] = value
  }
  return map
}

/**
 * Read one `{key: description}` legend map. A Score level may be described with structured JSON,
 * so values are copied through rather than required to be strings.
 * @param source - the object holding the map.
 * @param key - the field name.
 * @param where - the owning value, named in the failure.
 * @returns the copied map.
 * @throws Error when the field is missing or not an object.
 */
function readLegendMap(source: Record<string, unknown>, key: string, where: string): { [key: string]: TypeSafeJson } {
  const raw = source[key]
  if (!isRecord(raw)) throw invalidResponse(`${where} has no '${key}' object`)
  // The body is parsed JSON, so every entry already is a JSON value.
  return { ...raw } as { [key: string]: TypeSafeJson }
}

/**
 * True for a JSON object: never null, never an array.
 * @param value - the candidate.
 * @returns whether the value is a string-keyed object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One response-decoding failure.
 * @param detail - what the body failed on.
 * @returns the error to throw.
 */
function invalidResponse(detail: string): Error {
  return new Error(`tool-typesafe: unexpected response from TypeSafe: ${detail}`)
}

/**
 * Require the response to answer exactly the questions that were asked.
 *
 * TypeSafe keys answers by the ids the caller supplied, so a missing or unexpected id means the
 * request and the response do not describe the same evaluation. Reporting it as an error keeps a
 * caller from treating a dropped question as answered, or from reading an answer to a question it
 * never asked.
 * @param requested - the question ids sent, in order.
 * @param answers - the decoded answer map.
 * @throws Error naming the first missing or unexpected id.
 */
export function assertAnswerIds(requested: readonly string[], answers: Readonly<Record<string, unknown>>): void {
  const returned = new Set(Object.keys(answers))
  for (const id of requested) {
    if (!returned.delete(id)) throw invalidResponse(`no answer for question ${JSON.stringify(id)}`)
  }
  const unexpected = returned.values().next()
  if (!unexpected.done) {
    throw invalidResponse(`answer for unknown question ${JSON.stringify(unexpected.value)}`)
  }
}
