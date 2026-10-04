---
description: "The typesafe group map: the model-facing typesafe_decide tool over TypeSafe's System One API, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/typesafe

English | [中文](README.zh.md)

## Summary

The typesafe group connects the agent to TypeSafe's System One API: the agent asks several typed questions about one state and receives structured answers — a chosen option, a score against ordered levels, or a yes/no probability — with the confidence TypeSafe derives from each distribution. The group ships one product package that provides the `typesafe_decide` tool. Answers are the API's own values passed through unchanged, so the agent branches on data instead of parsing generated text.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-typesafe`](tool-typesafe/README.md) | Lets the agent ask TypeSafe System One questions and read the structured answers | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [TypeSafe subsystem](../../docs/subsystems/typesafe.md) — the System One wire vocabulary, credential resolution, and the decision envelope.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-typesafe) — the `typesafe_decide` schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-tool-typesafe) — every accepted config field.
- [TypeSafe API reference](https://docs.typesafe.ai/api) — the vendor's request, response, and error contract.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
