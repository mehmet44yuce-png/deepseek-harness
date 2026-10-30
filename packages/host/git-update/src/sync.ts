/** The git update engine: observation, backup, upstream rebase, and an optional fork push. */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok } from './runner.ts'
import type { GitRunnerLike } from './runner.ts'
import type { GitUpdateOptions, GitUpdateResult, GitUpdateStatus, GitUpdateStep } from './types.ts'

/** Newline-separated git output as non-empty lines. */
function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

/** A backup-tag suffix unique to one attempt and stable across the tags it creates. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/** One-line git diagnostic for a settled command. */
function diagnostic(result: { exitCode: number | null; stderr: string }): string {
  return result.stderr.trim() === '' ? 'exit ' + String(result.exitCode) : result.stderr.trim()
}

/** The lockfile `pnpm install` rewrites after every update. */
const LOCKFILE = 'pnpm-lock.yaml'

/**
 * Paths a tool regenerates (`pnpm install`, `scripts/gen-module-graph.ts`, the
 * translation-pairing recorder, `vitest -u`), so a rebase conflict in one
 * resolves to the upstream side instead of stopping the update.
 */
const REGENERATED_PATHS: readonly RegExp[] = [
  /(^|\/)pnpm-lock\.yaml$/,
  /\.i18n\.yaml$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
  /(^|\/)docs\/module-graph\.md$/,
  /(^|\/)docs\/module-graph\.zh\.md$/,
  /(^|\/)docs\/tool-catalog\.md$/,
]

/**
 * Rebase prefix: rerere replays any conflict resolution recorded by an earlier
 * rebase and stages it, and the editor is a no-op so `--continue` never waits.
 */
const REBASE = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true', '-c', 'core.editor=true', 'rebase']

/** Environment that keeps every rebase step non-interactive. */
const REBASE_ENV = { GIT_EDITOR: 'true' }

/**
 * Why a git command could not run its shell at all: a spawn crash, not a
 * verdict from the hook. The msys shim that executes hooks occasionally dies
 * (`*** fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…)`,
 * `0xC0000022`) before any hook code runs, so the push retries once without
 * hooks and nothing a hook would have judged is lost.
 */
const SHELL_UNAVAILABLE = /\*\*\* fatal error|NtCreate|msys-2\.0/i

/** Whether an interrupted rebase left state in this git directory. */
function rebasing(gitDir: string): boolean {
  return existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))
}

/** How one rebase with automatic resolution ended. */
type RebaseOutcome =
  | { readonly ok: true; readonly replayed: readonly string[]; readonly regenerated: readonly string[] }
  | { readonly ok: false; readonly conflicts: readonly string[]; readonly detail: string }

/**
 * Rebase onto upstream, settling each stop the rebase can settle on its own:
 * rerere-replayed resolutions are already staged, and a conflict confined to
 * regenerated paths takes the upstream side. A stop with any other conflicted
 * path is left in place for the caller to abort.
 * @param git - command runner.
 * @param repository - absolute repository root.
 * @param gitDir - git directory holding the rebase state.
 * @param upstream - ref to rebase onto.
 * @param maxStops - stops tolerated before the rebase counts as stuck.
 * @param signal - caller cancellation.
 * @returns the resolved paths on success, or the blocking paths on failure.
 */
async function rebaseResolving(
  git: GitRunnerLike, repository: string, gitDir: string, upstream: string, maxStops: number, signal: AbortSignal,
): Promise<RebaseOutcome> {
  const replayed = new Set<string>()
  const regenerated = new Set<string>()
  const run = (args: readonly string[]) => git.run(args, { cwd: repository, env: REBASE_ENV, signal })
  const unmerged = async (): Promise<string[]> => lines((await run(['diff', '--name-only', '--diff-filter=U'])).stdout)
  let result = await run([...REBASE, upstream])
  for (let stops = 0; result.exitCode !== 0; stops += 1) {
    for (const [, path] of (result.stdout + result.stderr).matchAll(/(?:Resolved|Staged) '(.+?)' using previous resolution/g)) {
      if (path !== undefined) replayed.add(path)
    }
    const paths = await unmerged()
    if (stops >= maxStops || !rebasing(gitDir)) return { ok: false, conflicts: paths, detail: diagnostic(result) }
    const blocking = paths.filter(path => !REGENERATED_PATHS.some(pattern => pattern.test(path)))
    if (blocking.length > 0) return { ok: false, conflicts: blocking, detail: diagnostic(result) }
    for (const path of paths) {
      // During a rebase "ours" is the upstream being rebased onto; a path it
      // deleted has no side to check out, so the deletion is taken instead.
      const taken = await run(['checkout', '--ours', '--', path])
      ok(taken.exitCode === 0 ? await run(['add', '--', path]) : await run(['rm', '--quiet', '--', path]), 'git add ' + path)
      regenerated.add(path)
    }
    result = await run([...REBASE, '--continue'])
    // A commit the resolution emptied cannot be continued, only skipped.
    if (result.exitCode !== 0 && /nothing to commit|No changes/i.test(result.stdout + result.stderr) && (await unmerged()).length === 0) {
      result = await run([...REBASE, '--skip'])
    }
  }
  return { ok: true, replayed: [...replayed], regenerated: [...regenerated] }
}

