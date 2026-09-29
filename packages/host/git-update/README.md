---
description: "Workspace git update Remote for the dsh web client: read the checkout's upstream relation, rebase behind backup tags, and optionally push the configured fork."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-git-update

English | [中文](README.zh.md)

## Summary

Web clients call `gitUpdate/status` to read a checkout's branch, upstream ref, ahead and behind counts, and working-tree cleanliness, and `gitUpdate/update` to fetch upstream, rebase the branch behind backup tags, restore stashed work, and optionally push the branch to a configured remote. A failed or conflicting attempt aborts the rebase and leaves both the pre-update commit and the pre-update working tree reachable through tags, so no local work becomes unreachable. The service is Remote-only, owns no model-facing surface, and reads or changes the Host's checkout.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `gitUpdate/status` to display the current relation and `gitUpdate/update` to bring the checkout current. Both are ordinary unary Remote methods; `update` accepts the optional `remote`, `upstreamBranch`, and `pushRemote` overrides, and the plugin-level `Config` supplies the same defaults.

### What status reports

`repository` is the absolute top-level directory, `branch` the checked-out branch name, and `upstream` the compared ref (`<remote>/<branch>`, for example `origin/master`). `ahead` and `behind` are the two sides of `git rev-list --left-right --count`, `dirty` says whether tracked files carry uncommitted modifications, `untracked` lists non-ignored untracked paths, and `head` and `upstreamHead` are abbreviated commit ids. An upstream ref that does not resolve locally reports zero counts and an empty `upstreamHead`; `status` never fetches.

### What update does

`update` refuses a detached HEAD and a checkout with a rebase already in progress before it changes anything. Otherwise it fetches the remote with pruning and, only when the branch is behind its upstream ref, backs up a dirty or untracked working tree, drops local `pnpm-lock.yaml` edits (the reinstall regenerates the lockfile, and the backup keeps them), stashes the rest, rebases the branch onto the upstream ref, restores the stash, and pushes when `pushRemote` is configured. `outcome` is `up-to-date`, `updated`, `conflict`, `refused`, or `failed`; `steps` records each step's `ok`, `skipped`, or `failed` status with its detail; `before` and `after` carry the status around the attempt; and `headBackupTag` and `workTreeBackupTag` name the tags holding the pre-update state.

The rebase settles two kinds of conflict without stopping. A resolution git's rerere recorded during an earlier rebase of the same change is replayed, so a local change that conflicts with upstream is resolved once by hand and never again. A conflict confined to files a tool regenerates (`pnpm-lock.yaml`, translation-pairing `*.i18n.yaml` records, and test `__snapshots__`) takes the upstream side. The `rebase` step detail names the paths settled either way. Any other conflict aborts the rebase, restores the stash, and lists the conflicting paths in `message`.

An `updated` outcome ends with a `restart` step. A Host whose launcher set `DSH_SUPERVISED=1` (the repository's `scripts/start-web.bat` does) requests exit code `75` shortly after replying; the launcher then runs `pnpm install`, `pnpm run clean`, and `pnpm run build` while no Host holds the files open, and starts the Host again. Without a supervisor the step is skipped and names the commands to run by hand.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `repository` | the Host process working directory | Directory the repository is discovered from. |
| `remote` | `origin` | Remote the update fetches and rebases onto. |
| `upstreamBranch` | the remote's reported default branch | Upstream branch name; absent means the remote's own default. |
| `pushRemote` | unset | Remote the finished branch is pushed to; absent skips the push. |
| `skipPushHooks` | `false` | Whether the push bypasses the repository's pre-push hook. |
| `timeoutMs` | `120000` | Milliseconds before one git command is terminated. |
| `pushTimeoutMs` | `900000` | Milliseconds the push may take, including the repository's pre-push hook; a push that runs out becomes a failed `push` step, not a failed update. |
| `outputMaxBytes` | `16384` | In-memory stdout cap for one git command. |

### Failures

A directory that is not inside a git repository throws `git-update/not-a-repository` with the probed `cwd` as its details. Every other failure mode is a settled result: a git command that exits nonzero becomes a failed step or a `failed` outcome carrying that command's diagnostic, and a rebase that meets a conflict becomes the `conflict` outcome rather than an exception.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The engine keeps one rule: every destructive step is preceded by a backup that keeps the previous state reachable. The working-tree snapshot is written through a private index file, so the repository's real index and work tree are never touched, and the snapshot commit is built with `commit-tree` under a fixed identity, so the tag does not depend on repository configuration. A dirty tree is then stashed with `--include-untracked` and restored on every exit path, including a failed fetch, a missing upstream ref, and a conflicted rebase. Each attempt derives one timestamp suffix from its own clock, so the tags it creates share a name stem.

### Pushing safely

The push first reads the remote's branch head with `ls-remote` and then uses `--force-with-lease` pinned to that value, so a remote that moved since the read refuses the push instead of being overwritten. `skipPushHooks` adds `--no-verify`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `GitUpdateService`: the `gitUpdate` Remote service, its `Config`, and the `git-update/not-a-repository` failure |
| [`src/sync.ts`](src/sync.ts) | The update engine: repository facts, the work-tree and head backups, the rebase, the stash restore, and the push |
| [`src/runner.ts`](src/runner.ts) | `GitRunner`: one resolved git executable under a scrubbed environment, a timeout, and bounded output |
| [`src/types.ts`](src/types.ts) | Wire payload types: status, options, outcome, step, and result |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Remote assembly](../../api/remotes/README.md) — how clients consume `gitUpdate/status` and `gitUpdate/update` without importing this implementation.
- [Git update settings surface](../../client/ui-settings-git-update/README.md) — the browser section that renders the status and runs the update.
- [Subprocess capability](../../subprocess/subprocess/README.md) — the spawn contract the runner drives.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side git update service registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One checkout per service** — `repository` names a single directory; updating a second repository takes a second configured instance.
- **No per-step progress** — `update` is one unary call that settles with the complete step list, so a client shows a running state rather than live step transitions.
- **Backup tags accumulate** — every attempt that moves the branch or snapshots a dirty tree creates `backup/dsh-update-*` tags, and nothing prunes them.
- **The push covers one branch** — only the checked-out branch is pushed, under its own name; other local branches and tags stay local.
- **Only recorded or regenerated conflicts settle themselves** — a source conflict with no rerere resolution aborts the rebase and restores the pre-update state; resolving it once in a manual rebase with `rerere.enabled` lets the next update replay it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. `status` and `update` read and mutate the same repository through one runner, so a probe could only re-execute the implementation; the refusal paths and the command sequence are asserted directly by [`tests/sync.spec.ts`](tests/sync.spec.ts).
