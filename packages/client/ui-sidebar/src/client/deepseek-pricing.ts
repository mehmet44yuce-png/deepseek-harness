/**
 * DeepSeek pricing tiers, derived from the official API's peak/off-peak billing
 * calendar. Purely calendar-driven — no network or clock injection.
 */

/** One half-open `[start, end)` window in minutes since UTC midnight. */
export interface UtcMinuteWindow {
  /** Window start, minutes since UTC midnight (0..1439). */
  start: number
  /** Window end, minutes since UTC midnight (exclusive; 1..1440). */
  end: number
}

/**
 * DeepSeek API peak windows, in UTC. Peak billing (the standard rate) applies
 * only Monday–Friday inside these windows; all other times — outside the
 * windows and all of Saturday/Sunday — bill the off-peak (discounted) rate.
 *
 * DeepSeek moved to peak/off-peak billing on 2026-08-16. This pins that
 * external pricing schedule; update it only when DeepSeek changes the window.
 * Source: https://api-docs.deepseek.com/quick_start/pricing
 */
export const DEEPSEEK_UTC_PEAK_WINDOWS: readonly UtcMinuteWindow[] = [
  { start: 1 * 60, end: 4 * 60 },   // 01:00–04:00 UTC
  { start: 6 * 60, end: 10 * 60 },  // 06:00–10:00 UTC
]

/** Pricing tier: peak = standard (expensive) rate; offpeak = discounted (cheap). */
export type DeepseekPricingTier = 'peak' | 'offpeak'

/** getUTCDay: 0 = Sunday … 6 = Saturday; peak windows apply only Mon–Fri. */
function isWeekdayUtc(date: Date): boolean {
  const day = date.getUTCDay()
  return day >= 1 && day <= 5
}

/**
 * Classify an instant against the DeepSeek UTC peak windows. A weekday inside a
 * peak window is `'peak'`; everything else (weekday off-window, and the whole
 * weekend) is `'offpeak'`. UTC fields are read, so the result is independent of
 * the host timezone.
 * @param date - the instant to classify.
 * @param windows - peak windows; defaults to {@link DEEPSEEK_UTC_PEAK_WINDOWS}.
 * @returns the pricing tier for that instant.
 */
export function deepseekPricingTier(
  date: Date,
  windows: readonly UtcMinuteWindow[] = DEEPSEEK_UTC_PEAK_WINDOWS,
): DeepseekPricingTier {
  if (!isWeekdayUtc(date)) return 'offpeak'
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return windows.some(({ start, end }) => start <= minute && minute < end) ? 'peak' : 'offpeak'
}
