# Phase 3 Plan - Provider Registry, API Keys, and Director Settings

> Handoff plan for Phase 3 of the Director Agent / Provider Backend roadmap. Execute after Phase 0-2 are accepted, committed, and pushed. Cross-reference [director-agent-provider-roadmap.md](./director-agent-provider-roadmap.md).

## 1. Goal

Port the old Director provider system into the current VS Code fork as a narrow, reusable Provider Backend layer, bring back the old usable Director Settings entry for configuring providers, and include OpenAI Codex OAuth as the Phase 3 OAuth path.

The important correction for this phase is that the old Director provider work is already mature enough to reuse. Phase 3 should not only add headless backend contracts. It should also restore a practical provider settings surface, using the old `ProviderSettingsWidget` / `DirectorCodeSettingsEditor` design as the starting point.

At the end of Phase 3, a user should be able to open Director Settings, add or edit an API-key or OAuth provider, store secrets outside JSON settings, test/refresh models, select defaults, and have the AgentHost-side Director provider see the resulting non-secret provider/model state. The Director agent can still echo until Phase 4 wires the real Director harness.

## 2. Scope

In scope:

- Port provider instance registry semantics from old Director.
- Port API-key storage semantics from old Director.
- Port the old Director OpenAI Codex OAuth token/login/logout semantics as the minimum OAuth target.
- Port model resolver semantics from old Director.
- Port connection test semantics for API-key providers.
- Add a provider protocol routing/conversion layer so matching harness/provider protocols can pass through natively, while cross-protocol combinations use adapters.
- Reuse the old full provider settings UI rather than the older simple API-key-only widget.
- Add a visible Director Settings entry, modeled on the old `director-code.openSettings` command.
- Keep provider configuration available to the Phase 0-2 `DirectorAgent` model list.
- Keep all ordinary provider registry JSON secret-free.
- Add tests for registry normalization, secret storage behavior, OpenAI Codex OAuth state, direct protocol routing, provider conversion, model cache invalidation, and backend hub integration.

Out of scope:

- Real Director `AgentEngine` turns. That is Phase 4.
- Claude SDK de-CAPI migration. That is Phase 6.
- OAuth providers beyond OpenAI Codex OAuth, unless another old Director flow ports cleanly through the same boundary without expanding Phase 3 risk.
- Session persistence and conversation restore. That is Phase 9.
- Broad rewrites under `src/vs/sessions/**`, `src/vs/workbench/contrib/chat/**`, or `extensions/copilot/**`.

## 3. Current Inputs

Already implemented in Phase 0-2:

- `src/vs/platform/agentHost/common/directorProviderBackend.ts`
- `src/vs/platform/agentHost/node/director/directorProviderBackendHub.ts`
- `src/vs/platform/agentHost/node/director/directorAgent.ts`
- `src/vs/platform/agentHost/node/director/directorAgentSession.ts`
- `chat.agentHost.directorAgent.enabled`
- `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT`

Old Director reference patch:

- `E:\Projects\Director-Code-batch\Director-Code-112-check\patches\replay\004-director-agent-engine.120-insider.patch`

Important old patch anchors:

- `src/vs/workbench/contrib/directorCode/common/agentEngine/providerRegistry.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/apiKeyService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/authStateService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/oauthService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/modelResolver.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerTypes.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerFactory.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/abstractProvider.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/providerSettingsWidget.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/directorCodeSettingsEditor.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/agentEngine.contribution.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/settingsWriteQueue.ts`

## 4. Key Decisions

### 4.1 Reuse `ProviderSettingsWidget`, Not Only `ApiKeysWidget`

The old patch contains both:

- `ApiKeysWidget`: useful as reference and for some tests, but too narrow.
- `ProviderSettingsWidget`: the real provider manager surface.

Phase 3 should use `ProviderSettingsWidget` as the main reusable UI asset because it already models:

- connected providers;
- popular provider templates;
- Anthropic, OpenAI, Gemini, OpenAI-compatible, and Anthropic-compatible providers;
- base URL and headers;
- default provider/model;
- model refresh;
- connection test;
- enable/disable and disconnect;
- model visibility and runtime defaults.

### 4.2 Add a Director Settings Entry in This Phase

The old entry shape is reusable:

- command id: `director-code.openSettings`;
- editor input: `DirectorCodeSettingsEditorInput`;
- editor pane: `DirectorCodeSettingsEditor`;
- widget: `ProviderSettingsWidget`;
- menu locations in the old patch:
  - Chat config menu;
  - Chat welcome context;
  - Menubar Preferences menu.

Phase 3 should restore a similar entry, but rename labels conservatively to match this fork's current product language:

- command title: `Open Director Settings`;
- editor title: `Director Settings`;
- optional short title: `Director`;
- keep command id `director-code.openSettings` for old Director compatibility;
- optionally add `director.openSettings` as an alias if it is cheap and low-risk;
- menu placement: start with command palette and Chat config menu; add Menubar Preferences if the registration is still clean and narrow.

