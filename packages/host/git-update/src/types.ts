/** Wire vocabulary for the workspace git update Remote. */

/** The observed relationship between the checked-out branch and one upstream ref. */
export interface GitUpdateStatus {
  /** Absolute repository top-level directory this status describes. */
  readonly repository: string
  /** Checked-out branch name. */
  readonly branch: string
  /** Upstream ref the comparison used, for example `origin/master`. */
  readonly upstream: string
  /** Commits on the branch that the upstream ref does not contain. */
  readonly ahead: number
  /** Commits on the upstream ref that the branch does not contain. */
  readonly behind: number
  /** Whether tracked files carry uncommitted modifications. */
  readonly dirty: boolean
  /** Untracked, non-ignored work-tree paths, bounded for display. */
  readonly untracked: readonly string[]
  /** Abbreviated commit id of the branch head. */
  readonly head: string
  /** Abbreviated commit id of the upstream ref. */
  readonly upstreamHead: string
}

/** Deployment choices one update attempt runs with; every field has a service default. */
export interface GitUpdateOptions {
  /** Remote the update fetches and rebases onto. */
  readonly remote?: string
  /** Upstream branch name; absent means the remote's own default branch. */
  readonly upstreamBranch?: string
  /** Remote the finished branch is pushed to; absent skips the push. */
  readonly pushRemote?: string
}

/** How one update attempt ended. */
export type GitUpdateOutcome = 'up-to-date' | 'updated' | 'conflict' | 'refused' | 'failed'

/** One reported step of an update attempt. */
export interface GitUpdateStep {
  /** Stable step name the Client renders copy for. */
  readonly name: 'working-tree-backup' | 'stash' | 'fetch' | 'head-backup' | 'rebase' | 'stash-restore' | 'push'
  /** Whether the step ran, was unnecessary, or failed. */
  readonly status: 'ok' | 'skipped' | 'failed'
  /** Observed detail, including raw git diagnostics for a failure. */
  readonly detail: string
}

/** The complete outcome of one update attempt. */
export interface GitUpdateResult {
  readonly outcome: GitUpdateOutcome
  /** Status observed before the attempt; absent when the attempt was refused before any fetch. */
  readonly before?: GitUpdateStatus
  /** Status observed after a successful attempt. */
  readonly after?: GitUpdateStatus
  readonly steps: readonly GitUpdateStep[]
  /** Tag holding the pre-update head; present once the branch had to move. */
  readonly headBackupTag?: string
  /** Tag holding the pre-update working tree; present when the tree was dirty. */
  readonly workTreeBackupTag?: string
  /** One-line summary of the outcome for display. */
  readonly message: string
}
