import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'

it('keeps the scheduler accessible to a separately loaded consumer', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
    vi.resetModules()
    const consumer = await import('@deepseek-ai/dsh-tools')
    expect(ctx.tools[consumer.TOOL_RUNTIME_SCHEDULER]).toBe(scheduler)
    expect(typeof scheduler.prepare).toBe('function')
  } finally {
    await ctx.fiber.dispose()
  }
})