### 4.3 Workbench Owns User Secrets

The old provider system uses workbench services such as `ISecretStorageService`, `ISharedProcessService`, and `IRequestService`.

The current AgentHost process does not directly register `ISecretStorageService`. Do not solve this by writing API keys into AgentHost config JSON.

Phase 3 should keep the durable secret owner in the workbench side:

- provider registry JSON stores provider metadata only;
- API keys, OAuth access tokens, refresh tokens, and client metadata stay in Secret Storage;
- AgentHost receives only non-secret provider/model state in Phase 3;
- a minimal secret bridge can be designed or stubbed, but raw secret transport should not be required until Phase 4 performs real LLM calls.

### 4.4 Do Not Reuse Copilot CAPI or Copilot Auth

Director-owned provider code must not use:

- `ICopilotApiService`;
- `GITHUB_COPILOT_PROTECTED_RESOURCE`;
- Copilot CAPI model metadata;
- Copilot login state as a prerequisite for Director providers.

The old `directorAgentHostBridge.ts` patch is useful for redaction, TTL, and auth payload ideas, but Phase 3 should avoid reintroducing API keys or OAuth tokens as Copilot-style protected resources unless a later implementation review proves that the existing AgentHost protocol gives no narrower bridge. Prefer an explicit Director-owned provider/auth channel.

### 4.5 Move Practical UI Forward, Keep Deeper Picker Polish Later

The previous roadmap placed Provider Settings UI in Phase 7. This is now split:

- Phase 3: restore the practical Director Settings provider manager and registry/auth/model plumbing.
- Phase 7: deeper Agent Sessions model picker integration, per-session defaults, and polish after real harness traffic exists.

### 4.6 Add Provider Protocol Routing and Conversion

Different model providers do not share one wire protocol:

- Anthropic uses Messages API.
- OpenAI-compatible providers commonly use Chat Completions.
- OpenAI also has the newer Responses API.
- OpenAI Codex/OAuth uses the old Director `openai-codex` bearer-token flow and model family.
- Gemini uses Generative Language API shapes.

Director should not force every request through one normalized wire format. It should route by protocol compatibility first, and convert only when the selected harness and provider use different API types.

Resolution order:

1. **Direct native pass-through** when the harness-required protocol and provider `apiType` match.
2. **Thin proxy pass-through** when a local endpoint is needed for SDK process isolation, but payloads remain native and only auth/base URL/model ids are rewritten.
3. **Conversion adapter** when the harness protocol and provider protocol differ.
4. **Unsupported state** when no safe adapter exists.

Examples:

- Claude-like harness + Anthropic provider: direct Anthropic Messages path. A local proxy may still exist for process isolation, but it should not translate payload shape.
- Codex/OpenAI Responses-shaped harness + OpenAI Codex OAuth provider: direct `openai-codex` path.
- Public OpenAI Responses API provider: reserved until a separate `openai-responses` adapter/auth/model path is implemented.
- OpenAI Chat harness + OpenAI-compatible Chat Completions provider: direct Chat Completions path.
- Claude-like harness + OpenAI Chat Completions provider: conversion from Anthropic-like messages/tools/stream events to OpenAI Chat Completions and back.
- Director `AgentEngine`: may use its Anthropic-like internal normalized format, but that is a harness implementation detail, not a universal transport requirement.

Phase 3 should introduce protocol-aware provider interfaces:

```ts
interface DirectorProviderTransport {
	readonly apiType: DirectorProviderApiType;
	readonly capabilities?: DirectorProviderCapabilities;

	canServe(protocol: DirectorHarnessProtocol): DirectorProtocolRoute;
	createNativeClient?(protocol: DirectorHarnessProtocol): DirectorNativeClient;
	createMessage?(params: DirectorCreateMessageParams): Promise<DirectorCreateMessageResponse>;
	createMessageStream?(params: DirectorCreateMessageParams): AsyncGenerator<DirectorStreamEvent>;
}
```

The normalized request/response should remain available for the Director `AgentEngine` and cross-protocol adapters because the old engine already uses an Anthropic-like shape internally. It should not be treated as the mandatory data plane for native-compatible harness/provider pairs.

```text
Harness required protocol
        |
Protocol router
        |
direct native provider OR conversion adapter
        |
Anthropic Messages / OpenAI Chat Completions / OpenAI Responses / OpenAI Codex / Gemini
```

This matches the useful shape in upstream VS Code: the Copilot Agent path mostly delegates to `@github/copilot-sdk`, while the Claude SDK path speaks Anthropic `/v1/messages` to `ClaudeProxyService`; that proxy forwards to Copilot CAPI's Anthropic-shaped endpoint, so it is a protocol boundary but not a forced Anthropic-to-OpenAI conversion layer.

