---
description: "Upstream-update section in Web Settings for the dsh web client: the checkout's upstream relation, one update action, and the reported steps and backup tags."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-git-update

English | [中文](README.zh.md)

## Summary

The **Update** section shows the workspace checkout's branch, upstream ref, ahead and behind counts, and working-tree cleanliness, and runs one update over the `gitUpdate` Remote. A run shows a busy state and then the finished attempt's outcome, message, backup tags, and per-step statuses. Configuration stays with the Host service: the section sends no overrides and renders whatever the deployment configured.

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

Open Settings and select **Update**. The section reads `gitUpdate/status` when it mounts and renders one primary **Update** button, disabled until a status read succeeds. Pressing it calls `gitUpdate/update({})`; the section reports the attempt as running and then renders its result. A failed status read shows the wire diagnostic verbatim with a retry action.

### Reading the status facts

The facts list names the branch, the compared upstream ref, the ahead and behind counts, whether the working tree is dirty, the untracked paths, and the two abbreviated commit ids. An unresolved upstream reports an empty upstream head and is rendered as none.

### Reading the result

The result panel names the outcome, prints the Host message, lists the backup tags the attempt created, and then every reported step with its own status and detail. A step detail is the Host's own text, including the raw git diagnostic of a failed step.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers one localized `settings.section` contribution with id `git-update` and order 50. Registration uses `ctx.slots.inject()`, so it follows late section declaration, redeclaration, locale changes, and teardown without importing the settings shell. The plugin injects the `slots`, `locale`, `remote`, and `remote.gitUpdate` services; the two Remote calls are bound in the apply closure, and components receive them through the derived inject share only.

### Store

`GitUpdateStore` owns the status read and the single attempt. The status read keeps only the latest response; a finished attempt publishes its result, then re-reads the status so the displayed relation reflects the moved branch rather than the pre-attempt snapshot.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-settings](../ui-settings/README.md) — the settings domain base declaring `settings.section`.
- [ui-settings-general](../ui-settings-general/README.md) — the settings shell that renders the section navigation.
- [ui-primitives](../ui-primitives/README.md) — the button atom this section renders.
- [git-update host service](../../host/git-update/README.md) — the Host side of the Remote this section calls.
- [api-remotes](../../api/remotes/README.md) — the Remote assembly that mounts the gitUpdate namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings section that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No configuration UI** — remote, upstream branch, and push remote come from the Host service `Config`; the section sends no overrides, so the deployment owns those choices.
- **No live progress** — the update is one unary call, so the section reports a running state rather than per-step transitions.
- **Status is read on mount and after each attempt** — the section does not subscribe to gitUpdate events or refetch after a reconnect; reopening Settings or the retry action reads again.
- **The previous result stays visible until the next attempt starts** — a new run clears it, and nothing else does.
- **Remote-only surface** — the section renders no local Git operation; an unreachable Host leaves the section in its failure state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns one Settings contribution and the snapshot store that renders it, so no independent observations can diverge.
