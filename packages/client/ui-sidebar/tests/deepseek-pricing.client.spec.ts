import { describe, expect, it } from 'vitest'
import {
  deepseekPricingTier, DEEPSEEK_UTC_PEAK_WINDOWS, type UtcMinuteWindow,
} from '../src/client/deepseek-pricing.ts'

/** UTC instant helper: weekday is intentional — 2026-01-05 is a Monday. */
const utc = (year: number, month: number, day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(year, month, day, hour, minute))

describe('deepseekPricingTier', () => {
  it('is peak inside a weekday UTC window', () => {
    // Monday 02:00 UTC falls inside 01:00–04:00.
    expect(deepseekPricingTier(utc(2026, 0, 5, 2))).toBe('peak')
    // Monday 09:00 UTC falls inside 06:00–10:00.
    expect(deepseekPricingTier(utc(2026, 0, 5, 9))).toBe('peak')
  })

  it('is off-peak on a weekday outside every window', () => {
    expect(deepseekPricingTier(utc(2026, 0, 5, 12))).toBe('offpeak')
    expect(deepseekPricingTier(utc(2026, 0, 5, 0, 30))).toBe('offpeak')
  })

  it('treats window ends as exclusive', () => {
    expect(deepseekPricingTier(utc(2026, 0, 5, 4))).toBe('offpeak')
    expect(deepseekPricingTier(utc(2026, 0, 5, 10))).toBe('offpeak')
  })

  it('is off-peak all weekend even inside a weekday window time', () => {
    // Saturday 2026-01-10 and Sunday 2026-01-11 at 02:00 UTC.
    expect(deepseekPricingTier(utc(2026, 0, 10, 2))).toBe('offpeak')
    expect(deepseekPricingTier(utc(2026, 0, 11, 2))).toBe('offpeak')
  })

  it('honors a caller-supplied window override', () => {
    const custom: UtcMinuteWindow[] = [{ start: 0, end: 60 }]
    expect(deepseekPricingTier(utc(2026, 0, 5, 0, 30), custom)).toBe('peak')
    // Out of the custom window, still default flat weekdays are off-peak.
    expect(deepseekPricingTier(utc(2026, 0, 5, 2), custom)).toBe('offpeak')
  })

  it('pins the shipped DeepSeek UTC peak windows', () => {
    expect(DEEPSEEK_UTC_PEAK_WINDOWS).toEqual([
      { start: 60, end: 240 },
      { start: 360, end: 600 },
    ])
  })
})