The existing Phase 1 `openai-completions` literal should be treated as the old OpenAI Chat Completions adapter name. Phase 3 should either keep it as a compatibility alias or introduce a clearer `openai-chat-completions` literal with a migration helper. Keep `openai-codex` distinct from public `openai-responses`: `openai-codex` is the Phase 3 OAuth target, while public `openai-responses` should remain reserved/hidden until its adapter, auth, and model metadata are implemented and tested.

### 4.7 Split Phase 3 Into Three Hard Boundaries

Phase 3 should be implemented as three internal checkpoints:

- Phase 3A: Workbench provider registry, API-key service, OAuth service, model resolver, and Director Settings UI.
- Phase 3B: protocol router, native pass-through transports, conversion adapters, and routing/conversion tests.
- Phase 3C: Workbench-written, secret-free provider/model snapshot consumed by AgentHost `DirectorProviderBackendHub`.

Use a file-backed, profile-scoped secret-free snapshot for Phase 3C. A dedicated Director provider IPC channel can replace or augment it later, but Phase 3 should not stay blocked on that larger bridge.

3A exit criteria:

- Director Settings opens from command palette and the chosen menu entry.
- Registry JSON is secret-free and profile-scoped.
- API-key provider save/delete works through Secret Storage.
- OpenAI Codex OAuth login/logout state works through the old Director semantics or a deterministic fake acceptance target.
- Model refresh and connection test work for at least one API-key provider path.
- Workbench writes the secret-free provider/model snapshot whenever provider, model, default, or auth-state metadata changes.
- No Director provider setup path requires Copilot login or Copilot CAPI.

3B exit criteria:

- Compatibility routing is a pure, shared decision function covered by matrix tests.
- Matching protocols resolve to `native` or `proxy`; cross-protocol paths resolve to `adapter` only when tests cover them; unproven paths resolve to `unsupported`.
- AgentHost common/node code does not import workbench modules.
- Public `openai-responses` remains hidden/reserved unless it is fully implemented and tested separately from `openai-codex`.

3C exit criteria:

- AgentHost reads a file-backed, secret-free provider/model snapshot.
- `DirectorAgent` model metadata reflects configured provider/model state.
- Unsupported, signed-out, expired, missing-key, and disabled states surface as state rather than startup failures.
- Snapshot files, logs, and AgentHost config do not contain raw API keys or OAuth tokens.

### 4.8 Gate Model Visibility by Compatibility

Not every provider/model should appear for every agent. The router should produce a compatibility decision for each harness/provider/model combination:

- `native`: harness and provider share the same API type; show the model.
- `proxy`: protocol is the same but an SDK subprocess needs a local endpoint/auth wrapper; show the model.
- `adapter`: cross-protocol conversion is implemented and covered by tests; show the model.
- `unsupported`: no safe adapter exists; hide the model for that agent and optionally explain it in Director Settings.

This matches the current VS Code pattern. The Copilot Agent asks `@github/copilot-sdk` for its own models and does not expose arbitrary CAPI models. The Claude Agent filters CAPI models to Anthropic vendor plus `/v1/messages` support before showing them. Director should do the same kind of compatibility filtering instead of assuming all provider formats are mutually convertible.

Initial recommended matrix:

| Harness protocol | Provider API type | Phase 3 route | Picker behavior |
|---|---|---|---|
| `anthropic-messages` | `anthropic-messages` | native/proxy | show |
| `openai-codex` | `openai-codex` | native/proxy | show |
| `openai-responses` | `openai-responses` | reserved until adapter/auth/model metadata exists | hide until implemented |
| `openai-chat-completions` | `openai-completions` / `openai-chat-completions` | native/proxy | show |
| Director `AgentEngine` normalized | `anthropic-messages` | thin adapter | show |
| Director `AgentEngine` normalized | `openai-completions` | adapter if tests pass | show |
| Director `AgentEngine` normalized | `gemini-generative` | adapter if tests pass | show |
| `anthropic-messages` | `openai-completions` | adapter later if tests pass | hide until proven |
| `anthropic-messages` | `gemini-generative` | adapter later if tests pass | hide until proven |
| `openai-responses` | `anthropic-messages` / `gemini-generative` | unsupported initially | hide |

The rule is conservative: direct routes are preferred, adapter routes must earn visibility through tests, and unproven routes stay out of the model picker.

Phase 3 only needs an end-to-end picker/model-list check for the current Director provider. Future Claude-like, OpenAI Chat, and Codex harness picker filtering can be represented by compatibility metadata and unit tests until those harness providers are implemented in later phases.

## 5. Target Shape

```text
Workbench Director Settings
        |
Director Provider Registry Service
        |
Secret Storage + OAuth + Model Resolver + Connection Test
        |
secret-free provider/model snapshot
        |
AgentHost Director Provider Backend Hub
        |
DirectorAgent model list and later harness backend resolution
```

