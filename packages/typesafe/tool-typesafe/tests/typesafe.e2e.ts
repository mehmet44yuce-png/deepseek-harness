import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRY_POLICY, SystemOneGateway } from '@deepseek-ai/dsh-tool-typesafe'

/**
 * Disabled real-API probe: the recorded request and response shapes come from TypeSafe's
 * published API reference, and only a live key can confirm the wire itself.
 */
const apiKey = process.env['TYPESAFE_API_KEY']
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('SystemOneGateway real API', () => {
  it('answers a noul and a choice question against a live state', async () => {
    const gateway = new SystemOneGateway({
      baseURL: 'https://api.typesafe.ai/v1',
      timeoutMs: 40_000,
      retry: DEFAULT_RETRY_POLICY,
    })
    const decision = await gateway.evaluate(apiKey ?? '', {
      state: 'A customer cannot connect their payment account and is losing sales.',
      model: 'jev-latest',
      questions: {
        urgency: { type: 'noul', instructions: 'Does this message convey urgency?' },
        area: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { payments: 'Payment or payout issues', technical: 'Integration or API problems' },
        },
      },
    }, AbortSignal.timeout(45_000))

    expect(decision.model).toMatch(/^jev/)
    expect(decision.answers['urgency']?.type).toBe('noul')
    expect(decision.answers['area']?.type).toBe('choice')
  }, 60_000)
})
