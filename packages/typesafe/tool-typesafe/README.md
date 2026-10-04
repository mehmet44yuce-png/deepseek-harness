---
description: "The model-facing typesafe_decide tool over TypeSafe's System One API: typed questions, structured answers, credential resolution, and failure mapping, for users and maintainers choosing, configuring, or debugging the tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-typesafe

English | [中文](README.zh.md)

## Summary

`dsh-tool-typesafe` gives the agent TypeSafe's System One model (Jev) as a tool. One call sends a state and a set of typed questions; TypeSafe evaluates each question against that state independently and returns one structured answer per question — the option a `choice` picked with its distribution, the `score` a rating landed on with its legend, or the yes probability of a `noul` question. The tool returns those answers unchanged, so the agent branches on probabilities and confidence instead of parsing prose. The API key resolves per call and never reaches a log or an error message.

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

Mount the package in any composition whose agent should make TypeSafe decisions. It registers `typesafe_decide` on `ctx.tools`; nothing else is required beyond a resolvable API key.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-typesafe'
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | none | Explicit API key, highest precedence; prefer the reference so the key stays out of composition files |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Credential reference naming the key |
| `baseURL` | `https://api.typesafe.ai/v1` | Endpoint base; `/systemone` is appended |
| `model` | `jev-latest` | Model TypeSafe evaluates with |
| `timeoutMs` | `40000` | Per-request timeout in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-typesafe) is the exhaustive source for the accepted fields.

### How the API key resolves

Resolution happens at call time, so a rotated credential reaches the next call without a restart. The first layer that supplies a value wins: the explicit `apiKey` config field; then the reference through the credentials seam (`ctx.credentials`); then that reference in the launching environment. A composition without the credentials seam reads the environment directly. When no layer supplies a value the call fails with a message naming the reference, and an unusable value — blank, or carrying characters no HTTP header can transport — fails before any request is sent. Neither message contains the key.

### What each call sends and returns

Arguments are a required `state` — text, or structured JSON that the questions refer to by field — and a required `questions` array. Each question carries a unique `id`, a `type`, `instructions` (text, or structured JSON holding the question and the data it names), and the criteria that type needs: `choice` takes a map of option to description, `score` takes two to ten ordered level descriptions, and `noul` optionally takes descriptions of what yes and no mean. Every description accepts a string, object, array, or null. Questions are projected into the id-keyed map TypeSafe expects.

The result is the vendor's answer envelope: the resolved `model` (for example `jev-1.13.0`, not the requested alias), the decoded `answers` keyed by question id, and `usage` when TypeSafe reports it. The model reads compact text — the model line, one line per answer, then the provider's token counters when it reported any:

```text
TypeSafe jev-1.13.0
urgency: noul 0.95
department: choice billing (confidence 0.81; billing 0.88, technical 0.12)
frustration: score 1.05 (confidence 0.92; Calm 0, Frustrated 0.95, Very angry 0.05)
tokens: 318 in, 34 out
```

### Failures

A rejected request identifies what to change: HTTP 401 names the key or the reference, and 422 names the request body and quotes the provider's validation detail. Any other status quotes the provider's own body. A failing response also names the provider's `x-typesafe-request-id` when it sent one, so a support report can trace the call. A redirect is refused rather than followed with the key attached; cancellation and the configured timeout report separately from a transport failure; a body that is not JSON or does not match the answer vocabulary fails as an unexpected response.

### Retries

TypeSafe documents HTTP 408, 429, and 5xx as retryable. The tool retries up to `maxRetries` times (default 2, its documented policy) with an exponential backoff that starts at `retryBackoffMs` (default 500 ms), doubles per attempt, stops at `retryBackoffMaxMs` (default 5000 ms), and carries symmetric jitter of `retryJitter` (default 0.25). When `respectRetryAfter` is true (the default), a provider `Retry-After` or `retry-after-ms` header replaces the computed delay, bounded by `retryAfterMaxMs` (default 60000). A transport failure or a per-attempt timeout is retried the same way; a status the vendor does not document as retryable, a caller cancellation, and a refused redirect are not.

### When to choose it

Choose it when the agent needs a classification, a rating, or a yes/no probability it will act on. It is a poor fit for open-ended generation: System One answers ask one narrow question each, and the agent composes the results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, tool registration, question projection, credential resolution |
| [`src/client.ts`](src/client.ts) | System One HTTP gateway, HTTP-status mapping, response decoder, answer-id check |
| [`src/render.ts`](src/render.ts) | Model-facing rendering of one decision |
| [`src/api-key.ts`](src/api-key.ts) | The local API-key transport check |
| [`src/types.ts`](src/types.ts) | The answer, usage, and decision types |