Phase 3 should make the provider system usable without making the Phase 2 echo agent pretend to be real. The visible runtime distinction should be:

- provider setup/test/model refresh works;
- `DirectorAgent` can list configured models;
- actual chat replies may still say `Director echo: ...` until Phase 4.

## 6. Files to Create or Modify

### 6.1 Workbench Provider Registry and Auth

Create or port under a narrow Director-owned workbench contribution. Workbench is the owner of user-facing settings, registry persistence, auth state, Secret Storage, OAuth UX, model refresh orchestration, and the secret-free snapshot writer. It should not be the source of truth for AgentHost runtime provider transports.

| Action | File | Purpose |
|---|---|---|
| Create | `src/vs/workbench/contrib/directorCode/common/provider/providerRegistry.ts` | Secret-free provider instance registry. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/apiKeyService.ts` | Secret Storage backed API-key lifecycle. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/oauthService.ts` | OpenAI Codex OAuth login/logout/token lifecycle ported from old Director. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/authStateService.ts` | Resolve current provider auth state without leaking keys to JSON. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/modelResolver.ts` | Static/API/CDN model resolution and cache invalidation. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/providerConnectionTestService.ts` | Workbench-side connection test orchestrator for UI/state that delegates through a service boundary or fakes; it must not import AgentHost node transports directly. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/providerSnapshotService.ts` | Writes the profile-scoped, secret-free provider/model/auth-state snapshot consumed by AgentHost. |
| Create | `src/vs/workbench/contrib/directorCode/common/provider/settingsWriteQueue.ts` | Debounced settings/registry writes from the UI. |

The old files live under `common/agentEngine/`. In this fork, prefer `common/provider/` for workbench registry/auth/model services so they are not owned by the old AgentEngine runtime.

### 6.2 Director Settings UI

Port the practical settings surface:

| Action | File | Purpose |
|---|---|---|
| Create | `src/vs/workbench/contrib/directorCode/browser/providerSettings/providerSettingsWidget.ts` | Main provider manager UI, adapted from old `ProviderSettingsWidget`. |
| Create | `src/vs/workbench/contrib/directorCode/browser/providerSettings/directorSettingsEditor.ts` | Editor pane/input/serializer, adapted from old `DirectorCodeSettingsEditor`. |
| Create | `src/vs/workbench/contrib/directorCode/browser/providerSettings/directorSettings.contribution.ts` | Service registration, command, menu entry, and editor registration. |
| Create | `src/vs/workbench/contrib/directorCode/browser/providerSettings/media/directorSettings.css` | Settings UI styling, adapted narrowly from old widget CSS. |

Avoid placing the new UI inside the generic chat contribution unless registration requires a tiny hook. The durable owner should be `workbench/contrib/directorCode`.

### 6.3 Shared Protocol DTOs and Compatibility

Shared protocol metadata must live below `src/vs/platform/agentHost/**` so AgentHost node code and future harness adapters can consume it without importing workbench.

| Action | File | Purpose |
|---|---|---|
| Modify | `src/vs/platform/agentHost/common/directorProviderBackend.ts` | Add fields needed by registry-backed providers while preserving Phase 1 contract shape. |
| Create | `src/vs/platform/agentHost/common/directorProviderProtocol.ts` | Provider API type, harness protocol, route result, capability, and normalized message DTOs. |
| Create | `src/vs/platform/agentHost/common/directorProviderCompatibility.ts` | Pure route/visibility compatibility decisions for harness/provider/model combinations. |
| Create | `src/vs/platform/agentHost/common/directorProviderRequest.ts` | Pure request builders/stream parsers shared by Workbench connection tests and AgentHost runtime transports without sharing process-specific services. |
| Create | `src/vs/platform/agentHost/common/directorProviderSnapshot.ts` | Secret-free snapshot schema shared by workbench writer and AgentHost reader. |

### 6.4 AgentHost Provider Runtime Transports

Runtime provider transports belong to AgentHost/platform-owned code, not workbench. Workbench must not import these node transports. Workbench connection tests should resolve secrets locally, use `IRequestService`, and call pure request builders/parsers from `agentHost/common` or deterministic fakes. The AgentHost node transports are for Phase 4+ real harness traffic and any AgentHost-local proxy work.

| Action | File | Purpose |
|---|---|---|
| Create | `src/vs/platform/agentHost/node/director/providers/providerFactory.ts` | Provider transport factory for connection tests and Phase 4 reuse. |
| Create | `src/vs/platform/agentHost/node/director/providers/abstractProvider.ts` | Shared HTTP/SSE/error handling for provider adapters. |
| Create | `src/vs/platform/agentHost/node/director/providers/anthropicProvider.ts` | Anthropic Messages transport. |
| Create | `src/vs/platform/agentHost/node/director/providers/openAIChatProvider.ts` | OpenAI Chat Completions and compatible-provider transport. |
| Create | `src/vs/platform/agentHost/node/director/providers/openAICodexProvider.ts` | Old Director OpenAI Codex OAuth transport. |
| Create | `src/vs/platform/agentHost/node/director/providers/geminiProvider.ts` | Gemini Generative transport, if old code ports cleanly. |
| Reserve | `src/vs/platform/agentHost/node/director/providers/openAIResponsesProvider.ts` | Public OpenAI Responses transport; keep hidden until implemented and tested separately from `openai-codex`. |

