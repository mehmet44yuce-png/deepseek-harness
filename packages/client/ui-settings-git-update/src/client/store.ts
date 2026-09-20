/**
 * Git update section store: one status read and one update attempt over the
 * gitUpdate Remote. The Host stays the single fact source; after an attempt
 * the section re-reads the status rather than deriving it from the result.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  GitUpdateOptions, GitUpdateResult, GitUpdateStatus,
} from '@deepseek-ai/dsh-host-git-update/types'

/** The two gitUpdate calls, bound in the apply closure where ctx is in scope. */
export interface GitUpdateRemoteFace {
  /** Read the checkout's relation to its upstream ref. */
  status: () => Promise<RemoteResult<GitUpdateStatus>>
  /** Run one update attempt with per-call overrides. */
  update: (options: GitUpdateOptions) => Promise<RemoteResult<GitUpdateResult>>
}

/** Section snapshot. */
export interface GitUpdateState {
  /** Status-read lifecycle; idle mounts the first read. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Latest observed status; retained while a later read or attempt runs. */
  current: GitUpdateStatus | null
  /** Status-read failure text, carrying the wire diagnostic verbatim. */
  error: string | null
  /** Whether an update attempt is in flight. */
  running: boolean
  /** Result of the latest finished attempt. */
  result: GitUpdateResult | null
  /** Update-attempt failure text, carrying the wire diagnostic verbatim. */
  updateError: string | null
}

/** Owns the status read and the single update attempt of the settings section. */
export class GitUpdateStore {
  /** The snapshot the section renders from. */
  readonly store: SnapshotStore<GitUpdateState> = createSnapshotStore<GitUpdateState>({
    status: 'idle', current: null, error: null, running: false, result: null, updateError: null,
  })

  /** Latest read wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param remote - the bound gitUpdate Remote calls.
   */
  constructor(private readonly remote: GitUpdateRemoteFace) {}

  /**
   * Read the current status; the section calls this on mount and on retry.
   * @returns after the snapshot carries the outcome.
   */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    const result = await this.remote.status()
    if (generation !== this.generation) return
    if (!result.ok) {
      const message = result.error.message
      this.store.update((state) => { state.status = 'error'; state.error = message })
      return
    }
    const current = result.value
    this.store.update((state) => { state.status = 'ready'; state.current = current })
  }

  /**
   * Run one update attempt and publish its outcome, keeping the result so the
   * section can render the steps and backup tags after the call settles. A
   * finished attempt moved the checkout, so the displayed status is re-read.
   * @returns after the snapshot carries the outcome and the refreshed status.
   */
  async runUpdate(): Promise<void> {
    this.store.update((state) => { state.running = true; state.updateError = null; state.result = null })
    const result = await this.remote.update({})
    if (!result.ok) {
      const message = result.error.message
      this.store.update((state) => { state.running = false; state.updateError = message })
      return
    }
    const value = result.value
    this.store.update((state) => { state.running = false; state.result = value })
    await this.refresh()
  }
}
