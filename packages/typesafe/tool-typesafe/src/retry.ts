/**
 * The retry policy this package applies to TypeSafe requests. The defaults mirror the policy
 * TypeSafe documents for its own client SDKs: two retries with exponential backoff, jitter, and a
 * provider-requested `Retry-After` delay honored up to a ceiling.
 * @module @deepseek-ai/dsh-tool-typesafe/retry
 */

/** One resolved retry policy. */
export interface RetryPolicy {
  /** Retries after the first attempt; `0` disables retrying. */
  readonly maxRetries: number
  /** First backoff delay in milliseconds; it doubles per attempt. */
  readonly backoffInitialMs: number
  /** Ceiling for a computed backoff delay, in milliseconds. */
  readonly backoffMaxMs: number
  /** Fraction of a delay applied as symmetric random jitter, from 0 to 1. */
  readonly jitter: number
  /** Whether a provider `Retry-After` replaces the computed backoff. */
  readonly respectRetryAfter: boolean
  /** Ceiling for a provider-requested delay, in milliseconds. */
  readonly retryAfterMaxMs: number
}

/** TypeSafe's documented default retry policy. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5_000,
  jitter: 0.25,
  respectRetryAfter: true,
  retryAfterMaxMs: 60_000,
}

/**
 * Whether one HTTP status is worth another attempt: the request timed out, hit the rate limit, or
 * the provider failed. TypeSafe documents 429, 529 (`>= 500`), and retrying with backoff.
 * @param status - the response status.
 * @returns whether the request may be retried.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * The delay before one retry.
 *
 * A provider-requested delay wins over the computed backoff, bounded by the policy ceiling. The
 * computed backoff doubles per attempt up to its own ceiling, then spreads symmetrically by the
 * jitter fraction.
 * @param policy - the resolved policy.
 * @param attempt - zero-based index of the attempt that just failed.
 * @param requestedMs - delay the provider asked for, when it sent one.
 * @param random - randomness source in `[0, 1)`; tests pass a fixed one.
 * @returns the delay in milliseconds.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  requestedMs?: number,
  random: () => number = Math.random,
): number {
  if (policy.respectRetryAfter && requestedMs !== undefined) {
    return Math.min(Math.max(requestedMs, 0), policy.retryAfterMaxMs)
  }
  const base = Math.min(policy.backoffInitialMs * 2 ** attempt, policy.backoffMaxMs)
  const spread = base * policy.jitter
  return Math.max(0, Math.round(base - spread + random() * spread * 2))
}

/**
 * Read a provider-requested delay from response headers. Both documented forms are read:
 * `retry-after-ms` as milliseconds, and `retry-after` as seconds or an HTTP-date.
 * @param headers - the response headers.
 * @param now - current epoch milliseconds, for the HTTP-date form.
 * @returns the delay in milliseconds, or undefined when the provider asked for none.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const milliseconds = headers.get('retry-after-ms')
  if (milliseconds !== null) {
    const value = Number(milliseconds)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const header = headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