### 6.5 AgentHost Backend Integration

Adapt the Phase 1 backend hub:

| Action | File | Purpose |
|---|---|---|
| Modify | `src/vs/platform/agentHost/node/director/directorProviderBackendHub.ts` | Replace fake-only source with registry-backed model/provider snapshot, while keeping fake fallback for tests/dev if no providers exist. |
| Modify | `src/vs/platform/agentHost/node/director/directorAgent.ts` | Refresh model list from the real backend hub and surface provider/model errors safely. |
| Modify | `src/vs/platform/agentHost/node/agentHostMain.ts` | Register any new AgentHost-side provider services. |
| Modify | `src/vs/platform/agentHost/node/agentHostServerMain.ts` | Keep server/headless registration consistent. |

### 6.6 Contribution Registration

Likely narrow hooks:

| Action | File | Purpose |
|---|---|---|
| Modify | `src/vs/workbench/workbench.common.main.ts` or nearby contribution manifest | Register `directorSettings.contribution.ts` if required by current build wiring. |
| Modify | `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` | Only if the Chat config menu id is not reachable without importing from chat. Keep this edit tiny. |

Do not modify `extensions/copilot/**`.

## 7. Data Model

Start from old `IDirectorProviderInstance` and normalize into the Phase 1 contract.

Provider instance fields:

- `id`
- `kind`
- `displayName`
- `enabled`
- `authKind`
- `authVariant`
- `apiType`
- `baseURL`
- `headers`
- `apiKeySource`
- `models`
- `defaultModelId`
- `createdAt`
- `updatedAt`

Registry state:

- `version: 1`
- `instances`
- `defaultProviderId`
- `defaultModelId`
- optional migration marker for old settings

Rules:

- Persist only secret-free provider metadata.
- Normalize provider ids through a sanitized id helper.
- Normalize model identifiers with a provider-instance prefix where needed.
- Keep `apiType` as the canonical wire protocol field used by the router. Do not add a second persisted `nativeApiType` in Phase 3; normalize aliases such as `openai-completions` / `openai-chat-completions` at load time.
- Derive harness compatibility from `apiType`, model capabilities, and the shared compatibility matrix. Do not persist `supportedHarnessProtocols` unless implementation proves a provider needs an explicit override.
- Keep compatibility with Phase 1 `DirectorProviderInstance`, `DirectorProviderModel`, and `DirectorProviderSelection`.
- Preserve a migration hook for old settings, but do not import the generated tree as source of truth.

## 8. Secret and Auth Boundary

Phase 3 API-key support should port these old semantics:

- provider key;
- provider instance key;
- model-specific key;
- optional environment variable source;
- delete/rotate key;
- connection test uses the currently resolved key.

Phase 3 OAuth support should port the old Director OpenAI Codex semantics as the minimum target:

- OAuth-capable provider templates;
- login/logout;
- token refresh where the old flow supports it;
- bearer token auth state;
- provider instance state that distinguishes signed-out, expired, and ready.

Other old Director OAuth flows can be ported in Phase 3 only if they fit the same service/auth-state boundary. Otherwise they should stay hidden until Phase 8 OAuth hardening and additional provider support.

Recommended secret keys should retain the old namespace unless there is a strong reason to rename:

- `director-code.apiKey`
- `director-code.modelKey`
- `director-code.modelConfig`
- `director-code.providerInstanceKey`

AgentHost boundary:

- AgentHost may read a secret-free registry/model snapshot.
- The snapshot should contain `DirectorProviderAuthState`, not `DirectorResolvedProviderAuth`.
- Recommended secret-free auth states: `none`, `ready`, `missing`, `expired`, `signedOut`, and `error`.
- AgentHost should report `missingAuth`, `authExpired`, `disabled`, or `modelUnavailable` without crashing.
- Raw API key access for actual LLM turns is deferred to Phase 4's harness bridge unless Phase 3 implementation discovers a clean existing Director-owned channel.

## 9. Model Resolver and Connection Test

Port the useful behavior from old `modelResolver.ts`:

- static built-in fallback catalog;
- optional remote catalog refresh;
- cache TTL;
- in-flight request de-duplication;
- provider-specific base URL normalization;
- model capability normalization;
- `onDidChangeModels` event.

Provider families for Phase 3:

- Anthropic;
- OpenAI;
- Gemini if old code ports cleanly;
- OpenAI-compatible;
- Anthropic-compatible.

