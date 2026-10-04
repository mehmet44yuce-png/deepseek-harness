---
description: "dsh Web 客户端的 workspace git 更新 Remote：读取检出与上游的关系，在备份标签之后变基，并可选推送配置的 fork。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-git-update

[English](README.md) | 中文

## 概述

Web 客户端调用 `gitUpdate/status` 读取检出的分支、上游引用、领先/落后计数与工作区清洁状态，调用 `gitUpdate/update` 获取上游、在备份标签之后把分支变基、恢复暂存的改动，并可选把分支推送到配置的远程。失败或冲突的尝试会中止变基，并通过标签保留更新前的提交与工作区，因此本地工作不会变得不可达。该服务仅通过 Remote 暴露，不拥有任何面向模型的表面，读写宿主的检出。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

调用 `gitUpdate/status` 显示当前关系，调用 `gitUpdate/update` 让检出保持最新。两者都是普通的 unary Remote 方法；`update` 接受可选的 `remote`、`upstreamBranch` 与 `pushRemote` 覆盖值，插件级 `Config` 提供相同默认值。

### status 报告什么

`repository` 是仓库顶层绝对目录，`branch` 是检出的分支名，`upstream` 是比较用的引用（`<remote>/<branch>`，例如 `origin/master`）。`ahead` 与 `behind` 是 `git rev-list --left-right --count` 的两侧，`dirty` 表示已跟踪文件是否有未提交的修改，`untracked` 列出未被忽略的未跟踪路径，`head` 与 `upstreamHead` 是缩写的提交 id。本地无法解析的上游引用报告零计数与空的 `upstreamHead`；`status` 从不获取。

### update 做什么

`update` 在改动任何东西之前拒绝分离 HEAD 与已在进行变基的检出。否则它会带修剪地获取远程，并且只在分支落后于上游引用时：备份脏的或有未跟踪文件的工作区、丢弃本地对 `pnpm-lock.yaml` 的修改（重新安装会再生成锁文件，备份会保留这些修改）、暂存其余改动、把分支变基到上游引用、恢复暂存，并在配置了 `pushRemote` 时推送。`outcome` 为 `up-to-date`、`updated`、`conflict`、`refused` 或 `failed`；`steps` 记录每一步的 `ok`、`skipped` 或 `failed` 状态及其细节；`before` 与 `after` 携带尝试前后的状态；`headBackupTag` 与 `workTreeBackupTag` 命名保存更新前状态的标签。

变基会在不停下的情况下化解两类冲突。git 的 rerere 在此前对同一改动变基时记录的解决方案会被重放，因此与上游冲突的本地改动只需手动解决一次。仅限于由工具再生成的文件（`pnpm-lock.yaml`、翻译配对 `*.i18n.yaml` 记录与测试 `__snapshots__`）的冲突取上游一侧。`rebase` 步骤的细节会列出以这两种方式化解的路径。其他任何冲突都会中止变基、恢复暂存，并在 `message` 中列出冲突路径。

`updated` 结果以一个 `restart` 步骤结束。启动器设置了 `DSH_SUPERVISED=1` 的宿主（仓库的 `scripts/start-web.bat` 会设置）会在回复后不久请求退出码 `75`；启动器随后在没有宿主占用文件时运行 `pnpm install` 与 `pnpm run build`，并重新启动宿主。没有监督进程时该步骤被跳过，并列出需要手动运行的命令。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `repository` | 宿主进程工作目录 | 用于发现仓库的目录。 |
| `remote` | `origin` | 更新获取并变基到的远程。 |
| `upstreamBranch` | 远程报告的分支 | 上游分支名；缺省表示远程自己的分支。 |
| `pushRemote` | 未设置 | 完成后推送到的远程；缺省表示跳过推送。 |
| `skipPushHooks` | `false` | 推送是否绕过仓库的 pre-push 钩子。 |
| `timeoutMs` | `120000` | 单个 git 命令被终止前的毫秒数。 |
| `outputMaxBytes` | `16384` | 单个 git 命令的内存 stdout 上限。 |

### 失败

不在 git 仓库内的目录会抛出 `git-update/not-a-repository`，其 details 携带探测的 `cwd`。其他失败模式都是已结算的结果：退出码非零的 git 命令成为失败的步骤或携带该命令诊断的 `failed` 结果，遇到冲突的变基成为 `conflict` 结果而不是异常。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

引擎遵循一条规则：每个破坏性步骤之前都有让前一状态保持可达的备份。工作区快照通过私有索引文件写入，因此仓库的真实索引与工作区从不被触碰；快照提交以固定身份用 `commit-tree` 构建，因此标签不依赖仓库配置。随后脏的工作区以 `--include-untracked` 暂存，并在每条退出路径上恢复，包括获取失败、上游引用缺失与变基冲突。每次尝试从自己的时钟派生一个时间戳后缀，因此它创建的标签共享同一名字主干。

### 安全推送

推送先以 `ls-remote` 读取远程的分支头，然后使用固定到该值的 `--force-with-lease`，因此读取之后移动过的远程会拒绝推送，而不是被覆盖。`skipPushHooks` 会加上 `--no-verify`。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `GitUpdateService`：`gitUpdate` Remote 服务、其 `Config` 与 `git-update/not-a-repository` 失败 |
| [`src/sync.ts`](src/sync.ts) | 更新引擎：仓库事实、工作区与头部备份、变基、暂存恢复与推送 |
| [`src/runner.ts`](src/runner.ts) | `GitRunner`：在清洗过的环境、超时与有界输出下运行的一个已解析 git 可执行文件 |
| [`src/types.ts`](src/types.ts) | 线载荷类型：状态、选项、结果、步骤与结果 |

Typert 生成由 `./typert` 与 `./remote` 暴露的宿主与客户端 Remote 产物。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Remote 组装](../../api/remotes/README.zh.md)——客户端如何在不导入本实现的情况下消费 `gitUpdate/status` 与 `gitUpdate/update`。
- [git 更新设置界面](../../client/ui-settings-git-update/README.zh.md)——渲染状态并运行更新的浏览器分区。
- [子进程能力](../../subprocess/subprocess/README.zh.md)——运行器所驱动的 spawn 契约。

-----

<a id="model-experience"></a>
## 模型体验

无。该宿主侧 git 更新服务不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个服务一个检出**：`repository` 只命名一个目录；更新第二个仓库需要第二个已配置实例。
- **没有逐步进度**：`update` 是一次 unary 调用，结算时给出完整步骤列表，因此客户端只显示运行状态，而不是实时的步骤迁移。
- **备份标签会累积**：每次移动分支或为脏工作区做快照的尝试都会创建 `backup/dsh-update-*` 标签，且没有任何清理。
- **推送只覆盖一个分支**：只推送检出的分支并使用其自身名称；其他本地分支与标签留在本地。
- **只有已记录或可再生成的冲突会自行化解**：没有 rerere 解决方案的源码冲突会中止变基并恢复更新前状态；在启用 `rerere.enabled` 的手动变基中解决一次后，下次更新即可重放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。`status` 与 `update` 通过同一个运行器读写同一个仓库，因此探针只能重跑实现；拒绝路径与命令序列由 [`tests/sync.spec.ts`](tests/sync.spec.ts) 直接断言。
