// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const t: SidebarRootComponentProps['t'] = key =>
  (en as Record<string, string>)[key] ?? (commonEn as Record<string, string>)[key] ?? key

const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

const PRICING_TICK_MS = 60_000

function mount(now: Date) {
  vi.useFakeTimers({ now })
  // Upstream shells also read a keyboard-shortcut catalog. The fixture supplies
  // that hook outside the typed props so it stays valid on both sides of the
  // change, which keeps this local spec compiling across upstream updates.
  const props = {
    collapsed: false,
    width: 300,
    useSessions: neverHook,
    useSessionStatus,
    useSessionRetainInfo: neverHook,
    usePanelInfo,
    selectPanel: () => {},
    usePanels: (selector: (panels: readonly never[]) => unknown) => selector([]),
    useShortcuts: (selector: (rows: readonly never[]) => unknown) => selector([]),
    useResource,
    useWorkspaces: neverHook,
    startSession: vi.fn(),
    toggleSidebar: vi.fn(),
    t,
    renderSlot: ((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
      options?.fallback ?? null) as SidebarRootComponentProps['renderSlot'],
  } as unknown as SidebarRootComponentProps
  return render(<SidebarRoot {...props} />)
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
