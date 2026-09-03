# Agent Note: Force-live model sync keeps NVIDIA's catalog current without a manual refresh

Status: implemented

English | [中文](2026-08-30-force-live-model-auto-sync.zh.md)

## Problem

An NVIDIA NIM account gains new models, but DeepSeek Harness's model picks do
not reflect them. The pi-ai adapter answers a catalog route from its **static
installed catalog** (pi-ai `^0.84.2`), making no network call, so `llm/discoverModels`
for `nvidia` returns the bundled 18-model registry, not the live
`https://integrate.api.nvidia.com/v1/models` list (which advertises ~100+).

A prior on-disk feature (a manual "refresh models" button + a `forceLive` wire
field) was reverted when the checkout advanced to `0.1.2-alpha.1`. The user
reported the models "disappeared after a harness update," which read as data
loss.

Verified against the real setup: the model additions were **not** lost. They
live in `~/.dsh/settings.yaml` (the user settings layer, outside the repo), and
the adapter still serves all 103 of them (`listModels('nvidia')`). What the
update wiped was the **on-disk feature code**, not the model data. So the real
ask is twofold: re-provide an update mechanism, and make the persistence
guarantee explicit.

## Decision

1. **`forceLive?: boolean` on `LlmModelDiscoveryRequest`** (`packages/llm/llm/src/types.ts`).
   A catalog-route interrogation wants the endpoint's current list, so
   `discovery.ts` skips the catalog short-circuit when `forceLive` is set and
   falls back to the catalog provider's own base URL (`catalogProvider(provider)?.baseUrl`)
   when the request names none — so `nvidia` is asked live against its own
   endpoint with no base URL in the request.

2. **Auto-sync (option C, off by default)** in `ModelsSettingsStore.syncModelsNow()`:
   after a successful `load()`, each configured pi-ai route is force-live
   interrogated and its new models are written **add-only** into the route's
   `models` list via `settings.mutate`. Existing entries (including a user's
   tuned capacities) are preserved verbatim and never duplicated; a route that
   already serves a model is left untouched. A `dsh.modelsSettings.autoSync`
   localStorage flag (default off) gates it, and a page toggle switches it. The
   default is off because the action interrogates every configured pi-ai
   endpoint over the wire on each page load — opt-in keeps that network work
   behind an explicit choice.

3. **Failure isolation.** A route that cannot be probed (no catalog, no base URL,
   wrong protocol) is reported per-route and never fails the whole action; the
   page shows the count added or the rejection text.

## Persistence guarantee

Model additions are written to the **user settings layer** (`~/.dsh/settings.yaml`),
which sits outside the repository. A harness update rewrites the app bundle and
the base/composition layer, not this file, so user additions survive. The
perceived loss round was the feature **code** reverting; the data was intact.
Auto-sync re-adds anything missing on next page open and keeps the catalog
current as NVIDIA adds models.
