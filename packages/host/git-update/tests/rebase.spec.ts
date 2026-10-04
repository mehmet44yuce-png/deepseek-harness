/** runUpdate against real repositories: automatic conflict settlement and the lockfile drop. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitRunOptions, GitRunResult, GitRunner } from '../src/runner.ts'
import { runUpdate } from '../src/sync.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch directory the test owns through afterEach. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-update-rebase-'))
  roots.push(root)
  return root
}

/** Environment that isolates every git call from the machine's hooks and identity. */
function isolated(root: string): Record<string, string> {
  const hooks = join(root, 'no-hooks')
  mkdirSync(hooks, { recursive: true })
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@localhost',
  }
}

/** Runs the real git executable, standing in for the subprocess-backed runner. */
class LocalRunner {
  constructor(private readonly env: Readonly<Record<string, string>>) {}

  /**
   * @param args - git arguments.
   * @param options - working directory and extra environment.
   * @returns the settled command facts.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const result = spawnSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...this.env, ...options.env },
    })
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false }
  }
}

/** Two repositories: `upstream` on `main`, and `local` cloned from it with its own commit. */
interface Fixture {
  readonly upstream: string
  readonly local: string
  readonly git: (cwd: string, ...args: string[]) => string
  readonly runner: LocalRunner
}

/**
 * Build the fixture, seeding both repositories with `files` at the shared root commit.
 * @param files - path to content of the common starting point.
 * @returns repositories and a throwing git helper.
 */
function fixture(files: Readonly<Record<string, string>>): Fixture {
  const root = scratch()
  const env = isolated(root)
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } })
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
    return result.stdout.trim()
  }
  const upstream = join(root, 'upstream')
  mkdirSync(upstream)
  git(upstream, 'init', '--quiet', '--initial-branch=main')
  for (const [path, content] of Object.entries(files)) writeFileSync(join(upstream, path), content)
  git(upstream, 'add', '-A')
  git(upstream, 'commit', '--quiet', '-m', 'root')
  const local = join(root, 'local')
  git(root, 'clone', '--quiet', upstream, local)
  return { upstream, local, git, runner: new LocalRunner(env) }
}

/** Commit `files` in `cwd` under `message`. */
function commit(f: Fixture, cwd: string, message: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd, path), content)
  f.git(cwd, 'add', '-A')
  f.git(cwd, 'commit', '--quiet', '-m', message)
}

const signal = new AbortController().signal

/** Run one update attempt in the fixture's local repository. */
function update(f: Fixture) {
  return runUpdate(f.runner as unknown as GitRunner, {
    cwd: f.local,
    options: {},
    remote: 'origin',
    skipPushHooks: false,
    now: new Date('2026-01-01T00:00:00.000Z'),
  }, signal)
}

