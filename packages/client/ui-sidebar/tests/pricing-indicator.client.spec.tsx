// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

const t: SidebarRootComponentProps['t'] = key =>
  (en as Record<string, string>)[key] ?? (commonEn as Record<string, string>)[key] ?? key

const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: SidebarRootComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

const PRICING_TICK_MS = 60_000

function mount(now: Date) {
  vi.useFakeTimers({ now })
  return render(<SidebarRoot
    collapsed={false} width={300}
    useSessions={neverHook} useSessionPendingInteraction={useSessionPendingInteraction} useWorkspaces={neverHook}
    startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
    renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
      options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
  />)
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('SidebarRoot DeepSeek pricing indicator', () => {
  it('renders an error dot and peak label during a UTC peak window', () => {
    // Monday 02:00 UTC (2026-01-05) is inside the 01:00–04:00 peak window.
    const { container } = mount(new Date(Date.UTC(2026, 0, 5, 2)))
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(screen.getByText('Peak pricing')).toBeTruthy()
  })

  it('renders a done dot and off-peak label outside the peak windows', () => {
    // Monday 12:00 UTC is off-peak.
    const { container } = mount(new Date(Date.UTC(2026, 0, 5, 12)))
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()
    expect(screen.getByText('Off-peak pricing')).toBeTruthy()
  })

  it('keeps the tier unchanged on a tick that stays inside the same window', () => {
    const { container } = mount(new Date(Date.UTC(2026, 0, 5, 2)))
    // 02:00 -> 02:01, still peak.
    act(() => { vi.advanceTimersByTime(PRICING_TICK_MS) })
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('flips to off-peak when a tick crosses a window boundary', () => {
    // 03:59 -> 04:00 crosses the 01:00–04:00 peak window end.
    const { container } = mount(new Date(Date.UTC(2026, 0, 5, 3, 59)))
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(PRICING_TICK_MS) })
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()
    expect(screen.getByText('Off-peak pricing')).toBeTruthy()
  })
})