### Export shape

The plugin is a function plugin: it exports `name` / `inject` / `Config` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Credentials stay optional

`inject` declares only `tools`; the credentials service is read at call time through `ctx.get('credentials')`, so a composition without that seam resolves the key from the launching environment instead of failing to load.

### Constraints the schema DSL cannot express

The parameter schema declares the question union, required fields, and literal `type` discriminants. Non-empty strings, ids unique across the array, the 255-option and 2-to-10-level bounds, and which JSON kinds a Choice description admits are checked in `execute`, before any request is sent; the [parameter schema DSL](../../core/tools/README.md) has no node for them.

### No invariant companion

No invariant companion is published because the package owns no durable or cross-package state: it appends no session event, registers no projection, and its HTTP gateway is exercised by ordinary unit tests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [TypeSafe subsystem](../../../docs/subsystems/typesafe.md) — the wire vocabulary and the decision envelope.
- [typesafe group map](../README.md) — the sibling group page and its package table.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-typesafe) — the `typesafe_decide` schema the model receives.
- [TypeSafe API reference](https://docs.typesafe.ai/api) — the vendor's request, response, and error contract.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`typesafe_decide` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-typesafe): a required `state` that accepts text or structured JSON and a required `questions` array whose items are one of three exact-one object branches — `choice` with a required option map, `noul` with optional true/false descriptions, and `score` with a required ordered level array — each carrying its own `id`, `type`, and `instructions` (text or structured JSON). Field descriptions come from the package; the composed tool description is the literal below.

##### Verbatim tool description

```markdown
Evaluate a state against typed questions with the TypeSafe System One model (Jev) and get structured answers the next step can use directly. Ask several narrow questions in one call: every question is judged against the same state independently and in parallel, so adding questions barely changes response time. Use `choice` to pick one option from a labelled set, where `criteria` maps each option to the situation it describes; `score` to rate the state against ordered level descriptions in `criteria`; and `noul` for a yes/no question that returns the probability of yes. A `noul` value is a probability, not a grade: ask a `score` question when you need a position on a scale. Every question needs a unique `id`, and each answer comes back under that id. Prefer this over guessing a classification, probability, or rating. Choice and score answers carry `confidence`: report it, and treat a low-confidence answer as uncertain instead of decided.
```

#### Token effect

Fixed schema cost on every request where the tool is visible; the description and schema are stable for a given configuration.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call retains the whole `state` and every question argument. A successful call returns the vendor's decision as text: `TypeSafe <model>` on the first line, then one line per question id — `<id>: noul <p>`, `<id>: choice <option> (confidence <c>; <option> <p>, …)`, or `<id>: score <s> (confidence <c>; <level> <p>, …)`, and closes with `tokens: <in> in, <out> out` when the provider reported usage. Stable failures name the fix, for example `Error: tool-typesafe: no TypeSafe API key; store TYPESAFE_API_KEY through the credentials service (the web Models page writes it), set the plugin's `apiKey` config field, or export TYPESAFE_API_KEY in the launching environment` and `Error: tool-typesafe: TypeSafe rejected the API key (HTTP 401); check the configured key or credential reference`.

#### Token effect

Token growth scales with the submitted state and question text, which remain in history until compaction. The result scales with the number of answers, not with the state it evaluated.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **One request per call** — answers are returned whole; the tool never fans out, filters, or re-ranks what TypeSafe answered.
- **Key material comes from configuration or the environment** — there is no interactive login or authorization flow for TypeSafe.
- **No token-budget pre-check** — TypeSafe caps one request at 64k tokens (32k for the state plus the longest question); the tool sends the request and reports the provider's rejection instead of measuring tokens locally.
- **No model catalog** — the endpoint's `GET /v1/models` listing is not exposed; the model comes from configuration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked vendor documentation.

#### Open: pre-flight token budget

TypeSafe caps one request at 64k tokens (32k for the state plus the longest question). A local estimate from the harness token meter could reject an oversized request before the wire; today the provider's HTTP 422 is the only signal.

#### Open: model discovery

The endpoint lists its models at `GET /v1/models`. A discovery surface would let a caller pin a version instead of following the `jev-latest` alias, at the cost of another model-facing tool.

</details>
