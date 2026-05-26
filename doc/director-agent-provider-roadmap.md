# Director Agent and Provider Backend Roadmap

更新时间：2026-05-22

## North Star

在 VS Code AgentHost / Agent Sessions 体系下，把 Director 从旧的“替换内置 Copilot Chat Agent”的形态，改造成一个或多个可选 agent harness。Director agent、Claude-like SDK agent、以及后续其他开源 agent / CLI / SDK agent 都应复用同一个 Director-owned Provider Backend Hub，而不是继续走 GitHub Copilot CAPI。

目标形态：

- Copilot / Copilot CLI / Copilot CAPI 保留原样，仍由 Copilot 自己的 token、账号、entitlement 和 CAPI path 管理。
- Director / Claude-like / open-source agent 作为并列 `IAgent` provider 注册进 AgentHost，可在 Agent Sessions UI 中被选择。
- 非 Copilot agent 不直接管理 API key、OAuth token、base URL 或模型列表；这些都由 Director Provider Backend Hub 解析和提供。
- 新增 agent harness 时只写 harness adapter。
- 新增模型服务商时只写 provider backend。

## Architecture Target

```text
┌──────────────────────────────────────────┐
│ VS Code Agent Sessions / AgentHost UI    │
│ session list • model picker • tools      │
│ permissions • subagents • restore        │
└─────────────────────┬────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────┐
│ AgentHost IAgent Provider                │
│ director • claude-sdk • opencode • ...   │
└─────────────────────┬────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────┐
│ Harness Adapter Layer                    │
│ AgentEngine adapter                      │
│ Claude SDK adapter                       │
│ CLI / SDK / local runtime adapters       │
└─────────────────────┬────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────┐
│ Director Provider Backend Hub            │
│ registry • auth • models • transport     │
│ capabilities • connection test           │
└─────────────────────┬────────────────────┘
                      │
        ┌─────────────┼──────────────────┐
        ▼             ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ API Key      │ │ OAuth        │ │ Local / SDK  │
│ Providers    │ │ Providers    │ │ Providers    │
└──────────────┘ └──────────────┘ └──────────────┘
```

The key split is:

```text
AgentHost = agent runtime / session shell
Provider Backend Hub = user LLM accounts / credentials / models / protocol source of truth
```

## Current Evidence

### Current VS Code Fork

The current checkout already has the AgentHost surface needed for optional agents:

- `src/vs/platform/agentHost/common/agentService.ts`
  - Defines `IAgent`, `AgentProvider`, `IAgentModelInfo`, `ProtectedResourceMetadata`, session lifecycle, tool callbacks, customization callbacks, and auth entrypoints.
- `src/vs/platform/agentHost/node/agentHostMain.ts`
  - Registers `CopilotAgent` and conditionally registers `ClaudeAgent` when the Claude SDK path env var is present.
- `src/vs/platform/agentHost/node/claude/**`
  - Implements a mature Claude SDK harness: session lifecycle, streaming mapper, tool calls, client tools, file edit tracking, subagents, and transcript restore.

But the current Claude implementation is still Copilot-backed:

```text
Claude Agent SDK
  -> IClaudeProxyService
  -> ICopilotApiService
  -> GitHub Copilot CAPI
```

The binding points are:

- `ClaudeAgent.getProtectedResources()` returns `GITHUB_COPILOT_PROTECTED_RESOURCE`.
- `ClaudeAgent.authenticate()` accepts a GitHub token and starts `IClaudeProxyService`.
- `ClaudeAgent._refreshModels()` calls `ICopilotApiService.models()`.
- `ClaudeProxyService` accepts Anthropic Messages traffic but forwards outbound requests to `ICopilotApiService`.

### Old Director Implementation

The old Director generated tree has the opposite shape: the provider/backend side is already rich, but the agent side is still old Chat Agent oriented.

Reusable provider/backend concepts:

- `src/vs/workbench/contrib/directorCode/common/agentEngine/providerRegistry.ts`
  - Provider instances, default provider/model, base URL, headers, model visibility, auth kind.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/authStateService.ts`
  - Resolves API key, OAuth, env var, provider instance key, and model-specific key.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/apiKeyService.ts`
  - Secret Storage backed API-key management.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/oauthService.ts`
  - Anthropic / OpenAI OAuth flows and token storage.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerTypes.ts`
  - Normalized provider request, response, stream, capabilities, and auth types.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerFactory.ts`
  - Anthropic, OpenAI-compatible, OpenAI Codex, Gemini provider construction.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/modelResolver.ts`
  - Model discovery and fallback.

Old Director agent entrypoints:

- `src/vs/workbench/contrib/directorCode/browser/agentEngine/directorCodeAgent.ts`
  - Implements `IChatAgentImplementation`, resolves provider/model/auth, then runs `AgentEngine`.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/agentEngine.ts`
  - Director agent loop, provider calls, tools, compact, retry.
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/toolBridge.ts`
  - VS Code tool bridge.
- `src/vs/workbench/contrib/directorCode/common/agentEngine/directorPlanMode.ts`
  - Plan Mode state and `director_present_plan`.

This means the migration should not copy the old generated tree directly. It should extract its provider/backend semantics into the current fork and make old Director runtime a harness adapter.

## Design Principles

1. **Agent harness and provider backend are separate products.**
   A Claude SDK harness, Director `AgentEngine`, or future CLI agent should consume a resolved backend. It should not know where the key was stored or how OAuth refreshed.

2. **Copilot remains isolated.**
   Do not rewrite Copilot auth, CAPI, CLI, entitlement, or token manager. `ICopilotApiService` remains Copilot-only.

3. **Do not turn `ClaudeProxyService` into the universal backend.**
   Its local HTTP shape is useful, but the current implementation is CAPI-bound. The reusable concept is "Anthropic-compatible local endpoint backed by a provider transport", not the existing service as-is.

4. **API keys are not protected resources.**
   `ProtectedResourceMetadata` is an OAuth/auth-provider surface. API keys belong in Secret Storage and should be resolved by the backend hub.

5. **Each OAuth provider needs its own resource identity.**
   Do not share `GITHUB_COPILOT_PROTECTED_RESOURCE` across custom providers. Token fan-out through a shared resource would make auth side effects hard to reason about.

6. **Session kind is fixed.**
   A session may switch model only when the harness/runtime supports it safely. It should not switch from Director to Claude-like runtime in-place. Use new session or fork/handoff semantics.

7. **Keep workbench changes narrow.**
   Reuse Agent Sessions UI, session config schema, model picker, tool approval, and progress rendering. Avoid broad edits across `src/vs/sessions/**` or `src/vs/workbench/contrib/chat/**`.

## Proposed Interfaces

These are directional contracts, not final TypeScript signatures.

```ts
interface ProviderBackendHub {
	listProviders(): Promise<ProviderInstance[]>;
	listModels(providerInstanceId?: string): Promise<ProviderModel[]>;
	resolveBackend(selection: ProviderSelection): Promise<ResolvedProviderBackend>;
	createTransport(resolved: ResolvedProviderBackend): Promise<ProviderTransport>;
	testConnection(selection: ProviderSelection): Promise<ProviderConnectionResult>;
}
```

```ts
interface ResolvedProviderBackend {
	readonly providerInstanceId: string;
	readonly apiType: 'anthropic-messages' | 'openai-completions' | 'openai-codex' | 'gemini-generative' | 'local' | 'custom-http';
	readonly modelId: string;
	readonly auth: ProviderAuth | { readonly kind: 'none' };
	readonly baseURL?: string;
	readonly headers?: Record<string, string>;
	readonly capabilities?: ProviderCapabilities;
	readonly identityKey?: string;
}
```

