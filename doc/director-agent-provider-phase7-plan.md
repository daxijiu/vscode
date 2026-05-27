# Director Agent Provider Phase 7 Plan

Updated: 2026-05-27

## Status

Completed locally on 2026-05-27.

Phase 7 follows Phase 4's accepted AgentHost Director runtime. The goal is to polish the provider/model surfaces around it and to stop provider-runtime drift from the old Director implementation. Configured Director providers should show up predictably in model pickers, and the runtime semantics should be reusable by later non-Copilot harnesses.

Accepted Phase 7 slice:

- AgentHost Director model projection carries provider display name, API type, family/version, token limits, capabilities, and missing-auth status without secrets.
- AgentHost node provider runtime now owns HTTP/SSE request execution and response parsing under `src/vs/platform/agentHost/node/director/providers/**`; `DirectorAgentEngineAdapter` consumes that runtime instead of maintaining a second parser.
- OpenAI-compatible, Anthropic Messages, Gemini, and OpenAI Codex response parsing stay behind the shared runtime boundary, with DeepSeek/OpenAI-compatible `reasoning_content` fallback preserved.
- Workbench registers a `director-code` `LanguageModelChatProvider` descriptor and projects Director-managed models from the Workbench registry/model resolver into the broader model picker without Copilot CAPI or GitHub Copilot auth.
- Direct `director-code` requests route through AgentHost Director sessions so provider HTTP remains node-owned; Workbench does not import AgentHost node transports or run provider HTTP itself.
- Provider Settings model metadata and Refresh Models behavior from Phase 3 remain intact.

## Goal

Polish Director Provider Settings and model projection after Phase 3/4 restored the practical settings editor and provider-backed AgentEngine turns.

## Provider Porting Standard

The old Director provider implementation is the default semantic reference for provider/model behavior:

Reference tree:

`E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\reference-director-120\layers\director\vscode`

Primary source files:

- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerFactory.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerTypes.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/abstractProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/openaiProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/anthropicProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/geminiProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/openaiCodexProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/requestFetch.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/modelResolver.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/directorCodeModelProvider.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providerGroupProjection.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providerRegistry.ts`

Current fork code should reuse those semantics unless they conflict with the current architecture:

- Workbench owns Provider Settings, registry, Secret Storage, auth state, model refresh orchestration, and secret-free snapshots.
- AgentHost/platform owns runtime/provider adapters.
- Workbench must not import AgentHost node transports.
- Director-owned providers must not use Copilot CAPI, `ICopilotApiService`, GitHub Copilot auth, or `GITHUB_COPILOT_PROTECTED_RESOURCE`.
- Snapshot, registry, model metadata, and logs must stay secret-free.

When old provider semantics need adaptation, document the reason in this plan instead of inventing a new behavior silently.

## Phase 7.1 - AgentHost Model Picker Projection

Goal: make the existing AgentHost Director model picker reflect Director provider metadata instead of showing a thin model-id projection.

Scope:

- Carry provider display name, provider API type, model family/version, input/output token limits, and capabilities through the provider snapshot and AgentHost model info.
- Show configured Director models from enabled providers in the AgentHost Director picker even when credentials are missing, but mark them unconfigured so send-time failure remains understandable and recoverable.
- Keep disabled providers/models hidden from the AgentHost picker.
- Add a Director management command on the model-provider descriptor so the Models management surface can route users back to Director Settings.
- Preserve global model ids (`provider:model`) separately from provider wire ids.

Acceptance:

- A configured Director provider's visible models appear under the Director AgentHost model picker after refresh/restart.
- Provider label/detail and capabilities are visible in the model metadata used by the picker.
- Missing credentials do not crash model discovery; selection/send still fails with the Phase 4 credential error.
- Disabled providers stay hidden.
- No API key or OAuth token appears in registry, snapshot, model metadata, or logs.

## Phase 7.2 - Provider Runtime Reuse Boundary

Goal: extract the old Director provider runtime semantics behind an AgentHost-owned boundary before broadening direct model-provider surfaces.

Scope:

- Port old `providerTypes.ts`, `providerFactory.ts`, `abstractProvider.ts`, `requestFetch.ts`, and provider-specific request/stream semantics into current `src/vs/platform/agentHost/**` boundaries.
- Put provider-neutral DTOs and normalized stream/event types under `src/vs/platform/agentHost/common/**`.
- Put node-only HTTP/SSE/provider adapters under `src/vs/platform/agentHost/node/director/providers/**`.
- Refactor the Phase 4 `DirectorAgentEngineAdapter` to call the shared provider runtime instead of maintaining a second hand-written request/SSE implementation.
- Preserve existing Workbench-owned registry, Secret Storage, OAuth state, model refresh orchestration, and secret-free snapshot writing.
- Keep DeepSeek/OpenAI-compatible reasoning fallback, OpenAI tool-call streaming deltas, Anthropic content/tool/thinking conversion, Gemini function calling/schema sanitization, and OpenAI Codex Responses conversion aligned with the old implementation.

Acceptance:

- Existing Phase 4 provider-backed turns still pass after moving through the shared provider runtime.
- DeepSeek reasoning content, provider-native tool calls, usage accounting, request headers, and error redaction match old Director semantics unless this plan documents an AgentHost-specific difference.
- Credentials are still requested only through the narrow runtime credential bridge and are never persisted into registry/snapshot/model metadata/logs.

Migration order:

1. Extract old provider-neutral types and normalized content/event shapes into `src/vs/platform/agentHost/common/**`.
2. Port `AbstractDirectorCodeProvider`, `providerFactory`, and OpenAI-compatible runtime into `src/vs/platform/agentHost/node/director/providers/**`.
3. Move `DirectorAgentEngineAdapter` from its hand-written OpenAI request/SSE parser to the shared provider runtime while preserving Phase 4 tests.
4. Port Anthropic, Gemini, and OpenAI Codex provider runtimes behind the same factory.
5. Reconcile `DirectorModelResolverService` with old `modelResolver.ts` cache/in-flight/provider API/CDN/static fallback semantics while keeping snapshots secret-free.

## Phase 7.3 - Director LanguageModelChatProvider Projection

Goal: expose Director-managed providers through VS Code's `LanguageModelChatProvider` surface without Copilot.

Scope:

- Port the old `directorCodeModelProvider.ts` and `providerGroupProjection.ts` semantics into the current fork.
- Return cached secret-free provider/model metadata during silent discovery.
- Resolve API-key/OAuth credentials only when a real `sendChatRequest` happens.
- Use the shared Director provider runtime from Phase 7.2, not a Workbench-side duplicate request implementation.
- Keep Director Settings as the provider management command.

Accepted adaptation:

- The direct `director-code` provider uses AgentHost Director sessions as the narrow request bridge for this phase. That preserves the node-owned provider runtime and turn-time credential bridge while avoiding a new Workbench-side HTTP stack.
- Old `providerGroupProjection.ts` remains the semantic reference, but the current VS Code descriptor type only accepts the existing management descriptor shape here. Provider grouping can be expanded later if the model-provider descriptor schema grows a compatible configuration surface.

Acceptance:

- Director-managed models can appear in the broader VS Code model picker/model management surfaces without requiring Copilot login.
- Direct language model requests use Director credentials only at request time.
- The direct provider path shares the same provider request/stream semantics as AgentHost Director turns.

## Phase 7.4 - Provider Settings Polish

Goal: make Provider Settings a reliable management surface for provider and model state.

Scope:

- Improve model metadata display for family, token limits, visibility, auth state, and capabilities.
- Keep Refresh Models credential-gated and secret-redacted.
- Preserve scroll/modal stability from Phase 3.
- Keep hidden models persisted in registry but filtered out of snapshots/model pickers.

Acceptance:

- Users can add an API-key provider, refresh models, hide/show models, set a default, and see the same results in Director model pickers after restart.
- Refresh errors are understandable and redacted.

## Deferred

- Additional OAuth providers and real OpenAI Codex browser/device flow remain Phase 8.
- Claude-like SDK de-CAPI remains Phase 6.
- Durable session restore remains Phase 9.
- Public OpenAI Responses support separate from OpenAI Codex remains later provider-runtime work.

## Validation

Required for TypeScript changes:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts
npm run test-node -- --run src/vs/workbench/contrib/directorCode/test/common/provider/directorProviderServices.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/sessions/contrib/providers/agentHost/test/browser/agentHostModelPicker.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/chat/test/browser/agentSessions/agentHostChatContribution.test.ts -- --grep "language model provider"
git diff --check
```