API protocol adapters for Phase 3:

- `anthropic-messages`;
- `openai-completions` as the old Chat Completions-compatible path, or a clearer `openai-chat-completions` alias;
- `openai-codex` as the old Director OpenAI Codex OAuth path;
- `openai-responses` only as a reserved/hidden path unless public Responses API support is fully ported;
- `gemini-generative`.

Connection test behavior:

- test with the selected provider instance and resolved key;
- test OpenAI Codex OAuth with resolved bearer auth where available;
- never log raw keys;
- show missing-key, signed-out, expired-token, invalid-key, network, and unsupported-provider errors as user-facing messages;
- keep request timeout bounded;
- keep the backend hub alive even when tests fail.

## 10. Director Settings UI Requirements

The UI should provide the old practical workflow:

1. Open Director Settings.
2. Add a provider from a template.
3. Enter API key and optional base URL.
4. Or complete OAuth login for an OAuth-capable provider.
5. Test connection.
6. Refresh models.
7. Set default provider/model.
8. Enable/disable, sign out, or remove a provider.
9. Confirm the AgentHost Director provider model list reflects the provider snapshot after restart or refresh.

Implementation notes:

- Use localized strings for visible labels.
- Use `IEditorService` to open the settings editor.
- Use `IHoverService` for custom tooltips if needed.
- Keep disposables registered immediately.
- Avoid broad decorative UI changes. The goal is a functional provider manager, not a new landing page.
- Keep OAuth actions real for OpenAI Codex OAuth. Hide other OAuth provider templates whose implementation is not ported in Phase 3.

## 11. Backend Hub Behavior

`DirectorProviderBackendHub` should move from fake-only to layered behavior:

1. Load registry-backed providers when the secret-free snapshot is available.
2. Load model entries and auth-state metadata from the registry/model resolver snapshot.
3. Use fake providers only when explicitly in tests or when no configured provider exists and a dev fallback is still needed.
4. Convert provider models to `IAgentModelInfo` through the existing Phase 1 helper.
5. Resolve selection to one of:
   - `ok`;
   - `missingAuth`;
   - `authExpired`;
   - `disabledProvider`;
   - `unknownProvider`;
   - `unknownModel`;
   - `providerUnavailable`.

Do not make the Phase 3 AgentHost snapshot or default `resolveBackend()` path return raw API keys or OAuth tokens. If the current Phase 1 `DirectorResolvedProviderBackend.auth` shape remains in code for tests, keep it fixture-only or internal until Phase 4 designs the real secret bridge. Phase 3 should add or adapt a secret-free auth-state result for AgentHost model listing and availability checks.

## 12. Implementation Steps

### Step 3.0 - Baseline Review

- Re-check `git status --short --branch`.
- Confirm Phase 0-2 commit is present on `origin/codex/Director`.
- Re-open the old patch sections listed in this plan.
- Verify the current AgentHost process service graph again before wiring secrets.

### Step 3.1 - Port Shared Provider DTOs and Snapshot Schema

- Extract AgentHost-readable provider DTOs into `src/vs/platform/agentHost/common/`.
- Extract workbench provider service types into `workbench/contrib/directorCode/common/provider/`.
- Keep pure compatibility, protocol, and snapshot DTOs under `src/vs/platform/agentHost/common/`; do not import workbench from AgentHost common/node code.
- Split secret-free auth state from raw resolved auth. AgentHost Phase 3 code should consume auth state, not API keys or OAuth bearer tokens.
- Keep names close enough to old Director for easy comparison.
- Add conversion helpers into `directorProviderBackend.ts` only where AgentHost needs them.
- Add tests for normalization and model identifier parsing.

### Step 3.2 - Port Registry Service

- Port the old file-backed registry behavior.
- Persist under the current user profile, not workspace files.
- Add correlated file watching if AgentHost/workbench needs refresh events.
- Add tests for load, save, migration, defaults, disabled providers, and corrupt JSON recovery.

### Step 3.3 - Port API-Key and OAuth Services

- Port the Secret Storage backed key lifecycle.
- Port old Director OpenAI Codex OAuth login/logout/token lifecycle.
- Keep additional old OAuth flows hidden unless they fit the same boundary without extra harness work.
- Preserve secret key namespace if practical.
- Add tests with a fake secret storage implementation.
- Verify registry JSON never stores API-key values or OAuth tokens.

### Step 3.4 - Port Model Resolver, Provider Factory, Protocol Router, and Adapters

