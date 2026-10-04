# TypeSafe System One tool

English | [中文](typesafe.zh.md)

The TypeSafe vocabulary owned by [`@deepseek-ai/dsh-tool-typesafe`](../../packages/typesafe/tool-typesafe/README.md): the request the `typesafe_decide` tool sends to TypeSafe's System One endpoint, the answer variants it decodes, and the credential layers it resolves. Tool configuration, rendering, and failure behavior are on the [package README](../../packages/typesafe/tool-typesafe/README.md).

## Request

One `POST https://api.typesafe.ai/v1/systemone` carries `{ state, model, questions }`. `state` is the content the questions judge; `model` defaults to the `jev-latest` alias; `questions` is a map keyed by the caller's question ids. Question ids are never sent to the underlying model.

A question carries `type` and `instructions`, plus the criteria its type defines. A `choice` question requires a map of option to description and accepts at most 255 options. A `score` question requires an array of two to ten level descriptions in ascending order. A `noul` question optionally describes what yes and what no mean under `true` and `false` keys.

## Answers

Every answer carries the `type` of the question that produced it, and the answer map uses the same ids as the request. A `noul` answer is `{ type, noul }`, the probability that the statement is true. A `choice` answer is `{ type, choice, probabilities, confidence }`: the highest-probability option, every option's probability, and the confidence derived from that distribution. A `score` answer is `{ type, score, legend, probabilities, confidence }`: the probability-weighted score, each level index mapped back to its description, and the same two distribution facts. The envelope also carries `model` — the resolved identity, such as `jev-1.13.0` — and optional `usage` with `input_tokens` and `output_tokens`.

The tool requires exactly the requested ids: a missing or unexpected id fails as an unexpected response rather than producing a silent default.

## Credential resolution and transport

The API key resolves at call time, in order: the explicit `apiKey` config field, the `apiKeyEnv` reference through `ctx.credentials`, then that reference in the launching environment. A blank or untransmittable value fails locally, before any request, and neither the value nor the resolved key ever enters an error message.

The request refuses redirects, so the credential cannot be forwarded to another origin, and runs under the caller's cancellation signal fused with the configured timeout. Non-2xx statuses map to explicit messages: 401 for the credential, 402 for plan or billing, 422 with the provider's validation detail, 429 and 5xx with a retry-after-a-short-delay instruction.