/** Repository facts an attempt reads before it changes anything. */
export interface RepositoryFacts {
  /** Absolute repository top-level directory. */
  readonly repository: string
  /** Checked-out branch name; `HEAD` when the checkout is detached. */
  readonly branch: string
  /** Absolute git directory owning the repository's state. */
  readonly gitDir: string
  /** Abbreviated head commit id. */
  readonly head: string
  /** Whether tracked files carry uncommitted modifications. */
  readonly dirty: boolean
  /** Untracked, non-ignored work-tree paths. */
  readonly untracked: readonly string[]
  /** Whether an interrupted rebase left state behind. */
  readonly rebaseInProgress: boolean
}

/** The upstream relation one comparison observed. */
interface UpstreamCounts {
  readonly ahead: number
  readonly behind: number
  readonly upstreamHead: string
}

/**
 * Read the repository's identity, cleanliness, and interrupted-operation state.
 * @param git - command runner.
 * @param cwd - directory inside the repository.
 * @param signal - caller cancellation.
 * @returns the observed facts.
 * @throws when the directory is not inside a git repository.
 */
export async function readRepositoryFacts(git: GitRunnerLike, cwd: string, signal: AbortSignal): Promise<RepositoryFacts> {
  const repository = ok(await git.run(['rev-parse', '--show-toplevel'], { cwd, signal }), 'git rev-parse --show-toplevel').stdout.trim()
  const branch = ok(await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, signal }), 'git rev-parse --abbrev-ref HEAD').stdout.trim()
  const gitDir = ok(await git.run(['rev-parse', '--absolute-git-dir'], { cwd, signal }), 'git rev-parse --absolute-git-dir').stdout.trim()
  const head = ok(await git.run(['rev-parse', '--short', 'HEAD'], { cwd, signal }), 'git rev-parse HEAD').stdout.trim()
  const porcelain = ok(await git.run(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd, signal }), 'git status').stdout
  const rows = lines(porcelain)
  return {
    repository,
    branch,
    gitDir,
    head,
    dirty: rows.some(row => !row.startsWith('??')),
    untracked: rows.filter(row => row.startsWith('??')).map(row => row.slice(3)),
    rebaseInProgress: rebasing(gitDir),
  }
}

/**
 * Resolve the branch a remote reports as its default.
 * @param git - command runner.
 * @param cwd - directory inside the repository.
 * @param remote - remote name to inspect.
 * @param signal - caller cancellation.
 * @returns the remote's default branch, or `master` when the remote reports none.
 */
export async function defaultBranch(git: GitRunnerLike, cwd: string, remote: string, signal: AbortSignal): Promise<string> {
  const symbolic = await git.run(['symbolic-ref', '--short', 'refs/remotes/' + remote + '/HEAD'], { cwd, signal })
  const name = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ''
  if (name === '') return 'master'
  return name.startsWith(remote + '/') ? name.slice(remote.length + 1) : name
}

/**
 * Compare the branch against one upstream ref.
 * @param git - command runner.
 * @param cwd - directory inside the repository.
 * @param upstream - resolved upstream ref, for example `origin/master`.
 * @param signal - caller cancellation.
 * @returns ahead, behind, and the upstream's abbreviated commit id.
 */