// Each case drives dozens of real git processes, which a loaded Windows runner
// can stretch well past the default per-test budget.
describe('runUpdate conflict settlement', { timeout: 60_000 }, () => {
  it('takes upstream for a conflict confined to regenerated files and keeps the local commit', async () => {
    const f = fixture({ 'README.i18n.yaml': 'hash: root\n', 'feature.ts': 'export const a = 1\n' })
    commit(f, f.upstream, 'upstream records', { 'README.i18n.yaml': 'hash: upstream\n' })
    commit(f, f.local, 'local feature', { 'README.i18n.yaml': 'hash: local\n', 'feature.ts': 'export const a = 2\n' })

    const result = await update(f)

    expect(result.outcome).toBe('updated')
    expect(result.steps.find(step => step.name === 'rebase')?.detail).toContain('took upstream for regenerated files: README.i18n.yaml')
    expect(readFileSync(join(f.local, 'README.i18n.yaml'), 'utf8')).toBe('hash: upstream\n')
    expect(readFileSync(join(f.local, 'feature.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(f.git(f.local, 'log', '--format=%s', '-2')).toBe('local feature\nupstream records')
  })

  it('restores the branch when a source file conflicts', async () => {
    const f = fixture({ 'feature.ts': 'export const a = 1\n' })
    commit(f, f.upstream, 'upstream change', { 'feature.ts': 'export const a = 3\n' })
    commit(f, f.local, 'local change', { 'feature.ts': 'export const a = 2\n' })
    const head = f.git(f.local, 'rev-parse', 'HEAD')

    const result = await update(f)

    expect(result).toMatchObject({ outcome: 'conflict', headBackupTag: 'backup/dsh-update-2026-01-01T00-00-00-000Z' })
    expect(result.message).toContain('Conflicting paths: feature.ts')
    expect(f.git(f.local, 'rev-parse', 'HEAD')).toBe(head)
    expect(f.git(f.local, 'status', '--porcelain')).toBe('')
  })

  it('replays a resolution recorded by an earlier rebase', async () => {
    const f = fixture({ 'feature.ts': 'export const a = 1\n' })
    commit(f, f.upstream, 'upstream change', { 'feature.ts': 'export const a = 3\n' })
    commit(f, f.local, 'local change', { 'feature.ts': 'export const a = 2\n' })
    const head = f.git(f.local, 'rev-parse', 'HEAD')
    // Resolve the conflict once by hand with rerere recording, then put the branch back.
    f.git(f.local, 'fetch', '--quiet', 'origin')
    const stopped = spawnSync('git', ['-c', 'rerere.enabled=true', 'rebase', 'origin/main'], {
      cwd: f.local, windowsHide: true, env: { ...process.env, ...isolated(join(f.local, '..')) },
    })
    expect(stopped.status).not.toBe(0)
    writeFileSync(join(f.local, 'feature.ts'), 'export const a = 3 + 2\n')
    f.git(f.local, 'add', 'feature.ts')
    f.git(f.local, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'rebase', '--continue')
    f.git(f.local, 'reset', '--quiet', '--hard', head)

    const result = await update(f)

    expect(result.outcome).toBe('updated')
    expect(result.steps.find(step => step.name === 'rebase')?.detail).toContain('replayed recorded resolutions: feature.ts')
    expect(readFileSync(join(f.local, 'feature.ts'), 'utf8')).toBe('export const a = 3 + 2\n')
    expect(f.git(f.local, 'log', '--format=%s', '-1')).toBe('local change')
  })

  it('drops local lockfile edits before stashing so upstream lockfile changes cannot collide', async () => {
    const f = fixture({ 'pnpm-lock.yaml': 'lock: root\n', 'notes.md': 'root\n' })
    commit(f, f.upstream, 'upstream lock', { 'pnpm-lock.yaml': 'lock: upstream\n' })
    writeFileSync(join(f.local, 'pnpm-lock.yaml'), 'lock: reinstalled\n')
    writeFileSync(join(f.local, 'notes.md'), 'local edit\n')

    const result = await update(f)

    expect(result.outcome).toBe('updated')
    expect(result.steps.map(step => step.name + ':' + step.status)).toEqual([
      'fetch:ok', 'working-tree-backup:ok', 'lockfile:ok', 'stash:ok', 'head-backup:ok', 'rebase:ok', 'stash-restore:ok',
    ])
    expect(readFileSync(join(f.local, 'pnpm-lock.yaml'), 'utf8')).toBe('lock: upstream\n')
    expect(readFileSync(join(f.local, 'notes.md'), 'utf8')).toBe('local edit\n')
    // The dropped lockfile edit stays reachable through the working-tree backup.
    expect(result.workTreeBackupTag).toBeDefined()
    expect(f.git(f.local, 'show', `${result.workTreeBackupTag ?? ''}:pnpm-lock.yaml`)).toBe('lock: reinstalled')
  })

  it('leaves the work tree untouched when there is nothing to rebase onto', async () => {
    const f = fixture({ 'pnpm-lock.yaml': 'lock: root\n' })
    writeFileSync(join(f.local, 'pnpm-lock.yaml'), 'lock: reinstalled\n')

    const result = await update(f)

    expect(result.outcome).toBe('up-to-date')
    expect(result.steps.map(step => step.name)).toEqual(['fetch', 'rebase'])
    expect(readFileSync(join(f.local, 'pnpm-lock.yaml'), 'utf8')).toBe('lock: reinstalled\n')
  })
})
