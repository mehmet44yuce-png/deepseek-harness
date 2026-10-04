/**
 * Wire vocabulary of TypeSafe's System One endpoint: the answer variants the API returns, the
 * usage counters, and the response envelope the `typesafe_decide` tool returns unchanged. Question
 * arguments are typed by the tool's parameter schema in `./index.ts`, not here.
 * @module @deepseek-ai/dsh-tool-typesafe/types
 */

/** The probability that a Noul question's answer is yes. */
export type NoulAnswer = {
  /** Discriminant matching the question that produced this answer. */
  readonly type: 'noul'
  /** Probability the statement is true, from 0 to 1. */
  readonly noul: number
}

/** The option a Choice question selected, with the full option distribution. */
export type ChoiceAnswer = {
  /** Discriminant matching the question that produced this answer. */
  readonly type: 'choice'
  /** The highest-probability option. */
  readonly choice: string
  /** Every option the question declared, mapped to its probability; values sum to 1. */
  readonly probabilities: Readonly<Record<string, number>>
  /** How certain the model is, derived from the distribution. */
  readonly confidence: number
}

/** The level a Score question landed on, with the level distribution and its legend. */
export type ScoreAnswer = {
  /** Discriminant matching the question that produced this answer. */
  readonly type: 'score'
  /** Probability-weighted score across the levels; it may land between levels. */
  readonly score: number
  /** Each level index, as a string key, mapped back to its declared description, which may be
   * structured JSON. */
  readonly legend: { [key: string]: TypeSafeJson }
  /** Every level index mapped to its probability; values sum to 1. */
  readonly probabilities: Readonly<Record<string, number>>
  /** How certain the model is, derived from the distribution. */
  readonly confidence: number
}

/** One decoded answer, discriminated by the question type that produced it. */
export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** One JSON value: the vocabulary TypeSafe reads in a state and returns in an answer. */
export type TypeSafeJson = null | boolean | number | string | TypeSafeJson[] | { [key: string]: TypeSafeJson }

/** The state one evaluation judges: text, or structured JSON the questions refer to by field. */
export type TypeSafeState = string | TypeSafeJson[] | { [key: string]: TypeSafeJson }

/** Token usage TypeSafe reports for one evaluation. */
export type TypeSafeUsage = {
  /** Prompt tokens TypeSafe counted. */
  readonly input_tokens: number
  /** Answer tokens TypeSafe counted. */
  readonly output_tokens: number
}

/** The canonical result of one evaluation, returned to the model and preserved on replay. */
export type TypeSafeDecision = {
  /** The model that performed the evaluation, as TypeSafe reports it. */
  readonly model: string
  /** One answer per question, keyed by the id the caller supplied. */
  readonly answers: Readonly<Record<string, TypeSafeAnswer>>
  /** Token usage, absent when TypeSafe reports none. */
  readonly usage?: TypeSafeUsage
}