async function readCounts(git: GitRunnerLike, cwd: string, upstream: string, signal: AbortSignal): Promise<UpstreamCounts> {
  const counts = ok(await git.run(['rev-list', '--left-right', '--count', upstream + '...HEAD'], { cwd, signal }), 'git rev-list').stdout.trim().split(/\s+/)
  const upstreamHead = ok(await git.run(['rev-parse', '--short', upstream], { cwd, signal }), 'git rev-parse upstream').stdout.trim()
  return { behind: Number(counts[0] ?? '0'), ahead: Number(counts[1] ?? '0'), upstreamHead }
}

/**
 * Preserve the complete work tree, including untracked files, as a tagged commit
 * built through a private index so the real index and work tree stay untouched.
 * @param git - command runner.
 * @param repository - absolute repository root.
 * @param head - head commit the snapshot parents on.
 * @param tag - tag that keeps the snapshot reachable.
 * @param signal - caller cancellation.
 */
async function backupWorkTree(git: GitRunnerLike, repository: string, head: string, tag: string, signal: AbortSignal): Promise<void> {
  const index = join(tmpdir(), 'dsh-git-update-' + randomUUID())
  const env = { GIT_INDEX_FILE: index }
  try {
    ok(await git.run(['add', '-A'], { cwd: repository, env, signal }), 'git add -A')
    const tree = ok(await git.run(['write-tree'], { cwd: repository, env, signal }), 'git write-tree').stdout.trim()
    // commit-tree needs an identity but takes no index, so the tag never depends on repository config.
    const identity = ['-c', 'user.name=dsh-git-update', '-c', 'user.email=dsh-git-update@localhost']
    const commit = ok(await git.run([...identity, 'commit-tree', tree, '-p', head, '-m', 'snapshot: ' + tag], { cwd: repository, env, signal }), 'git commit-tree').stdout.trim()
    ok(await git.run(['tag', '-f', tag, commit], { cwd: repository, signal }), 'git tag')
  } finally {
    await rm(index, { force: true })
  }
}

/**
 * Push the branch to a remote, refusing when that remote moved since it was read.
 * @param git - command runner.
 * @param cwd - directory inside the repository.
 * @param remote - remote to push to.
 * @param branch - branch name pushed to the same name on the remote.
 * @param skipHooks - whether the push bypasses the repository's pre-push hook.
 * @param signal - caller cancellation.
 * @returns the reported push step.
 */