```ts
interface HarnessAdapter {
	readonly id: string;
	readonly displayName: string;

	createSession(config: HarnessSessionConfig): Promise<HarnessSession>;
	sendMessage(session: HarnessSession, message: HarnessMessage): Promise<void>;
	abort(session: HarnessSession): Promise<void>;
	changeModel?(session: HarnessSession, backend: ResolvedProviderBackend): Promise<void>;
	restore(session: HarnessSession): Promise<readonly Turn[]>;
	dispose(session: HarnessSession): Promise<void>;
}
```

The AgentHost-facing `IAgent` provider should remain the outer shell. Harness adapters are an internal Director-owned abstraction beneath it.

## Phases

Phase numbers are stable planning identifiers. Like the Claude AgentHost roadmap, each phase should end at a verifiable boundary and may later get its own `phaseN-plan.md`.

### Phase 0 - Baseline and Ownership

Goal: freeze the current state and prevent this work from becoming another broad replay-style fork.

Full step-by-step plan: [director-agent-provider-phase0-plan.md](./director-agent-provider-phase0-plan.md).

Scope:

- Document exact current AgentHost boundaries.
- Confirm current branch, dirty state, and current Claude AgentHost status.
- Decide final file ownership for new code.
- Decide feature gates / settings names.

Expected outputs:

- This roadmap.
- A short implementation inventory before code starts.
- Decision: new code should land under narrow AgentHost/provider directories, not as a broad rewrite of `src/vs/sessions/**`.

Exit criteria:

- Agreement on the first implementation slice.
- No generated-tree-only source of truth.

### Phase 1 - Provider Backend Contracts

Goal: add provider/backend contracts without wiring real user secrets or real LLM traffic.

Full step-by-step plan: [director-agent-provider-phase1-plan.md](./director-agent-provider-phase1-plan.md).

Scope:

- Add shared provider backend types.
- Add provider model and capability types independent of `CCAModel`.
- Add resolved backend shape.
- Add error/status states for missing auth, disabled provider, model unavailable.
- Add test-only fake provider backend.

Candidate files:

- `src/vs/platform/agentHost/common/directorProviderBackend.ts`
- `src/vs/platform/agentHost/node/director/providerBackendHub.ts`
- `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts`

Out of scope:

- Secret Storage.
- OAuth.
- Real OpenAI / Anthropic calls.
- Provider settings UI.

Exit criteria:

- Unit tests prove provider registration, model listing, auth-missing, and capability filtering.
- No dependency on `ICopilotApiService`.

### Phase 2 - Minimal Non-Copilot `IAgent`

Goal: prove Agent Sessions can host a Director-owned, non-Copilot agent provider.

Full step-by-step plan: [director-agent-provider-phase2-plan.md](./director-agent-provider-phase2-plan.md).

Scope:

- Add an opt-in `DirectorAgent` or `CustomAgent` implementing `IAgent`.
- Register it beside `CopilotAgent`, behind a setting/env gate.
- Expose fake/static models from the provider backend test implementation.
- Create/list/dispose sessions.
- Stream a deterministic echo/fake assistant response through AgentHost state.
- Support abort as a real no-op/cancel path.

Candidate files:

- `src/vs/platform/agentHost/node/director/directorAgent.ts`
- `src/vs/platform/agentHost/node/director/directorAgentSession.ts`
- `src/vs/platform/agentHost/node/agentHostMain.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- `src/vs/platform/agentHost/test/node/directorAgent.test.ts`

Out of scope:

- Real LLM calls.
- Old Director `AgentEngine`.
- Claude SDK subprocess.
- Provider settings UI.

Exit criteria:

- With the gate enabled, Agent Sessions sees the new provider.
- A session can be created and receives streamed output.
- Copilot and existing Claude registration behavior are unchanged.

### Phase 3 - Provider Registry and API-Key Backend

Status: completed and manually accepted on 2026-05-26.

Goal: port the useful old Director provider registry/auth semantics into the current fork.

Full step-by-step plan: [director-agent-provider-phase3-plan.md](./director-agent-provider-phase3-plan.md).

Scope:

- Add provider instance registry.
- Add API-key provider auth model.
- Add OpenAI Codex OAuth auth model from old Director as the Phase 3 minimum OAuth path.
- Add Secret Storage bridge.
- Add OpenAI-compatible and Anthropic-compatible provider metadata.
- Add model list refresh and connection test.
- Add provider capability normalization.
- Add provider protocol routing so matching harness/provider API types can pass through natively, with conversion adapters only for cross-protocol routes.
- Keep AgentHost runtime provider transports under `src/vs/platform/agentHost/node/director/providers/**`; Workbench owns settings, registry, auth, secrets, and UI orchestration.
- Add a Workbench-owned, profile-scoped, secret-free provider/model/auth-state snapshot writer for AgentHost consumption.
- Keep Workbench connection tests on Workbench request/auth services and shared pure request builders; do not import AgentHost node transports into Workbench.
- Add compatibility-based model visibility so unproven harness/provider combinations stay out of the picker.
- Keep public `openai-responses` reserved/hidden until implemented separately from old Director `openai-codex`.
- Restore a practical Director Settings entry based on the old provider settings editor.
- Reuse the old `ProviderSettingsWidget` as the main provider manager surface.

Source concepts to reuse:

- Old `providerRegistry.ts`
- Old `apiKeyService.ts`
- Old `authStateService.ts`
- Old `oauthService.ts`
- Old `modelResolver.ts`
- Old `providerTypes.ts`
- Old `providerFactory.ts`
- Old provider adapter files under `providers/`
- Old `providerSettingsWidget.ts`
- Old `directorCodeSettingsEditor.ts`
- Old `settingsWriteQueue.ts`

Out of scope:

- Real Director `AgentEngine` turns.
- Claude SDK de-CAPI migration.

Exit criteria:

- Director Settings opens from a visible command/menu entry.
- A configured API-key provider can list or define models.
- A configured OpenAI Codex OAuth provider can authenticate, sign out, and expose non-secret ready/signed-out state, or a deterministic fake OAuth target covers local acceptance.
- Missing/invalid key is surfaced as provider state, not as an AgentHost crash.
- Provider registry state does not store secrets in ordinary JSON.
- Workbench writes a secret-free provider/model/auth-state snapshot, and AgentHost reads only that snapshot for Phase 3 model availability.
- Provider protocol routing uses direct native pass-through for matching API types and conversion adapters only for cross-protocol routes.
- Unsupported harness/provider/model combinations are hidden from the relevant agent model picker when it exists, or covered by compatibility metadata tests for future harnesses.
- Public `openai-responses` remains hidden unless its adapter/auth/model path is implemented separately from `openai-codex`.
- AgentHost can see configured non-secret provider/model metadata.
- Tests cover key rotation and model cache invalidation.

### Phase 4 - Provider-Backed Director Agent Harness

Status: completed locally on 2026-05-26. See `doc/director-agent-provider-phase4-plan.md`.

Goal: move the old Director `AgentEngine` from old Chat Agent shape into an AgentHost harness adapter.

Completed subphases:

1. Phase 4.1 Provider Streaming for OpenAI-compatible Chat Completions and Anthropic Messages, with non-streaming fallback for Gemini and OpenAI Codex Responses-shape.
2. Phase 4.2 AgentHost client-tool calls with provider-native tool schema/result conversion, per-turn tool snapshots, advertised-tool gating, rejected/failed/disconnected handling, and bounded tool loops.
3. Phase 4.3 Plan Mode recognition through AgentHost session config, gated with a clear visible message until old `director_present_plan` has a matching AgentHost command/action contract.
4. Phase 4.4 AgentEngine loop parity for multi-turn history normalization, in-memory long-context trimming, retry/error classification, and no retry after side-effecting tool execution.

Scope:

- Wrap old `AgentEngine` semantics as an AgentHost-owned harness adapter.
- Feed it `ResolvedProviderBackend` instead of letting it read settings/API keys directly.
- Map Director stream events to AgentHost `AgentSignal` / session protocol state.
- Preserve AgentHost reducer invariants: `SessionResponsePart` must precede `SessionDelta` / `SessionReasoning` for the same part id, and final transcripts must not double-emit streamed content.
- Keep non-streaming fallbacks for provider protocols whose streaming parser is not implemented in the current subphase.
- Reuse AgentHost tool approval and client tool surfaces where possible.
- Normalize tool definitions/results before converting to provider-native schemas, and gate unsupported provider/model tool combinations.
- Bound tool-call loops with a small iteration guard and exactly one terminal action per turn.
- Do not retry provider calls across side-effecting tool execution unless explicit idempotency/turn-step tracking exists.
- Preserve Plan Mode semantics as Director session state.
- Define the AgentHost Plan Mode trigger surface before wiring old `director_present_plan` semantics.
- Materialize the old Director AgentEngine patch layer into a reference-only tree before deeper tool/Plan Mode/loop-parity work, but keep the current fork's AgentHost-shaped code as the source of truth.
- Add a narrow runtime credential bridge that resolves Secret Storage credentials only for the active provider-backed turn and does not write secrets into snapshots or logs.

Source concepts to reuse:

- Old `agentEngine.ts`
- Old `directorCodeAgent.ts`
- Old `progressBridge.ts`
- Old `messageNormalization.ts`
- Old `toolBridge.ts`
- Old `directorPlanMode.ts`

Out of scope:

- Replacing the entire Chat UI.
- Setting Director as default global Chat Agent via product.json.
- Recreating old Copilot commercial-flow bypasses.

Exit criteria:

- A Director AgentHost session can run a real provider-backed turn.
- A Director AgentHost session can stream provider-backed content and abort cleanly.
- Tool calls surface through AgentHost permission/tool UI with provider-native schema conversion, bounded iteration, and clean rejected/failed/disconnected paths.
- Plan Mode is explicitly gated off with a clear AgentHost-visible message.
- Multi-turn history, in-memory long-context trimming, retry/error classification, side-effect-safe retry behavior, and provider response normalization have focused tests.

### Phase 5 - Provider-Backed Anthropic Endpoint Proxy

Goal: create the reusable local endpoint needed by Claude-like SDKs without Copilot CAPI.

Scope:

- Introduce an Anthropic-compatible local endpoint service backed by Provider Backend Hub.
- Keep the useful proxy mechanics from `ClaudeProxyService`:
  - bind to `127.0.0.1`;
  - use nonce/session bearer auth;
  - expose `/v1/messages`;
  - optionally expose `/v1/models` and `/v1/messages/count_tokens`;
  - abort upstream on client disconnect.
- Replace outbound `ICopilotApiService` calls with provider transport calls.
- Make model resolution use provider backend models, not `CCAModel`.

Out of scope:

- Deleting the existing Copilot-backed `ClaudeProxyService`.
- Rewriting Claude SDK event mapping.

Exit criteria:

- A local SDK-compatible endpoint can stream from an Anthropic-compatible or OpenAI-compatible backend.
- No GitHub token is required.
- Tests prove `ICopilotApiService` is not touched.

### Phase 6 - Claude-Like SDK Harness De-CAPI

Goal: make the Claude SDK harness consume the Director backend hub instead of GitHub Copilot CAPI.

Scope:

- Keep current Claude session lifecycle, SDK subprocess, event mapper, tool calls, subagents, and transcript restore where possible.
- Replace:
  - `GITHUB_COPILOT_PROTECTED_RESOURCE`;
  - `_copilotApiService.models()`;
  - `IClaudeProxyService.start(githubToken)`;
  - CAPI model filtering.
- Feed SDK env from a resolved backend:
  - `ANTHROPIC_BASE_URL`;
  - `ANTHROPIC_AUTH_TOKEN`;
  - model id;
  - provider capabilities.
- Decide whether this is a new provider id, such as `director-claude`, or a backend mode of `DirectorAgent`.
- Ensure a Director-backed Claude-like provider is not hidden merely because the user is logged out of GitHub Copilot.

Out of scope:

- Removing the existing Copilot-backed Claude provider immediately.
- OAuth provider implementation.

Exit criteria:

- Claude-like SDK can create a session and send messages using a Director provider backend.
- Existing Copilot-backed Claude path remains available or explicitly gated as legacy/experimental.
- Copilot logout does not suppress the Director-backed Claude-like provider when a Director backend is configured.

### Phase 7 - Provider Settings Polish and Model Picker

Goal: polish provider/backend configuration and integrate it more deeply with Agent Sessions model/session selection, after Phase 3 has restored the practical Director Settings entry.

Scope:

- Polish the Provider Manager UI restored in Phase 3.
- Project provider models into AgentHost model picker.
- Add session config schema for provider/model/harness selection if needed.
- Preserve secret isolation: UI writes secrets to Secret Storage, registry stores references and metadata only.

Source concepts to reuse:

- Old `providerSettingsWidget.ts`
- Old `directorCodeSettingsEditor.ts`
- Old `directorCodeModelProvider.ts`
- Old `providerGroupProjection.ts`

Out of scope:

- Additional OAuth provider login UI beyond Phase 3 parity.
- Re-porting the basic provider settings entry already completed in Phase 3.

Exit criteria:

- User can configure an API-key provider and select its model for a Director/Claude-like agent session.
- Restart preserves provider registry and model visibility.

### Phase 8 - OAuth Hardening and Additional Provider Support

Goal: harden the OpenAI Codex OAuth support introduced in Phase 3 and add more non-Copilot OAuth providers without reusing GitHub Copilot resource identity.

Scope:

- Add OAuth providers beyond the Phase 3 OpenAI Codex path.
- Harden token refresh, expiry, and re-auth UX.
- Implement or bridge VS Code `AuthenticationProvider` where appropriate if Phase 3 used a narrower internal service.
- Add provider-specific `ProtectedResourceMetadata`.
- Add login/logout/refresh state.
- Resolve OAuth tokens into `ProviderAuth`.
- Support token expiry and re-auth flows.

Out of scope:

- Using `GITHUB_COPILOT_PROTECTED_RESOURCE` for non-Copilot providers.
- Moving OpenAI Codex OAuth support back out of Phase 3.

Exit criteria:

- Additional OAuth providers can authenticate and produce a resolved backend.
- Token refresh does not leak into agent harness code.

### Phase 9 - Session Restore, Migration, and Compatibility

Goal: make the new optional-agent architecture durable across restarts and compatible with old Director user data where reasonable.

Scope:

- Persist provider-backed agent sessions.
- Restore turns from harness-specific logs or normalized transcripts.
- Persist session provider/model selection.
- Persist current Director session message history beyond the AgentHost process lifetime.
- Handle missing provider/model on restore.
- Optionally migrate old provider registry state if the storage location changes.
- Decide how old Chat Agent sessions and new AgentHost sessions coexist.

Out of scope:

- In-place cross-harness session conversion.
- Full old chat history migration unless explicitly required.

Exit criteria:

- AgentHost restart is invisible for new Director sessions.
- Director conversation history is available after closing and reopening the workbench.
- Missing backend produces recoverable UI state.
- Session kind remains stable.

### Phase 10 - Hardening, Telemetry, and Dogfood

Goal: move from working slices to usable preview.

Scope:

- Telemetry for provider resolution, model calls, auth failures, token refresh, transport errors, SDK/runtime crashes.
- Stress tests:
  - long-running turns;
  - abort storms;
  - large outputs;
  - key rotation;
  - provider unavailable;
  - model removed.
- Leak checks for local proxies and subprocesses.
- Manual dogfood checklist.

Exit criteria:

- Ready for external preview behind a feature gate.
- Copilot paths have regression coverage or manual smoke notes.

### Phase 11 - SDK / Runtime Distribution

Goal: avoid requiring users to manually install SDKs or configure local paths.

Scope:

- Follow the Claude AgentHost Phase 15 direction:
  - SDKs can be delivered by marketplace extensions or a trusted runtime package.
  - AgentHost discovers installed runtime providers.
  - Dev env path override remains for local development.
- Generalize beyond Claude:
  - Claude SDK package;
  - future OpenCode / Codex / custom CLI runtime;
  - local binary adapters.

Exit criteria:

- Fresh install can enable a supported non-Copilot agent without manual SDK path setup.

## Recommended Execution Order

```text
0 -> 1 -> 2 -> 3 -> 4 -> 7 -> 5 -> 6 -> 8 -> 9 -> 10 -> 11
```

Why this order:

- Phase 2 proves AgentHost UI/session integration before real backend complexity.
- Phase 3 builds the source of truth for user providers.
- Phase 4 brings Director agent value online before doing deeper Claude SDK backend surgery.
- Phase 7 gives users a way to configure providers.
- Phase 5 and Phase 6 then de-CAPI the Claude-like SDK path cleanly.
- OAuth waits until API-key backend and UI semantics are stable.

## Main File Boundaries

Preferred new-code areas:

- `src/vs/platform/agentHost/common/director*.ts`
- `src/vs/platform/agentHost/node/director/**`
- `src/vs/platform/agentHost/node/directorProvider/**`
- `src/vs/platform/agentHost/test/node/director*.test.ts`
- narrow registration edits in:
  - `src/vs/platform/agentHost/node/agentHostMain.ts`
  - `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- narrow UI/settings edits in:
  - `src/vs/sessions/contrib/providers/agentHost/**`
  - `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/**`

Avoid broad ownership:

- Do not claim all of `src/vs/platform/agentHost/**`.
- Do not claim all of `src/vs/sessions/**`.
- Do not modify `extensions/copilot/**` unless a specific compatibility check requires it.
- Do not use old `Director-Code-112-check/vscode.generated/**` as a durable source root.

## Validation

Baseline commands:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
```

AgentHost-focused tests:

```powershell
npm run test-node -- --grep agentHost
```

If Copilot extension files are touched:

```powershell
npm --prefix extensions/copilot run typecheck
```

Manual smoke goals:

- New non-Copilot agent appears only when its gate is enabled.
- Copilot sessions still work unchanged.
- Provider missing-auth state is recoverable.
- A provider-backed Director session can stream content.
- Abort does not leave local proxy or subprocess handles behind.
- Restart restores provider-backed sessions.

## Open Questions

- Should the first real provider-backed agent id be `director`, `custom`, or `director-agent`?
- Should Claude de-CAPI be a new provider id, such as `director-claude`, or a backend mode under `DirectorAgent`?
- Where exactly should Secret Storage bridge live between workbench and AgentHost?
- Should provider registry live under AgentHost user data, workbench user profile data, or a Director-specific profile file?
- How much of old Provider Manager UI should be ported versus rebuilt around current Agent Sessions settings patterns?
- Should old Director Chat Agent remain temporarily for side-by-side comparison?
- What is the minimum Plan Mode subset for the first AgentHost Director harness?
- How should local/no-auth providers be represented without pretending they are OAuth resources?

## Non-Goals

- Replacing Copilot CAPI for Copilot-owned agents.
- Reusing GitHub Copilot tokens for non-Copilot providers.
- Treating markdown-defined custom agents as runtime harnesses.
- Making `ClaudeProxyService` the universal provider backend.
- Storing API keys or OAuth tokens in ordinary JSON config.
- Recreating the old product-level `defaultChatAgent` replacement as the first step.
- Full old chat history migration in the first implementation wave.

## First Implementation Slice

The recommended first slice is:

```text
Phase 1 + Phase 2
```

Deliverable:

- A minimal provider backend contract.
- A fake/static backend.
- An opt-in non-Copilot `DirectorAgent` visible in Agent Sessions.
- Create session, stream deterministic response, abort, dispose.
- Unit tests.

This is intentionally small. It proves the most important architectural bet before touching secrets, OAuth, real LLM traffic, or old Director runtime migration.
