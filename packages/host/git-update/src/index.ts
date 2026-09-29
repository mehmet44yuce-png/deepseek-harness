/** Workspace git update over Typert Remote: status, a safe upstream rebase, and an optional fork push. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the ctx.subprocess and ctx.appExit Context merges.
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-cmdline'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { GitRunner } from './runner.ts'
import { defaultBranch, readRepositoryFacts, runUpdate } from './sync.ts'
import type { RepositoryFacts } from './sync.ts'
import type { GitUpdateOptions, GitUpdateResult, GitUpdateStatus } from './types.ts'

export type * from './types.ts'

/**
 * Exit code the supervising launcher (scripts/start-web.bat, which sets
 * DSH_SUPERVISED=1) reads as "reinstall, rebuild, and start again". The
 * reinstall runs there, after this process is gone, because a live Host keeps
 * native modules open and Windows refuses to replace them.
 */
const RESTART_EXIT_CODE = 75

/** Lets the update reply reach the Client before the process starts to exit. */
const RESTART_DELAY_MS = 1_500

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The configured directory is not inside a git repository. */
    'git-update/not-a-repository': { readonly cwd: string }
  }
}

/** Deployment-varying bounds and identities for every update this service runs. */
export interface Config {
  /** Directory the repository is discovered from; absent means the Host process working directory. */
  repository?: string
  /** Remote the update fetches and rebases onto. */
  remote?: string
  /** Upstream branch name; absent means the remote's reported default branch. */
  upstreamBranch?: string
  /** Remote the finished branch is pushed to; absent disables the push. */
  pushRemote?: string
  /** Whether the push bypasses the repository's pre-push hook. */
  skipPushHooks?: boolean
  /** Milliseconds before one git command is terminated. */
  timeoutMs?: number
  /** Milliseconds the push may take; it runs the repository's pre-push hook, which can build the workspace. */
  pushTimeoutMs?: number
  /** In-memory stdout cap for one git command. */
  outputMaxBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitUpdate: GitUpdateService
  }
}

