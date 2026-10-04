# TypeSafe System One 工具

[English](typesafe.md) | 中文

[`@deepseek-ai/dsh-tool-typesafe`](../../packages/typesafe/tool-typesafe/README.zh.md) 拥有的 TypeSafe 词汇：`typesafe_decide` 工具发往 TypeSafe System One 端点的请求、它解码的答案变体，以及它解析的凭据层。工具的配置、渲染与失败行为见[包 README](../../packages/typesafe/tool-typesafe/README.zh.md)。

## 请求

一次 `POST https://api.typesafe.ai/v1/systemone` 携带 `{ state, model, questions }`。`state` 是问题所评判的内容；`model` 默认为 `jev-latest` 别名；`questions` 是以调用方问题 id 为键的映射。问题 id 从不发送给底层模型。

一个问题携带 `type` 与 `instructions`，以及该类型定义的判据。`choice` 问题需要“选项到描述”的映射，最多接受 255 个选项。`score` 问题需要一个包含两到十个等级描述的升序数组。`noul` 问题可选地在 `true` 与 `false` 键下描述“是”与“否”的含义。

## 答案

每个答案都携带产生它的问题的 `type`，答案映射使用与请求相同的 id。`noul` 答案是 `{ type, noul }`，即陈述为真的概率。`choice` 答案是 `{ type, choice, probabilities, confidence }`：概率最高的选项、每个选项的概率，以及由该分布导出的置信度。`score` 答案是 `{ type, score, legend, probabilities, confidence }`：概率加权得分、每个等级索引映射回的描述，以及同样的两项分布事实。信封还携带 `model`——解析后的身份，例如 `jev-1.13.0`——以及可选的 `usage`，含 `input_tokens` 与 `output_tokens`。

工具要求答案 id 与请求完全一致：缺失或多余的 id 都会作为意外响应失败，而不会产生静默的默认值。

## 凭据解析与传输

API 密钥在调用时按序解析：显式的 `apiKey` 配置字段、通过 `ctx.credentials` 解析的 `apiKeyEnv` 引用，最后是启动环境中的该引用。空白或无法传输的取值会在发出任何请求之前本地失败，且取值与解析出的密钥都不会进入错误消息。

请求拒绝重定向，凭据因此无法被转发到其他来源；请求在调用方的取消信号与配置超时融合后运行。非 2xx 状态映射为明确消息：401 指向凭据，402 指向套餐或计费，422 附带厂商的校验细节，429 与 5xx 附带稍后重试的指示。