- Port model catalog fallback and provider metadata.
- Port protocol routing types that distinguish direct native pass-through, thin proxy pass-through, conversion, and unsupported states.
- Port pure normalized request/response/stream builders/parsers for Director `AgentEngine`, connection tests, and cross-protocol adapters.
- Put AgentHost runtime transports under `src/vs/platform/agentHost/node/director/providers/`.
- Put only UI/auth/registry/model-resolution/snapshot-writing orchestration under workbench.
- Keep Workbench connection tests on Workbench services (`IRequestService` plus resolved Secret Storage auth) and shared pure builders; do not import AgentHost node transports.
- Port native pass-through transports for matching protocol/provider pairs, including `openai-codex`.
- Port conversion adapters for Anthropic, OpenAI-compatible Chat Completions, and Gemini when the Director normalized harness protocol differs and tests can cover the conversion.
- Reserve public `openai-responses`; keep it hidden unless the distinct adapter/auth/model metadata lands in this phase.
- Add a compatibility matrix that controls whether a model is visible for a given agent/harness.
- Add model refresh with cache invalidation.
- Add bounded connection tests for API-key providers.
- Add bounded connection tests for OpenAI Codex OAuth where old Director already supports them.
- Keep real network tests manual or behind mocks; unit tests should use fake request services.

### Step 3.5 - Port Director Settings Editor

- Port `ProviderSettingsWidget` as the main UI.
- Port `DirectorCodeSettingsEditor` as `DirectorSettingsEditor` or keep the old class name if that reduces churn.
- Register `director-code.openSettings` or a renamed equivalent.
- Add menu entry in the Chat config menu and command palette first.
- Add Menubar Preferences entry if it stays narrow.

### Step 3.6 - Wire AgentHost Secret-Free Snapshot

- Add the Workbench snapshot writer service and make it update the profile-scoped snapshot when provider registry, auth state, model cache, or defaults change.
- Make `DirectorProviderBackendHub` read the profile-scoped, file-backed provider/model/auth-state snapshot instead of only fake fixtures.
- Keep tests using explicit fake fixtures.
- Ensure no configured provider results in a useful empty/setup state rather than a crash.
- Ensure API-key-only providers can appear in model list without leaking the key.
- Ensure OpenAI Codex OAuth providers can appear with ready/signed-out/expired state without leaking tokens.

### Step 3.7 - Update Docs and Memory

- Update this plan if implementation discovers a better boundary.
- Update `MEMORY.md` after Phase 3 implementation state changes.
- Update `AGENTS.md` when the next working phase changes.

## 13. Tests

Recommended tests:

- `src/vs/workbench/contrib/directorCode/test/common/provider/providerRegistry.test.ts`
- `src/vs/workbench/contrib/directorCode/test/common/provider/apiKeyService.test.ts`
- `src/vs/workbench/contrib/directorCode/test/common/provider/oauthService.test.ts`
- `src/vs/workbench/contrib/directorCode/test/common/provider/modelResolver.test.ts`
- `src/vs/workbench/contrib/directorCode/test/common/provider/providerConnectionTestService.test.ts`
- `src/vs/workbench/contrib/directorCode/test/common/provider/providerSnapshotService.test.ts`
- `src/vs/workbench/contrib/directorCode/test/browser/providerSettings/providerSettingsWidget.test.ts`
- `src/vs/platform/agentHost/test/common/directorProviderCompatibility.test.ts`
- `src/vs/platform/agentHost/test/common/directorProviderRequest.test.ts`
- `src/vs/platform/agentHost/test/common/directorProviderSnapshot.test.ts`
- `src/vs/platform/agentHost/test/node/directorProviderFactory.test.ts`
- `src/vs/platform/agentHost/test/node/directorProviderAdapters.test.ts`
- `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts`
- `src/vs/platform/agentHost/test/node/directorAgent.test.ts`

Minimum assertions:

- provider registry normalizes old/malformed state;
- API key save/read/delete does not mutate registry JSON;
- OpenAI Codex OAuth login/logout/refresh state does not mutate registry JSON with token values;
- provider snapshot writer emits only secret-free provider/model/auth-state metadata;
- AgentHost snapshot reader treats `ready`, `missing`, `expired`, `signedOut`, `disabled`, and unsupported states deterministically;
- key rotation invalidates auth/model cache where applicable;
- protocol routing selects direct native pass-through for matching harness/provider API types;
- Workbench connection tests use Workbench request/auth services plus shared pure request builders, not AgentHost node transports;
- provider adapters convert normalized Director messages to native provider requests and native streams back to normalized events only for cross-protocol routes;
- unsupported harness/provider combinations do not appear in that agent's model picker when that picker exists, and otherwise are covered by compatibility metadata tests;
- disabled provider is hidden or reported as disabled consistently;
- invalid/missing key appears as provider state, not thrown startup failure;
- model cache invalidation refreshes AgentHost-visible model list;
- Director Settings command opens the editor input;
- Copilot and Claude provider registration behavior is unchanged.

## 14. Manual Acceptance

Use a fresh user-data-dir profile.

Current implementation note for the first Phase 3 acceptance slice:

