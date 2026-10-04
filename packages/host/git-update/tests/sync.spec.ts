/** runUpdate refusal paths: a detached HEAD and an interrupted rebase. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitRunOptions, GitRunResult, GitRunnerLike } from '../src/runner.ts'
import { runUpdate, type UpdateRequest } from '../src/sync.ts'

/** Arguments and options the double recorded for one command. */
interface GitCall {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>> | undefined
}

/**
 * Hand-built runner answering the inspection commands a refusal path reads.
 * Every unscripted command fails, so a refusal that tried to mutate anything
 * would surface through its result instead of silently succeeding.
 */
class ScriptedRunner implements GitRunnerLike {
  readonly calls: GitCall[] = []

  /** @param answers - settled result per space-joined argument list. */
  constructor(private readonly answers: ReadonlyMap<string, GitRunResult>) {}

  /**
   * @param args - git arguments the engine passed.
   * @param options - working directory, extra environment, and cancellation.
   * @returns the scripted result, or a failure for an unscripted command.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    this.calls.push({ args, cwd: options.cwd, env: options.env })
    return this.answers.get(args.join(' '))
      ?? { exitCode: 1, stdout: '', stderr: 'unscripted command: ' + args.join(' '), truncated: false }
  }
}

/** A settled successful git result carrying one line of output. */
function reply(stdout: string): GitRunResult {
  return { exitCode: 0, stdout, stderr: '', truncated: false }
}

/** The five inspection commands readRepositoryFacts runs, in order. */
function facts(cwd: string, branch: string, gitDir: string): Map<string, GitRunResult> {
  return new Map([
    ['rev-parse --show-toplevel', reply(cwd)],
    ['rev-parse --abbrev-ref HEAD', reply(branch)],
    ['rev-parse --absolute-git-dir', reply(gitDir)],
    ['rev-parse --short HEAD', reply('abc1234')],
    ['status --porcelain=v1 --untracked-files=normal', reply('')],
  ])
}

/** One attempt request with every deployment choice pinned for the assertion. */
function request(cwd: string): UpdateRequest {
  return {
    cwd,
    options: {},
    remote: 'origin',
    skipPushHooks: false,
    pushTimeoutMs: 60_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch directory the test owns through afterEach. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-update-'))
  roots.push(root)
  return root
}

const signal = new AbortController().signal

describe('runUpdate refusals', () => {
  it('refuses a detached HEAD before it reads or changes anything else', async () => {
    const runner = new ScriptedRunner(facts('repo', 'HEAD', 'repo/.git'))
    const result = await runUpdate(runner, request('repo'), signal)

    expect(result).toMatchObject({
      outcome: 'refused',
      steps: [],
      message: 'Detached HEAD: check out a branch before updating.',
    })
    expect(runner.calls.map(call => call.args.join(' '))).toEqual([
      'rev-parse --show-toplevel',
      'rev-parse --abbrev-ref HEAD',
      'rev-parse --absolute-git-dir',
      'rev-parse --short HEAD',
      'status --porcelain=v1 --untracked-files=normal',
    ])
  })

  it('refuses while an interrupted rebase holds repository state', async () => {
    const root = scratch()
    const gitDir = join(root, '.git')
    mkdirSync(join(gitDir, 'rebase-merge'), { recursive: true })
    const runner = new ScriptedRunner(facts(root, 'main', gitDir))
    const result = await runUpdate(runner, request(root), signal)

    expect(result).toMatchObject({
      outcome: 'refused',
      steps: [],
      message: 'A rebase is already in progress; finish or abort it first.',
    })
    const heads = runner.calls.map(call => call.args[0])
    expect(heads).not.toContain('fetch')
    expect(heads).not.toContain('rebase')
    expect(heads).not.toContain('tag')
  })

  it('retries a hook-spawn crash once with --no-verify when pushing a remote', async () => {
    const root = scratch()
    const answers = new Map<string, GitRunResult>([
      ...facts(root, 'main', join(root, '.git')),
      ['fetch origin --prune', reply('')],
      ['rev-parse --verify --quiet origin/main', reply('')],
      ['rev-list --left-right --count origin/main...HEAD', reply('0\t0')],
      ['rev-parse --short origin/main', reply('abc1234')],
      ['ls-remote --heads fork refs/heads/main', reply('remotesha123\trefs/heads/main')],
      [
        'push --force-with-lease=refs/heads/main:remotesha123 fork main:main',
        {
          exitCode: 1,
          stdout: '',
          stderr: '0 [main] bash (29380) *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0): 0xC0000022',
          truncated: false,
        },
      ],
      ['push --no-verify --force-with-lease=refs/heads/main:remotesha123 fork main:main', reply('')],
    ])
    const runner = new ScriptedRunner(answers)
    const req: UpdateRequest = {
      ...request(root),
      options: { pushRemote: 'fork', upstreamBranch: 'main' },
    }
    const result = await runUpdate(runner, req, signal)

    expect(result.outcome).toBe('up-to-date')
    expect(result.steps.find(step => step.name === 'push')).toEqual({
      name: 'push',
      status: 'ok',
      detail: 'fork/main',
    })
    const pushCalls = runner.calls.filter(call => call.args[0] === 'push')
    expect(pushCalls).toHaveLength(2)
    expect(pushCalls[0]?.args).toEqual(['push', '--force-with-lease=refs/heads/main:remotesha123', 'fork', 'main:main'])
    expect(pushCalls[1]?.args).toEqual(['push', '--no-verify', '--force-with-lease=refs/heads/main:remotesha123', 'fork', 'main:main'])
  })

  it('does not retry when the initial push already skipped hooks', async () => {
    const root = scratch()
    const answers = new Map<string, GitRunResult>([
      ...facts(root, 'main', join(root, '.git')),
      ['fetch origin --prune', reply('')],
      ['rev-parse --verify --quiet origin/main', reply('')],
      ['rev-list --left-right --count origin/main...HEAD', reply('0\t0')],
      ['rev-parse --short origin/main', reply('abc1234')],
      ['ls-remote --heads fork refs/heads/main', reply('remotesha123\trefs/heads/main')],
      [
        'push --no-verify --force-with-lease=refs/heads/main:remotesha123 fork main:main',
        {
          exitCode: 1,
          stdout: '',
          stderr: '0 [main] bash (29380) *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0): 0xC0000022',
          truncated: false,
        },
      ],
    ])
    const runner = new ScriptedRunner(answers)
    const req: UpdateRequest = {
      ...request(root),
      options: { pushRemote: 'fork', upstreamBranch: 'main' },
      skipPushHooks: true,
    }
    const result = await runUpdate(runner, req, signal)

    expect(result.outcome).toBe('up-to-date')
    expect(result.steps.find(step => step.name === 'push')).toEqual({
      name: 'push',
      status: 'failed',
      detail: '0 [main] bash (29380) *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0): 0xC0000022',
    })
    const pushCalls = runner.calls.filter(call => call.args[0] === 'push')
    expect(pushCalls).toHaveLength(1)
  })
})