async function pushBranch(
  git: GitRunnerLike, cwd: string, remote: string, branch: string, skipHooks: boolean, timeoutMs: number, signal: AbortSignal,
): Promise<GitUpdateStep> {
  try {
    return await pushLeased(git, cwd, remote, branch, skipHooks, timeoutMs, signal)
  } catch (error: unknown) {
    // The branch is already rebased when the push runs, so a push that times out
    // or cannot spawn is a failed step, not a failed update: the Host still restarts.
    if (signal.aborted) throw error
    return { name: 'push', status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** The leased push itself; runner failures propagate to {@link pushBranch}. */
async function pushLeased(
  git: GitRunnerLike, cwd: string, remote: string, branch: string, skipHooks: boolean, timeoutMs: number, signal: AbortSignal,
): Promise<GitUpdateStep> {
  const listed = await git.run(['ls-remote', '--heads', remote, 'refs/heads/' + branch], { cwd, signal, allowPrompt: true })
  const remoteSha = listed.exitCode === 0 ? (lines(listed.stdout)[0] ?? '').split('\t')[0] ?? '' : ''
  const lease = remoteSha === ''
    ? '--force-with-lease'
    : '--force-with-lease=refs/heads/' + branch + ':' + remoteSha
  const args = ['push', ...skipHooks ? ['--no-verify'] : [], lease, remote, branch + ':' + branch]
  const result = await git.run(args, { cwd, signal, allowPrompt: true, timeoutMs })
  if (result.exitCode !== 0 && !skipHooks && SHELL_UNAVAILABLE.test(diagnostic(result))) {
    // The hook's shell died while spawning; the same push retried once with
    // --no-verify skips only a hook that never ran.
    const retry = await git.run(['push', '--no-verify', lease, remote, branch + ':' + branch], { cwd, signal, allowPrompt: true, timeoutMs })
    return retry.exitCode === 0
      ? { name: 'push', status: 'ok', detail: remote + '/' + branch }
      : { name: 'push', status: 'failed', detail: diagnostic(retry) }
  }
  return result.exitCode === 0
    ? { name: 'push', status: 'ok', detail: remote + '/' + branch }
    : { name: 'push', status: 'failed', detail: diagnostic(result) }
}

/** Everything one update attempt needs beyond the runner. */
export interface UpdateRequest {
  /** Directory inside the repository to update. */
  readonly cwd: string
  /** Deployment choices for this attempt. */
  readonly options: GitUpdateOptions
  /** Remote the update fetches and rebases onto. */
  readonly remote: string
  /** Whether the push bypasses the repository's pre-push hook. */
  readonly skipPushHooks: boolean
  /** Milliseconds the push may take, pre-push hook included. */
  readonly pushTimeoutMs: number
  /** Attempt timestamp; injected so a test can assert tag names. */
  readonly now: Date
}

/** Status with the fields the engine reads back after an attempt. */
function statusOf(
  facts: RepositoryFacts, upstream: string, counts: UpstreamCounts, dirty: boolean, untracked: readonly string[],
): GitUpdateStatus {
  return {
    repository: facts.repository,
    branch: facts.branch,
    upstream,
    ahead: counts.ahead,
    behind: counts.behind,
    dirty,
    untracked,
    head: facts.head,
    upstreamHead: counts.upstreamHead,
  }
}

/**
 * Observe, back up, rebase onto upstream, restore the work tree, and optionally push.
 * Every destructive step is preceded by a backup tag, so a failure leaves the
 * previous state reachable.
 * @param git - command runner.
 * @param request - repository directory, deployment choices, and attempt timestamp.
 * @param signal - caller cancellation.
 * @returns the outcome, the steps taken, and the backup tags created.
 */
export async function runUpdate(git: GitRunnerLike, request: UpdateRequest, signal: AbortSignal): Promise<GitUpdateResult> {
  const steps: GitUpdateStep[] = []
  const tagSuffix = stamp(request.now)
  const facts = await readRepositoryFacts(git, request.cwd, signal)
  if (facts.branch === 'HEAD') {
    return { outcome: 'refused', steps, message: 'Detached HEAD: check out a branch before updating.' }
  }
  if (facts.rebaseInProgress) {
    return { outcome: 'refused', steps, message: 'A rebase is already in progress; finish or abort it first.' }
  }

  const fetched = await git.run(['fetch', request.remote, '--prune'], { cwd: facts.repository, signal, allowPrompt: true })
  if (fetched.exitCode !== 0) {
    steps.push({ name: 'fetch', status: 'failed', detail: diagnostic(fetched) })
    return { outcome: 'failed', steps, message: 'Fetch failed: ' + diagnostic(fetched) }
  }
  steps.push({ name: 'fetch', status: 'ok', detail: request.remote })

  const upstreamBranch = request.options.upstreamBranch ?? await defaultBranch(git, facts.repository, request.remote, signal)
  const upstream = request.remote + '/' + upstreamBranch
  const verified = await git.run(['rev-parse', '--verify', '--quiet', upstream], { cwd: facts.repository, signal })
  if (verified.exitCode !== 0) {
    steps.push({ name: 'fetch', status: 'failed', detail: 'upstream ref ' + upstream + ' does not exist' })
    return { outcome: 'failed', steps, message: 'Upstream ref ' + upstream + ' does not exist.' }
  }
  const counts = await readCounts(git, facts.repository, upstream, signal)
  const before = statusOf(facts, upstream, counts, facts.dirty, facts.untracked)

  let workTreeBackupTag: string | undefined
  let headBackupTag: string | undefined
  let stashed = false
  const restore = async (): Promise<void> => {
    if (!stashed) return
    const pop = await git.run(['stash', 'pop'], { cwd: facts.repository, signal })
    steps.push(pop.exitCode === 0
      ? { name: 'stash-restore', status: 'ok', detail: 'uncommitted work restored' }
      : { name: 'stash-restore', status: 'failed', detail: 'stash kept: ' + diagnostic(pop) })
  }

  // The work tree is only touched once there is something to rebase onto.
  if (counts.behind === 0) {
    steps.push({ name: 'rebase', status: 'skipped', detail: 'already up to date with ' + upstream })
  } else {
    let pending = facts.dirty || facts.untracked.length > 0
    if (pending) {
      workTreeBackupTag = 'backup/dsh-update-wip-' + tagSuffix
      await backupWorkTree(git, facts.repository, facts.head, workTreeBackupTag, signal)
      steps.push({ name: 'working-tree-backup', status: 'ok', detail: workTreeBackupTag })
    } else {
      steps.push({ name: 'working-tree-backup', status: 'skipped', detail: 'working tree clean' })
    }

    // The previous update's `pnpm install` leaves the lockfile edited. Stashing
    // it would collide with upstream's lockfile on restore, and the next install
    // rewrites it anyway, so it is dropped here (the backup tag above keeps it).
    if (facts.dirty && (await git.run(['diff', '--quiet', 'HEAD', '--', LOCKFILE], { cwd: facts.repository, signal })).exitCode === 1) {
      ok(await git.run(['checkout', 'HEAD', '--', LOCKFILE], { cwd: facts.repository, signal }), 'git checkout ' + LOCKFILE)
      steps.push({ name: 'lockfile', status: 'ok', detail: LOCKFILE + ' edits dropped; the reinstall regenerates it' })
      pending = lines(ok(await git.run(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: facts.repository, signal }), 'git status').stdout).length > 0
    }

    if (pending) {
      const stash = await git.run(['stash', 'push', '--include-untracked', '--message', 'dsh-git-update ' + tagSuffix], { cwd: facts.repository, signal })
      if (stash.exitCode !== 0) {
        steps.push({ name: 'stash', status: 'failed', detail: diagnostic(stash) })
        return {
          outcome: 'failed',
          before,
          steps,
          ...workTreeBackupTag === undefined ? {} : { workTreeBackupTag },
          message: 'Could not stash uncommitted work; the branch was not rebased.',
        }
      }
      stashed = true
      steps.push({ name: 'stash', status: 'ok', detail: 'uncommitted work stashed' })
    }

    headBackupTag = 'backup/dsh-update-' + tagSuffix
    ok(await git.run(['tag', '-f', headBackupTag, 'HEAD'], { cwd: facts.repository, signal }), 'git tag')
    steps.push({ name: 'head-backup', status: 'ok', detail: headBackupTag })
    const rebase = await rebaseResolving(git, facts.repository, facts.gitDir, upstream, counts.ahead + 1, signal)
    if (!rebase.ok) {
      await git.run(['rebase', '--abort'], { cwd: facts.repository, signal })
      await restore()
      steps.push({ name: 'rebase', status: 'failed', detail: rebase.detail })
      return {
        outcome: 'conflict',
        before,
        steps,
        headBackupTag,
        ...workTreeBackupTag === undefined ? {} : { workTreeBackupTag },
        message: 'Rebase onto ' + upstream + ' conflicted; the branch was restored. Conflicting paths: '
          + (rebase.conflicts.join(', ') || 'none reported'),
      }
    }
    const settled = [
      ...rebase.replayed.length === 0 ? [] : ['replayed recorded resolutions: ' + rebase.replayed.join(', ')],
      ...rebase.regenerated.length === 0 ? [] : ['took upstream for regenerated files: ' + rebase.regenerated.join(', ')],
    ]
    steps.push({
      name: 'rebase',
      status: 'ok',
      detail: ['rebased ' + String(counts.ahead) + ' commits onto ' + upstream, ...settled].join('; '),
    })
  }

  await restore()

  if (request.options.pushRemote !== undefined) {
    steps.push(await pushBranch(
      git, facts.repository, request.options.pushRemote, facts.branch, request.skipPushHooks, request.pushTimeoutMs, signal,
    ))
  }

  const finalFacts = await readRepositoryFacts(git, facts.repository, signal)
  const finalCounts = await readCounts(git, facts.repository, upstream, signal)
  const updated = counts.behind > 0
  return {
    outcome: updated ? 'updated' : 'up-to-date',
    before,
    after: statusOf(finalFacts, upstream, finalCounts, finalFacts.dirty, finalFacts.untracked),
    steps,
    ...headBackupTag === undefined ? {} : { headBackupTag },
    ...workTreeBackupTag === undefined ? {} : { workTreeBackupTag },
    message: updated
      ? 'Updated from ' + upstream + '; ' + String(finalCounts.ahead) + ' local commits preserved.'
      : 'Already up to date with ' + upstream + '.',
  }
}
