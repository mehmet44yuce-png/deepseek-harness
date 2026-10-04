/**
 * Native rendering of one decoded decision: the model line, then one compact line per answer, with
 * the level legend inlined for score answers. Pure, so it also runs when a session is replayed.
 * @module @deepseek-ai/dsh-tool-typesafe/render
 */

/** The decision fields rendering reads; loose so a policy-replaced value still renders. */
export interface RenderedDecision {
  /** The model that performed the evaluation. */
  readonly model: string
  /** One raw answer per question id. */
  readonly answers: Readonly<Record<string, unknown>>
  /** Token counters TypeSafe reported, when it reported any. */
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown }
}

/**
 * Render one decision as model-facing text.
 * @param decision - the validated canonical value.
 * @returns the text body: the model line, one line per answer, then the token line when the
 *   provider reported usage.
 */
export function renderDecision(decision: RenderedDecision): string {
  const usage = renderUsage(decision.usage)
  const lines = [`TypeSafe ${decision.model}`, ...renderAnswers(decision.answers)]
  return (usage === undefined ? lines : [...lines, usage]).join('\n')
}

/**
 * Render the provider's token counters as the closing line.
 * @param usage - the raw usage object, absent when TypeSafe reported none.
 * @returns the token line, or undefined when neither counter is a number.
 */
function renderUsage(usage: RenderedDecision['usage']): string | undefined {
  if (usage === undefined) return undefined
  const input = usage.input_tokens
  const output = usage.output_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  const count = (value: unknown): number => typeof value === 'number' ? value : 0
  return `tokens: ${String(count(input))} in, ${String(count(output))} out`
}

/**
 * Render one answer map, keeping the order TypeSafe returned.
 * @param answers - one raw answer per question id.
 * @returns one line per answer.
 */
export function renderAnswers(answers: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(answers).map(([id, answer]) => `${id}: ${describeAnswer(answer)}`)
}

/**
 * Describe one answer in one line, falling back to its JSON form for an unrecognized body.
 * @param answer - the raw answer.
 * @returns the answer description.
 */
function describeAnswer(answer: unknown): string {
  if (!isRecord(answer)) return JSON.stringify(answer)
  const type = answer['type']
  if (type === 'noul' && typeof answer['noul'] === 'number') {
    return `noul ${formatNumber(answer['noul'])}`
  }
  if (type === 'choice' && typeof answer['choice'] === 'string' && typeof answer['confidence'] === 'number') {
    const confidence = formatNumber(answer['confidence'])
    return `choice ${answer['choice']} (confidence ${confidence}; ${formatDistribution(answer['probabilities'])})`
  }
  if (type === 'score' && typeof answer['score'] === 'number' && typeof answer['confidence'] === 'number') {
    const confidence = formatNumber(answer['confidence'])
    const distribution = formatDistribution(answer['probabilities'], answer['legend'])
    return `score ${formatNumber(answer['score'])} (confidence ${confidence}; ${distribution})`
  }
  return JSON.stringify(answer)
}

/**
 * Format one probability distribution as `label value` pairs, using legend labels when present.
 * @param probabilities - the raw distribution.
 * @param legend - the optional level-index to description map.
 * @returns the comma-separated distribution.
 */
function formatDistribution(probabilities: unknown, legend?: unknown): string {
  if (!isRecord(probabilities)) return 'no distribution'
  return Object.entries(probabilities)
    .map(([key, value]) => `${levelLabel(key, legend)} ${typeof value === 'number' ? formatNumber(value) : '?'}`)
    .join(', ')
}

/**
 * Resolve one distribution key to its level description.
 * @param key - the level index or option name.
 * @param legend - the optional level-index to description map.
 * @returns the description, or the key when no description applies.
 */
function levelLabel(key: string, legend: unknown): string {
  if (!isRecord(legend)) return key
  const label = legend[key]
  if (typeof label === 'string' && label.length > 0) return label
  if (label !== null && typeof label === 'object') return JSON.stringify(label)
  return key
}

/**
 * Format one number without trailing zeros, so 1 and 0.95 stay short and stable.
 * @param value - the number to format.
 * @returns the decimal string.
 */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * True for a JSON object: never null, never an array.
 * @param value - the candidate.
 * @returns whether the value is a string-keyed object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
