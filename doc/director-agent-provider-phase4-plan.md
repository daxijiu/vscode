# Director Agent Provider Phase 4 Plan

Updated: 2026-05-26

## Goal

Move the current Director AgentHost provider from deterministic echo to a minimal provider-backed Director AgentEngine turn, while preserving the Phase 3 registry/auth/snapshot boundary.

## Implemented Slice

- `DirectorAgentSession` resolves the selected AgentHost model through `DirectorProviderBackendHub`.
- `DirectorAgentEngineAdapter` converts AgentHost turns and attachments into normalized Director messages, builds the provider-native request with Phase 3 request adapters, sends one non-streaming provider request, and maps the result back into AgentHost session actions.
- Runtime credentials flow through the narrow `directorRuntimeCredentials` reverse IPC channel only when a turn needs them.
- Workbench and Sessions renderers resolve API-key or fake OpenAI Codex OAuth credentials from Secret Storage; AgentHost node receives only the credential needed for the active request.
- Registry JSON, provider snapshots, AgentHost model metadata, and AHP logs remain secret-free.

## Reference Materialization

Before deeper Phase 4.2-4.4 work, materialize the old Director patch layer into a local reference tree so implementation agents can inspect complete source files instead of mining large patch hunks.

Recommended reference source:

```powershell
E:\Projects\Director-Code-batch\Director-Code-112-check\patches\replay\004-director-agent-engine.120-insider.patch
```

Current materialized reference:

```text
E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\reference-director-120\layers\director\vscode
```

Guidelines:

