---
description: "面向模型的 typesafe_decide 工具，经由 TypeSafe 的 System One API 工作：类型化问题、结构化答案、凭据解析与失败映射，供选择、配置或调试该工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-typesafe

[English](README.md) | 中文

## 概述

`dsh-tool-typesafe` 把 TypeSafe 的 System One 模型（Jev）作为工具交给智能体。一次调用发送一份状态和一组类型化问题；TypeSafe 针对该状态独立评估每个问题，并为每个问题返回一个结构化答案——`choice` 问题选中的选项及其完整分布、`score` 命中的评分及其等级图例，或 `noul` 问题的“是”概率。工具原样返回这些答案，智能体因此对概率与置信度分支，而不是解析生成的文本。API 密钥每次调用时从配置的引用、凭据接缝或启动环境解析，且绝不进入日志或错误消息。

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

在任何需要智能体做出 TypeSafe 决策的组装中挂载本包。它把 `typesafe_decide` 注册到 `ctx.tools`；除可解析的 API 密钥外无需其他配置。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-typesafe'
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 无 | 显式 API 密钥，优先级最高；优先使用引用，使密钥不进入组装文件 |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 命名该密钥的凭据引用 |
| `baseURL` | `https://api.typesafe.ai/v1` | 端点基址；追加 `/systemone` |
| `model` | `jev-latest` | TypeSafe 用于评估的模型 |
| `timeoutMs` | `40000` | 每次请求的超时毫秒数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-typesafe)是可接受字段的完整来源。

### API 密钥如何解析

解析发生在调用时，因此轮换后的凭据无需重启即可用于下一次调用。最先提供取值的层胜出：显式的 `apiKey` 配置字段；其次是通过凭据接缝（`ctx.credentials`）解析该引用；最后是启动环境中的同名引用。没有凭据接缝的组装直接读取环境。若没有任何层提供取值，调用失败，消息中给出该引用的名字；不可用的取值——空白，或含有任何 HTTP 标头都无法承载的字符——在发出请求之前就失败。两种消息都不含密钥本身。

### 每次调用发送与返回什么

参数是必需的 `state`——文本，或问题按字段引用的结构化 JSON——与必需的 `questions` 数组。每个问题带有唯一的 `id`、`type`、`instructions`（文本，或把问题与其引用的数据放在同一结构中的 JSON），以及该类型所需的判据：`choice` 接受“选项到描述”的映射，`score` 接受两到十个按升序排列的等级描述，`noul` 可选地接受对“是”与“否”含义的描述。每个描述都接受字符串、对象、数组或 null。问题会被投影为 TypeSafe 期望的、以 id 为键的映射。

结果是厂商的答案信封：解析后的 `model`（例如 `jev-1.13.0`，而非请求的别名）、以问题 id 为键解码出的 `answers`，以及 TypeSafe 报告时的 `usage`。模型读到的是紧凑文本——模型行，随后每个答案一行，最后是厂商报告用量时的 token 计数行：

```text
TypeSafe jev-1.13.0
urgency: noul 0.95
department: choice billing (confidence 0.81; billing 0.88, technical 0.12)
frustration: score 1.05 (confidence 0.92; Calm 0, Frustrated 0.95, Very angry 0.05)
tokens: 318 in, 34 out
```

### 失败

被拒绝的请求会指明要改什么：HTTP 401 指向密钥或引用，422 指向请求体并引用厂商的校验细节。其他状态会引用厂商自己的响应体。失败响应还会在厂商发送时带上其 `x-typesafe-request-id`，便于支持人员追踪该次调用。重定向会被拒绝，而不是带着密钥跟随；取消与配置的超时和传输失败分别报告；非 JSON、或不符合答案词汇的响应体，作为意外响应失败。

### 重试

TypeSafe 文档将 HTTP 408、429 与 5xx 列为可重试。工具最多重试 `maxRetries` 次（默认 2，即其文档策略），采用指数退避：从 `retryBackoffMs`（默认 500 毫秒）开始，每次尝试翻倍，止于 `retryBackoffMaxMs`（默认 5000 毫秒），并带有 `retryJitter`（默认 0.25）的对称抖动。当 `respectRetryAfter` 为真（默认）时，厂商的 `Retry-After` 或 `retry-after-ms` 头会取代计算出的延迟，并受 `retryAfterMaxMs`（默认 60000）限制。传输失败或单次尝试超时同样会重试；厂商未列为可重试的状态、调用方取消，以及被拒绝的重定向不会重试。

### 何时选择它

当智能体需要据以行动的类别、评分或“是/否”概率时选择它。它不适合开放式生成：System One 的答案每次只回答一个窄问题，由智能体组合结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 模式、工具注册、问题投影、凭据解析 |
| [`src/client.ts`](src/client.ts) | System One HTTP 网关、HTTP 状态映射、响应解码、答案 id 校验 |
| [`src/render.ts`](src/render.ts) | 面向模型渲染一次决策 |
| [`src/api-key.ts`](src/api-key.ts) | 本地 API 密钥传输校验 |
| [`src/types.ts`](src/types.ts) | 答案、用量与决策类型 |

### 导出形态