- `director-code.openSettings` is implemented as a QuickInput settings shell, not yet the full old `ProviderSettingsWidget` / `DirectorCodeSettingsEditor` editor pane.
- OpenAI Codex OAuth uses a deterministic fake Secret Storage token state for local acceptance; the real OAuth browser/device flow remains follow-up.
- Provider setup validation is no-network by design. It verifies stored auth state and builds a redacted request template, but does not send API-key traffic through VS Code's request service.
- AgentHost consumes a secret-free provider snapshot. API keys and OAuth token values should not appear in provider registry JSON or snapshot JSON.
- Current review fixes: model ids are split between AgentHost picker ids and provider wire ids, provider can be inferred from a selected global model id, global default model state takes priority over per-provider defaults, snapshot writes are serialized, and known sensitive auth headers are stripped before registry/snapshot/backend exposure.
- Current runtime fix: `DirectorAgent` periodically refreshes its model list from the snapshot so provider/model changes are not stuck behind a full AgentHost process restart.
- Director runtime still replies with deterministic echo until Phase 4 wires the real Director `AgentEngine`.

Acceptance flow:

1. Build current sources.
2. Launch Code OSS with `chat.agentHost.enabled=true` and `chat.agentHost.directorAgent.enabled=true`.
3. Run `Director: Open Settings` or `Open Director Settings`.
4. Add an OpenAI-compatible or Anthropic-compatible provider.
5. Enter a test key and base URL.
6. Save and test connection.
7. Add or select the OpenAI Codex OAuth provider and complete login, or run the deterministic fake OAuth acceptance target if real credentials are not available.
8. Refresh model list.
9. Select default provider/model.
10. Restart AgentHost or reload the window if the implementation requires it.
11. Confirm Director appears in Agent Sessions with configured models.
12. Send a message and confirm Phase 3 runtime behavior is either:
    - still deterministic echo, with model list now real/configured; or
    - clearly gated if Phase 4 work has not started.
13. Inspect registry JSON and the AgentHost snapshot and confirm no raw API key or OAuth token is present.
14. Change provider/model/default/auth state and confirm the Workbench snapshot writer refreshes the AgentHost-visible metadata after the documented reload/refresh path.
15. Disable the Director agent setting and confirm Director provider disappears.

Also verify:

- no Copilot login is required for Director Settings;
- no Copilot CAPI traffic is used by Director provider setup;
- invalid key errors are user-visible but do not crash AgentHost;
- signed-out or expired OAuth state is user-visible but does not crash AgentHost;
- future harness compatibility for Claude-like/OpenAI/Codex routes is covered by routing tests if those harness pickers do not exist yet;
- existing Copilot and Claude providers still behave as before.

## 15. Validation

For docs-only planning changes:

```powershell
git diff --check -- doc/director-agent-provider-phase3-plan.md doc/director-agent-provider-roadmap.md AGENTS.md MEMORY.md
```

For Phase 3 source changes:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --grep director
```

If browser/workbench tests are added, follow the local VS Code test pattern for those suites after `compile-check-ts-native` is clean.

## 16. Exit Criteria

Phase 3 is complete when:

- Director Settings opens from a visible command/menu entry.
- Provider Settings UI can create/edit/delete/enable/disable API-key providers.
- Provider Settings UI can create/login/logout the OpenAI Codex OAuth provider, or a deterministic fake target if real credentials are unavailable for local acceptance.
- API keys and OAuth tokens are stored in Secret Storage, not registry JSON.
- Provider registry persists non-secret state under the user profile.
- Workbench owns and refreshes the profile-scoped, secret-free provider/model/auth-state snapshot consumed by AgentHost.
- Model refresh and connection test work for at least one API-key compatible provider family.
- Model refresh and connection test work for OpenAI Codex OAuth or a deterministic fake OAuth acceptance target.
- Protocol routing uses direct native pass-through for matching harness/provider API types.
- Provider adapters convert normalized Director messages/streams to native provider protocol shapes only for cross-protocol routes.
- Workbench connection tests do not import AgentHost node transports; they use Workbench request/auth services and shared pure request builders.
- Unsupported harness/provider/model combinations are hidden from the relevant agent model picker when the picker exists, or covered by compatibility metadata tests for future harnesses.
- Public `openai-responses` stays hidden/reserved unless it is implemented separately from `openai-codex`.
- `DirectorProviderBackendHub` can expose configured provider/model metadata to `DirectorAgent`.
- Missing/invalid auth is surfaced as state, not startup failure.
- Tests cover registry, secret handling, OAuth state, protocol routing, provider adapters, model resolver/cache, and backend hub behavior.
- No Director-owned provider code depends on Copilot CAPI or GitHub Copilot login.

## 17. Open Questions

- Should the first manual acceptance target use a local OpenAI-compatible endpoint to avoid external network/API-key dependency?
- After OpenAI Codex OAuth is stable, which second OAuth provider should move from Phase 8 into the dogfood queue?