- Materialize into an ignored reference-only location such as `.tmp\director-old-agentengine-reference\` or the old repo's `vscode.generated\layers\director\vscode` workspace.
- Treat the materialized tree as semantic reference only. Do not copy it wholesale into this fork, and do not make it the source of truth for current work.
- Use it to inspect complete versions of old `agentEngine.ts`, `directorCodeAgent.ts`, `progressBridge.ts`, `messageNormalization.ts`, `toolBridge.ts`, and `directorPlanMode.ts`.
- If the materialized reference needs dependencies or build output, keep that setup inside the reference workspace. Do not let old generated-tree outputs or `node_modules` leak into this fork.
- Re-materialize from the patch layer when evidence conflicts with the current checkout, because generated-tree experiments can drift.

## Remaining Execution Order

### Phase 4.1 - Provider Streaming

Goal: replace the current non-streaming provider request with provider delta streaming while keeping the same credential and snapshot boundaries.

Scope:

- Add streaming response parsing for OpenAI-compatible chat completions and Anthropic Messages first.
- Follow the existing AgentHost streaming state shape: emit `SessionResponsePart` before the first delta for a stable part id, then emit `SessionDelta` for markdown text and `SessionReasoning` for thinking deltas.
- Accumulate streamed content into the in-memory turn so the final transcript has one coherent markdown/reasoning part instead of many tiny delta-only fragments.
- Do not double-emit canonical/final provider content that has already been emitted through deltas.
- Abort the upstream provider request when the AgentHost turn is cancelled.
- Keep response/error redaction for API keys, bearer tokens, and provider error bodies.
- Keep non-streaming fallback for provider api types whose streaming parser is not implemented yet, including the current OpenAI Codex Responses-shape and Gemini adapters.

Acceptance:

- A Director turn visibly streams content in the Agents window.
- Abort stops the provider request and marks the turn cancelled.
- Tests assert `SessionResponsePart` precedes the first `SessionDelta` / `SessionReasoning` for the same part id.
- Final `Turn.responseParts` contains the accumulated response content without duplication.
- Provider HTTP errors remain understandable and secret-free.
- Providers without a streaming parser still complete through the existing non-streaming path and have an explicit unsupported-streaming note or test.
- Targeted tests cover at least OpenAI-compatible and Anthropic-style streaming fixtures.

### Phase 4.2 - Tool Calls

Goal: reintroduce old Director tool-call semantics through AgentHost permission/tool UI rather than restoring the old Chat Agent tool UI.

Scope:

- Mine old `toolBridge.ts` for request/result semantics, not UI structure.
- Represent provider tool calls as AgentHost tool actions using existing permission and result plumbing.
- Add normalized tool definition and tool result DTOs under `src/vs/platform/agentHost/common/**`, then build provider-native tool schemas/results per api type.
- Gate tool support by provider/model capability so unsupported provider protocols do not receive invalid tool schema fields.
- Feed tool results back into the next provider request using the normalized message/request adapter layer.
- Handle rejected, failed, and unsupported tool calls without hanging the turn.
- Add a small `maxToolIterations` guard for the first slice so repeated or recursive tool calls terminate with a clear error instead of keeping the session in-flight forever.
- Ensure each turn emits exactly one terminal action: complete, cancelled, or error.

Acceptance:

- A provider tool call surfaces through AgentHost permission/tool UI.
- Accepted tool calls return results to the provider and allow the turn to continue.
- Rejected or failed tool calls produce a clear AgentHost-visible result.
- Repeated/recursive tool-call fixtures hit the iteration guard and end the turn cleanly.
- Unsupported tool calls produce an explicit result or error and do not bypass the permission path.
- Tests cover provider-native schema conversion and compatibility gating for at least OpenAI-compatible and Anthropic tool shapes.
- The implementation stays narrow and does not broaden ownership across `src/vs/sessions/**`.

### Phase 4.3 - Plan Mode

Goal: make old Director Plan Mode behavior explicit in AgentHost, either as a minimal supported mode or as a deliberate gate.

Recommended first slice:

- Define the trigger surface before implementation. Preferred initial trigger is the existing AgentHost mode/session config path if it exposes a Plan mode; old `director_present_plan` should remain unmapped until there is an AgentHost-shaped command/action contract.
- Add an explicit gated-off path for Plan Mode with a clear AgentHost-visible message and TODO.
- Preserve ordinary Agent Mode behavior unchanged.
- Document what old `directorPlanMode.ts` state must be migrated when Plan Mode is implemented for real.

Acceptance:

- The plan documents the concrete Plan Mode trigger path used by the implementation.
- Triggering Plan Mode does not silently no-op or crash.
- The user sees a clear unsupported-mode message for the current AgentHost Director harness.
- Ordinary provider-backed Agent turns remain unaffected.

### Phase 4.4 - AgentEngine Loop Parity

Goal: bring back the most useful old `AgentEngine` loop semantics without breaking the AgentHost-shaped architecture.

Scope:

- Improve message normalization for multi-turn history, attachments, cwd, and assistant responses.
- Add in-memory context trimming guards so long conversations do not fail abruptly.
- Add provider retry/error classification for empty responses, 401, 429, 5xx, and malformed payloads.
- Do not retry across side-effecting tool execution. Retries may replay provider calls only before a tool side effect has run, unless the implementation adds explicit idempotency/turn-step tracking.
- Keep local/custom provider support either explicitly unsupported or gated until a concrete runtime adapter exists.
- Keep durable compaction, transcript restore, and cross-restart history in Phase 9; Phase 4.4 should only decide what context to send for the active runtime turn.

Acceptance:

- Multi-turn Director conversations use prior user and assistant context.
- Long or malformed provider responses produce controlled errors.
- Long-context tests verify the active request is trimmed predictably without claiming durable session compaction.
- Retry tests prove side-effecting tool calls are not executed twice after provider/network failure.
- Secret-free snapshot and runtime credential boundaries remain intact.
- Tests cover history normalization, long-context trimming behavior, and provider error classification.

## Adapter Boundaries

- AgentHost runtime code lives under `src/vs/platform/agentHost/**`.
- Shared request builders, snapshot DTOs, and runtime credential IPC contracts live under `src/vs/platform/agentHost/common/**`.
- Workbench owns Director Settings, provider registry, auth state, Secret Storage wrappers, and snapshot writing under `src/vs/workbench/contrib/directorCode/**`.
- The Sessions renderer contributes only a runtime credential bridge so the Agents window can serve credentials to local AgentHost without importing Workbench UI or AgentHost node transports.

## Manual Acceptance Steps

Use the source-run acceptance profile:

```powershell
$env:VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT='1'
$env:VSCODE_SKIP_PRELAUNCH='1'
.\scripts\code.bat --remote-debugging-port=<free-port> --skip-sessions-welcome --user-data-dir .\.tmp\director-phase3-acceptance\user-data --extensions-dir .\.tmp\director-phase3-acceptance\extensions --shared-data-dir .\.tmp\director-phase3-acceptance\shared-data --skip-welcome --skip-release-notes .
```

Acceptance checks:

- Confirm `chat.agentHost.enabled=true` and `chat.agentHost.directorAgent.enabled=true` in the profile settings.
- Open `Director Settings`.
- Confirm configured providers and visible models appear in the Settings summary and in the secret-free provider snapshot.
- Open the Agents window while Copilot is signed out.
- Pick session type `Director`.
- Pick a configured model such as `deepseek-v4-flash`.
- Send `Reply exactly: DIRECTOR_PHASE4_OK`.
- Confirm the response includes `DIRECTOR_PHASE4_OK` and the selected Director model, proving the turn is provider-backed rather than deterministic echo.
- Confirm missing provider/model/credentials paths show understandable `directorAgentEngine` errors and do not crash the Agents window.
- Scan registry, snapshot, and current AHP/window logs for token-shaped values; only non-secret metadata such as `authKind: api-key` and Copilot protected-resource metadata should appear.

Subphase-specific manual checks:

- Phase 4.1: use a deterministic local streaming fixture long enough to observe incremental output, then cancel mid-turn and confirm the provider request aborts cleanly. Real-provider streaming smoke is optional.
- Phase 4.2: use deterministic local tool-call fixtures that request one allowed tool, one rejected tool, one unsupported tool, and one repeated/recursive tool sequence that hits `maxToolIterations`.
- Phase 4.3: trigger the documented Plan Mode entry path and confirm the unsupported-mode message appears without affecting normal Agent mode.
- Phase 4.4: send a multi-turn prompt that depends on previous context, then a long-context prompt that exercises trimming and returns a controlled response/error.

## Validation

Required before commit:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/common/directorProviderAdapters.test.ts
npm run test-node -- --run src/vs/workbench/contrib/directorCode/test/common/provider/directorProviderServices.test.ts
git diff --check
```

Each Phase 4 subphase must add or identify its own targeted test command before commit. Expected future targets include:

```powershell
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgentStreaming.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgentToolCalls.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgentPlanMode.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgentLoopParity.test.ts
```

## Deferred Follow-Ups

- Phase 4.1: stream provider deltas instead of only non-streaming text responses.
- Phase 4.2: reintroduce old Director tool call semantics through AgentHost permission/tool UI.
- Phase 4.3: reintroduce or explicitly gate old Director Plan Mode as AgentHost session state.
- Phase 4.4: improve old AgentEngine loop parity for history, in-memory context trimming, retry, and provider error classification.
- Keep real provider-backed model discovery and network validation in Phase 7/provider hardening unless explicitly pulled forward.
- Keep real OpenAI Codex OAuth browser/device flow and additional OAuth providers in Phase 8.
- Keep Claude SDK de-CAPI migration, durable session restore, and public OpenAI Responses support in their later roadmap phases.