/** Keeps the checkout current with its upstream without discarding local commits. */
export class GitUpdateService extends TypertRemoteService {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({
    repository: z.string().required(false),
    remote: z.string().default('origin'),
    upstreamBranch: z.string().required(false),
    pushRemote: z.string().required(false),
    skipPushHooks: z.boolean().default(false),
    timeoutMs: z.number().step(1).min(1_000).default(120_000),
    pushTimeoutMs: z.number().step(1).min(1_000).default(900_000),
    outputMaxBytes: z.number().step(1).min(1_024).default(16_384),
  })
  private readonly configuration: Config
  private readonly lifetime = new AbortController()
  private executable: Promise<string> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'gitUpdate')
    this.configuration = config
    ctx.effect(() => () => { this.lifetime.abort() }, 'git-update: lifetime cancellation')
  }

  /**
   * Read the checkout's current relation to its upstream ref without touching the network.
   * @param signal - carrier cancellation.
   * @returns the locally known status.
   * @throws a `git-update/not-a-repository` failure when the directory is not inside a git repository.
   */
  @Remote('status')
  async status(signal: AbortSignal): Promise<GitUpdateStatus> {
    const cwd = this.repository()
    const runner = await this.runner()
    const facts = await this.facts(runner, cwd, signal)
    const remote = this.configuration.remote ?? 'origin'
    const configured = this.options({}).upstreamBranch
    const upstream = remote + '/' + (configured ?? await defaultBranch(runner, cwd, remote, signal))
    const present = await runner.run(['rev-parse', '--verify', '--quiet', upstream], { cwd, signal })
    if (present.exitCode !== 0) {
      return {
        repository: facts.repository,
        branch: facts.branch,
        upstream,
        ahead: 0,
        behind: 0,
        dirty: facts.dirty,
        untracked: facts.untracked,
        head: facts.head,
        upstreamHead: '',
      }
    }
    const counts = await runner.run(['rev-list', '--left-right', '--count', upstream + '...HEAD'], { cwd, signal })
    const upstreamHead = await runner.run(['rev-parse', '--short', upstream], { cwd, signal })
    const parts = counts.stdout.trim().split(/\s+/)
    return {
      repository: facts.repository,
      branch: facts.branch,
      upstream,
      behind: Number(parts[0] ?? '0'),
      ahead: Number(parts[1] ?? '0'),
      dirty: facts.dirty,
      untracked: facts.untracked,
      head: facts.head,
      upstreamHead: upstreamHead.stdout.trim(),
    }
  }

  /**
   * Fetch upstream, rebase the branch onto it behind backup tags, and optionally push.
   * @param options - per-call overrides for the configured remote, upstream branch, and push remote.
   * @param signal - carrier cancellation.
   * @returns the outcome, the steps taken, and every backup tag created.
   * @throws a `git-update/not-a-repository` failure when the directory is not inside a git repository.
   */
  @Remote('update')
  async update(options: GitUpdateOptions, signal: AbortSignal): Promise<GitUpdateResult> {
    const cwd = this.repository()
    const runner = await this.runner()
    // Classify a non-repository directory before the engine reads anything.
    await this.facts(runner, cwd, signal)
    const resolved = this.options(options)
    const result = await runUpdate(runner, {
      cwd,
      options: resolved,
      remote: options.remote ?? this.configuration.remote ?? 'origin',
      skipPushHooks: this.configuration.skipPushHooks ?? false,
      pushTimeoutMs: this.configuration.pushTimeoutMs ?? 900_000,
      now: new Date(),
    }, signal)
    return result.outcome === 'updated' ? this.restartAfter(result) : result
  }

  /**
   * Hand a finished update to the launcher: the rebased sources only take
   * effect after dependencies are reinstalled, the workspace rebuilt, and the
   * Host restarted, which only a supervising launcher can do.
   */
  private restartAfter(result: GitUpdateResult): GitUpdateResult {
    const exit = this.ctx.get('appExit')
    if (process.env.DSH_SUPERVISED !== '1' || exit === undefined) {
      return {
        ...result,
        steps: [...result.steps, {
          name: 'restart',
          status: 'skipped',
          detail: 'no supervising launcher: run pnpm install && pnpm run clean && pnpm run build, then restart the harness',
        }],
      }
    }
    setTimeout(() => { if (!this.lifetime.signal.aborted) exit(RESTART_EXIT_CODE) }, RESTART_DELAY_MS)
    return {
      ...result,
      steps: [...result.steps, {
        name: 'restart',
        status: 'ok',
        detail: 'the harness restarts, reinstalls, rebuilds, and opens a new tab when ready',
      }],
      message: result.message + ' Restarting to reinstall and rebuild.',
    }
  }

  /** The directory the repository is discovered from. */
  private repository(): string {
    return this.configuration.repository ?? process.cwd()
  }

  /** Merge one call's overrides over the configured update choices. */
  private options(overrides: GitUpdateOptions): GitUpdateOptions {
    const upstreamBranch = overrides.upstreamBranch ?? this.configuration.upstreamBranch
    const pushRemote = overrides.pushRemote ?? this.configuration.pushRemote
    return {
      ...upstreamBranch === undefined ? {} : { upstreamBranch },
      ...pushRemote === undefined ? {} : { pushRemote },
    }
  }

  /** Resolve one git runner for this plugin's life. */
  private async runner(): Promise<GitRunner> {
    this.executable ??= this.ctx.subprocess.resolveExecutable('git', undefined, this.lifetime.signal)
    const configuration = this.configuration
    return new GitRunner(this.ctx.subprocess, await this.executable, {
      timeoutMs: configuration.timeoutMs ?? 120_000,
      outputMaxBytes: configuration.outputMaxBytes ?? 16_384,
    })
  }

  /** Read repository facts, classifying a non-repository directory as its wire failure. */
  private async facts(runner: GitRunner, cwd: string, signal: AbortSignal): Promise<RepositoryFacts> {
    try {
      return await readRepositoryFacts(runner, cwd, signal)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not a git repository/i.test(message)) throw error
      throw new RemoteError('git-update/not-a-repository', message, { cwd }, { cause: error })
    }
  }
}

export default GitUpdateService
