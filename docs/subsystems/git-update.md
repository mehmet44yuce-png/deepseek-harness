# Git Update

English | [中文](git-update.zh.md)

The `gitUpdate` Remote service from [`dsh-host-git-update`](../../packages/host/git-update/README.md) keeps a Host checkout current with its upstream. Web clients call `gitUpdate/status` to read the checkout's relation to its upstream ref and `gitUpdate/update` to fetch, rebase the branch behind backup tags, restore stashed work, and optionally push the configured remote. The service is Remote-only, creates no model-facing surface or Session event, and reads or changes the Host's checkout; the [package README](../../packages/host/git-update/README.md) owns configuration, the source map, and the known limitations.

## Ownership

| Owner | Responsibility |
|---|---|
| [git-update](../../packages/host/git-update/README.md) | `ctx.gitUpdate`: the `status` and `update` Remote methods, the service `Config`, and the backup-tag rebase engine |
| [Remote assembly](../../packages/api/remotes/README.md) | Mounts the service's generated Host and Client Remote artifacts |
| [Git update settings](../../packages/client/ui-settings-git-update/README.md) | Browser section that renders the status and runs the update |

## Status and update

`GitUpdateStatus` reports the repository's absolute top-level directory, the checked-out branch, the compared upstream ref (`<remote>/<branch>`, for example `origin/master`), the `ahead` and `behind` halves of `git rev-list --left-right --count`, whether tracked files are `dirty`, the `untracked` non-ignored paths, and the abbreviated `head` and `upstreamHead` commit ids. An upstream ref that does not resolve locally reports zero counts and an empty `upstreamHead`; `status` never fetches.

`GitUpdateOptions` carries the per-call `remote`, `upstreamBranch`, and `pushRemote` overrides; the service `Config` supplies the same defaults. `update` refuses a detached HEAD and a checkout with a rebase already in progress before it changes anything. Otherwise it backs up a dirty or untracked working tree, stashes it, fetches the remote with pruning, rebases the branch onto the upstream ref, restores the stash, and pushes when `pushRemote` is configured.

| Result field | Meaning |
|---|---|
| `outcome` | `GitUpdateOutcome`: `up-to-date`, `updated`, `conflict`, `refused`, or `failed` |
| `before` / `after` | `GitUpdateStatus` observed before the attempt and after a successful one; `before` is absent when the attempt was refused before any fetch |
| `steps` | `GitUpdateStep[]`, each with a stable `name`, an `ok`/`skipped`/`failed` `status`, and an observed `detail` |
| `headBackupTag` / `workTreeBackupTag` | Tags holding the pre-update head and working tree; `headBackupTag` appears once the branch had to move and `workTreeBackupTag` when the tree was dirty |
| `message` | One-line summary of the outcome for display |

Both methods are ordinary unary Remote calls that take the carrier cancellation signal and return the typed payload above. They do not activate an Agent, append Session events, or import the implementation into the browser.

## Configuration and failures

| Key | Default | Meaning |
|---|---|---|
| `repository` | the Host process working directory | Directory the repository is discovered from. |
| `remote` | `origin` | Remote the update fetches and rebases onto. |
| `upstreamBranch` | the remote's reported default branch | Upstream branch name; absent means the remote's own default. |
| `pushRemote` | unset | Remote the finished branch is pushed to; absent skips the push. |
| `skipPushHooks` | `false` | Whether the push bypasses the repository's pre-push hook. |
| `timeoutMs` | `120000` | Milliseconds before one git command is terminated. |
| `outputMaxBytes` | `16384` | In-memory stdout cap for one git command. |

A directory that is not inside a git repository throws `git-update/not-a-repository` with the probed `cwd` as its details. Every other failure mode is a settled result: a git command that exits nonzero becomes a failed step or a `failed` outcome carrying that command's diagnostic, and a rebase that meets a conflict becomes the `conflict` outcome rather than an exception. A conflict aborts the rebase, restores the stash, and lists the conflicting paths in `message`; the pre-update commit and working tree stay reachable through the backup tags.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgitupdate--gitupdateservice"></a>

### `ctx.gitUpdate` — `GitUpdateService`

Keeps the checkout current with its upstream without discarding local commits.

```ts cordis-catalog
/**
 * Read the checkout's current relation to its upstream ref without touching the network.
 * @param signal - carrier cancellation.
 * @returns the locally known status.
 * @throws a `git-update/not-a-repository` failure when the directory is not inside a git repository.
 */
@Remote('status') async status(signal: AbortSignal): Promise<GitUpdateStatus>

/**
 * Fetch upstream, rebase the branch onto it behind backup tags, and optionally push.
 * @param options - per-call overrides for the configured remote, upstream branch, and push remote.
 * @param signal - carrier cancellation.
 * @returns the outcome, the steps taken, and every backup tag created.
 * @throws a `git-update/not-a-repository` failure when the directory is not inside a git repository.
 */
@Remote('update') async update(options: GitUpdateOptions, signal: AbortSignal): Promise<GitUpdateResult>
```

Source: [`packages/host/git-update/src/index.ts`](../../packages/host/git-update/src/index.ts)
<!-- END GENERATED cordis-surface -->
