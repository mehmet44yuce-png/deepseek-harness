# Git 更新

[English](git-update.md) | 中文

来自 [`dsh-host-git-update`](../../packages/host/git-update/README.zh.md) 的 `gitUpdate` Remote 服务让宿主检出与其上游保持同步。Web 客户端调用 `gitUpdate/status` 读取检出与其上游引用的关系，调用 `gitUpdate/update` 获取上游、在备份标签之后把分支变基、恢复暂存的改动，并可选推送到配置的远程。该服务仅通过 Remote 暴露，不创建任何面向模型的表面或 Session 事件，并读写宿主的检出；[包 README](../../packages/host/git-update/README.zh.md) 负责配置、源码映射与已知限制。

## 所有权

| 所有者 | 职责 |
|---|---|
| [git-update](../../packages/host/git-update/README.zh.md) | `ctx.gitUpdate`：`status` 与 `update` Remote 方法、服务 `Config` 以及备份标签变基引擎 |
| [Remote 组装](../../packages/api/remotes/README.zh.md) | 挂载服务生成的宿主与客户端 Remote 产物 |
| [git 更新设置界面](../../packages/client/ui-settings-git-update/README.zh.md) | 渲染状态并运行更新的浏览器分区 |

## 状态与更新

`GitUpdateStatus` 报告仓库顶层绝对目录、检出分支、比较用的上游引用（`<remote>/<branch>`，例如 `origin/master`）、`git rev-list --left-right --count` 两侧的 `ahead` 与 `behind`、已跟踪文件是否 `dirty`、未被忽略的 `untracked` 路径，以及缩写的 `head` 与 `upstreamHead` 提交 id。本地无法解析的上游引用报告零计数与空的 `upstreamHead`；`status` 从不获取。

`GitUpdateOptions` 携带每次调用的 `remote`、`upstreamBranch` 与 `pushRemote` 覆盖值；服务 `Config` 提供相同默认值。`update` 在改动任何东西之前拒绝分离 HEAD 与已在进行变基的检出。否则它会备份脏的或有未跟踪文件的工作区、暂存它们、带修剪地获取远程、把分支变基到上游引用、恢复暂存，并在配置了 `pushRemote` 时推送。

| 结果字段 | 含义 |
|---|---|
| `outcome` | `GitUpdateOutcome`：`up-to-date`、`updated`、`conflict`、`refused` 或 `failed` |
| `before` / `after` | 尝试之前与成功之后观察到的 `GitUpdateStatus`；在未获取即被拒绝时 `before` 缺省 |
| `steps` | `GitUpdateStep[]`，每项包含稳定的 `name`、`ok`/`skipped`/`failed` 的 `status` 与观察到的 `detail` |
| `headBackupTag` / `workTreeBackupTag` | 保存更新前头部与工作区的标签；分支必须移动后出现 `headBackupTag`，工作区脏时出现 `workTreeBackupTag` |
| `message` | 用于展示的结果单行摘要 |

两个方法都是普通的 unary Remote 调用，接收载体取消信号并返回上面的类型化载荷。它们不激活 Agent、不追加 Session 事件，也不把实现导入浏览器。

## 配置与失败

| 键 | 默认值 | 含义 |
|---|---|---|
| `repository` | 宿主进程工作目录 | 用于发现仓库的目录。 |
| `remote` | `origin` | 更新获取并变基到的远程。 |
| `upstreamBranch` | 远程报告的分支 | 上游分支名；缺省表示远程自己的分支。 |
| `pushRemote` | 未设置 | 完成后推送到的远程；缺省表示跳过推送。 |
| `skipPushHooks` | `false` | 推送是否绕过仓库的 pre-push 钩子。 |
| `timeoutMs` | `120000` | 单个 git 命令被终止前的毫秒数。 |
| `outputMaxBytes` | `16384` | 单个 git 命令的内存 stdout 上限。 |

不在 git 仓库内的目录会抛出 `git-update/not-a-repository`，其 details 携带探测的 `cwd`。其他失败模式都是已结算的结果：退出码非零的 git 命令成为失败的步骤或携带该命令诊断的 `failed` 结果，遇到冲突的变基成为 `conflict` 结果而不是异常。冲突会中止变基、恢复暂存，并在 `message` 中列出冲突路径；更新前的提交与工作区通过备份标签保持可达。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
