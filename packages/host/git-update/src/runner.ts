/** One resolved git executable driven through the subprocess capability. */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Milliseconds a git child gets to exit after termination starts; a fixed lifecycle constant. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024

/** Settled git command facts; a nonzero exit is a result, not an exception. */
export interface GitRunResult {
  /** Process exit code, or null when the child was signalled. */
  readonly exitCode: number | null
  /** Collected standard output, capped by the runner's limit. */
  readonly stdout: string
  /** Collected standard-error tail. */
  readonly stderr: string
  /** True when stdout exceeded its cap and lost its head. */
  readonly truncated: boolean
}

/** Per-command spawn facts. */
export interface GitRunOptions {
  /** Working directory the command runs in. */
  readonly cwd: string
  /** Extra environment merged after the credential scrub; a deliberate credential survives. */
  readonly env?: Readonly<Record<string, string>>
  /** Cancellation owned by the caller. */
  readonly signal: AbortSignal
  /** Permit git's own credential prompt; fetch and push need it for an authenticated remote. */
  readonly allowPrompt?: boolean
  /** Per-command override of the runner timeout; a push also runs the repository's pre-push hook. */
  readonly timeoutMs?: number
}

/** Bounds every git command runs under. */
export interface GitLimits {
  /** Milliseconds before a command is terminated. */
  readonly timeoutMs: number
  /** In-memory stdout cap in bytes. */
  readonly outputMaxBytes: number
}

/** Runs git with a scrubbed environment, a timeout, and bounded output. */
export class GitRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  /**
   * Run one git command to completion.
   * @param args - git arguments; never shell-interpreted.
   * @param options - working directory, extra environment, cancellation, and prompt permission.
   * @returns exit facts and the collected output.
   * @throws when the command times out, is aborted, or cannot spawn.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const limitMs = options.timeoutMs ?? this.limits.timeoutMs
    const timeout = AbortSignal.timeout(limitMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.allowPrompt === true ? {} : { GIT_TERMINAL_PROMPT: '0' },
        ...options.env,
      },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error('git ' + args.join(' ') + ' ' + (timeout.aborted ? 'timed out after ' + String(limitMs) + 'ms' : 'was aborted'))
    }
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/**
 * Reject a failed command with its diagnostic.
 * @param result - settled command facts.
 * @param what - command description used in the error message.
 * @returns the same result when it exited zero.
 */
export function ok(result: GitRunResult, what: string): GitRunResult {
  if (result.exitCode !== 0) {
    throw new Error(what + ' failed: ' + (result.stderr.trim() === '' ? 'exit ' + String(result.exitCode) : result.stderr.trim()))
  }
  return result
}
