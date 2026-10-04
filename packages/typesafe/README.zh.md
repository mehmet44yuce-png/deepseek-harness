---
description: "typesafe 分组地图：面向模型的 typesafe_decide 工具，经由 TypeSafe 的 System One API 工作，供浏览该分组的用户与维护者阅读。"
kind: "package-group"
---

# packages/typesafe

[English](README.md) | 中文

## 概述

typesafe 分组把智能体接到 TypeSafe 的 System One API：智能体针对同一份状态提出若干类型化问题，取回结构化答案——被选中的选项、按有序等级给出的评分，或一个“是”的概率——并附带 TypeSafe 依据各自分布得出的置信度。该分组只发布一个产品包，提供 `typesafe_decide` 工具。答案就是 API 自身的取值，原样透传，智能体因此对数据分支，而不是解析生成的文本。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发笔记](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-typesafe`](tool-typesafe/README.zh.md) | 让智能体提出 TypeSafe System One 问题并读取结构化答案 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [TypeSafe 子系统](../../docs/subsystems/typesafe.zh.md) —— System One 线上词汇、凭据解析与决策信封。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-typesafe) —— 模型收到的 `typesafe_decide` 模式。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-tool-typesafe) —— 全部可接受的配置字段。
- [TypeSafe API 参考](https://docs.typesafe.ai/api) —— 厂商的请求、响应与错误约定。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