本插件是函数插件：导出 `name` / `inject` / `Config` / `apply`，没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（见[事后分析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 凭据保持可选

`inject` 只声明 `tools`；凭据服务在调用时通过 `ctx.get('credentials')` 读取，因此没有该接缝的组装会改为从启动环境解析密钥，而不是加载失败。

### 模式 DSL 无法表达的约束

参数模式声明了问题联合、必填字段与字面 `type` 判别式。非空字符串、数组内唯一的 id、255 个选项与 2 至 10 个等级的边界，以及 Choice 描述允许哪些 JSON 种类，都在 `execute` 中、发出请求之前检查；[参数模式 DSL](../../core/tools/README.zh.md)没有对应的节点。

### 不发布不变式伴随包

本包不发布不变式伴随包，因为它不拥有任何持久或跨包状态：它不追加会话事件、不注册投影，其 HTTP 网关由普通单元测试覆盖。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [TypeSafe 子系统](../../../docs/subsystems/typesafe.zh.md) —— 线上词汇与决策信封。
- [typesafe 分组地图](../README.zh.md) —— 同级分组页及其包表。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-typesafe) —— 模型收到的 `typesafe_decide` 模式。
- [TypeSafe API 参考](https://docs.typesafe.ai/api) —— 厂商的请求、响应与错误约定。

-----

<a id="model-experience"></a>
## 模型体验

### 工具模式

#### 模型看到什么

模型看到生成的[`typesafe_decide` 模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-typesafe)：必需的 `state`（接受文本或结构化 JSON）与必需的 `questions` 数组，后者的元素是三个“恰好一个”对象分支之一——`choice` 带必需的选项映射、`noul` 带可选的 true/false 描述、`score` 带必需的有序等级数组——每个分支各自带有 `id`、`type` 与 `instructions`（文本或结构化 JSON）。字段描述来自本包；组合出的工具描述即下方原文。

##### 工具描述原文

```markdown
Evaluate a state against typed questions with the TypeSafe System One model (Jev) and get structured answers the next step can use directly. Ask several narrow questions in one call: every question is judged against the same state independently and in parallel, so adding questions barely changes response time. Use `choice` to pick one option from a labelled set, where `criteria` maps each option to the situation it describes; `score` to rate the state against ordered level descriptions in `criteria`; and `noul` for a yes/no question that returns the probability of yes. A `noul` value is a probability, not a grade: ask a `score` question when you need a position on a scale. Every question needs a unique `id`, and each answer comes back under that id. Prefer this over guessing a classification, probability, or rating. Choice and score answers carry `confidence`: report it, and treat a low-confidence answer as uncertain instead of decided.
```

#### Token 影响

在工具可见的每个请求上都是固定的模式开销；给定配置后，描述与模式保持稳定。

#### KV 缓存影响

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该模式的复用失效。

### 工具调用历史与结果

#### 模型看到什么

每次助手工具调用都保留完整的 `state` 与全部问题参数。成功的调用以文本返回厂商的决策：首行为 `TypeSafe <model>`，随后每个问题 id 一行——`<id>: noul <p>`、`<id>: choice <option> (confidence <c>; <option> <p>, …)` 或 `<id>: score <s> (confidence <c>; <level> <p>, …)`，并在厂商报告用量时以 `tokens: <in> in, <out> out` 结尾。稳定的失败会指明修法，例如 `Error: tool-typesafe: no TypeSafe API key; store TYPESAFE_API_KEY through the credentials service (the web Models page writes it), set the plugin's apiKey config field, or export TYPESAFE_API_KEY in the launching environment` 与 `Error: tool-typesafe: TypeSafe rejected the API key (HTTP 401); check the configured key or credential reference`。

#### Token 影响

Token 增长取决于提交的状态与问题文本，它们会保留在历史中直到压缩。结果的大小取决于答案数量，而非被评估状态的大小。

#### KV 缓存影响

追加式；新可见内容跟在可复用的请求前缀之后，不会使既有 KV 缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

这些限制界定了本工具何时不适合使用。它们是当前的包约束，不是任务清单。

- **每次调用一个请求** —— 答案原样返回；工具不会对 TypeSafe 的回答做扇出、过滤或重排。
- **密钥材料来自配置或环境** —— 没有面向 TypeSafe 的交互式登录或授权流程。
- **没有 token 预算预检** —— TypeSafe 将单次请求限制为 64k token（state 加最长问题为 32k）；工具直接发送请求并报告厂商的拒绝，而不是在本地计量 token。
- **没有模型目录** —— 不暴露端点的 `GET /v1/models` 列表；模型来自配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的问题与方向。它明确不具权威性——已发布的行为、限制与已接受的依据都位于上文各节、包代码与所链接的厂商文档中。

#### 未决：请求前的 token 预算

TypeSafe 将单次请求限制为 64k token（state 加最长问题为 32k）。借助 harness 的 token 计量做本地估算，就能在发出请求前拒绝超限请求；目前唯一的信号是厂商的 HTTP 422。

#### 未决：模型发现

端点通过 `GET /v1/models` 列出其模型。若提供发现入口，调用方就能固定某个版本，而不是跟随 `jev-latest` 别名，代价是多一个面向模型的工具。

</details>
