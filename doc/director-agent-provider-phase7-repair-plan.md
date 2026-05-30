# Director Agent Provider Phase 7 Repair Plan

Updated: 2026-05-30

## Status

Manual acceptance rejected the 2026-05-28 local repair attempt. The branch is being reset to a narrower baseline:

- adopt upstream VS Code `20ed2bc21d4 Fix offline BYOK state management (#318187)`;
- roll back local Chat Setup / Copilot-session visibility / multi-surface tool-confirmation experiments from `46ab6211a4b`;
- roll back the `director-code` auth-metadata bypass, global `targetChatSessionType` selector filter, and private direct-LM structured-message attachment side channel;
- treat direct `director-code` tool passthrough as still unresolved.

This plan records the corrected direction after manual acceptance found two regressions:

- Agent Window and IDE editor do not behave like native VS Code/Copilot when the same AgentHost session needs tool input or confirmation.
- Director-managed models are visible in some model picker surfaces, but using them through the Copilot/default chat participant can still fall into GitHub Copilot sign-in or an unsupported AgentHost model path.

The next repair should start from upstream BYOK behavior instead of local sign-in bypasses. `toolClientId` and multi-surface confirmation semantics remain important, but they must be fixed as a separate AgentHost protocol/UI task with native evidence and manual acceptance.

## Corrected Principles

### Tool ownership vs. confirmation UI

`toolClientId` identifies the AgentHost client responsible for executing a client-provided tool and dispatching `session/toolCallComplete`.

It must not be used as an exclusive UI ownership gate for tool confirmation. If two surfaces are observing the same session, both should render the same pending confirmation/input state from shared protocol state. If either surface approves or denies, the reducer should move the shared tool call to `Running` or `Cancelled`, and every observing surface should update from that same state.

Native evidence:

- `src/vs/platform/agentHost/common/state/protocol/channels-session/actions.ts` documents `toolClientId` as the owning client for client tool execution.
- `src/vs/platform/agentHost/common/state/protocol/channels-session/reducer.ts` applies `session/toolCallConfirmed` to shared tool-call state.
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/stateToProgressAdapter.ts` projects pending tool-call state into `ChatToolInvocation.WaitingForConfirmation`.
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts` wires confirmation dispatch and client-tool execution.

### Director model provider is a real VS Code LM provider

Director-managed provider models should be available to VS Code's normal `LanguageModelChatProvider` consumers, including the Copilot/default chat participant path, without using Copilot CAPI or GitHub Copilot auth.

The expected path is the existing VS Code/Copilot path:

```text
Chat model picker
  -> userSelectedModelId
  -> vscode.ChatRequest.model
  -> Copilot endpoint provider
  -> non-copilot vendor branch
  -> ExtensionContributedChatEndpoint
  -> languageModel.sendRequest(...)
  -> director-code provider
```

Native evidence:

- `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts` submits `input.currentLanguageModel` as `userSelectedModelId`.
- `src/vs/workbench/api/common/extHostChatAgents2.ts` resolves `userSelectedModelId` into `vscode.ChatRequest.model`.
- `extensions/copilot/src/extension/prompt/vscode-node/endpointProviderImpl.ts` routes non-`copilot` vendors to `ExtensionContributedChatEndpoint`.
- `extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts` calls `languageModel.sendRequest(...)`.

## Current Failure Modes

### Multi-surface tool calls

Rejected 2026-05-28 direction:

- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts` suppresses confirmation handling for tool calls whose `toolClientId` belongs to another client.
- `src/vs/platform/agentHost/node/director/directorAgentSession.ts` can fail in-flight tool calls when the active client changes, even though the original tool owner may still be connected and able to complete the call.

Observed impact:

- The Agent Window may show `InputNeeded` while no actionable UI appears.
- One surface can continue normally while another surface believes the session still has pending work.
- Tool calls may be failed or retried just because a second surface became active.

### Director model provider through Copilot/default chat

Remaining Director model-provider issues:

- `agent-host-director:*` models are AgentHost session-targeted models and should not be used as direct `LanguageModelChatProvider` request targets. Their provider currently throws for direct requests.
- `director-code` models are the correct direct LM provider surface, but their auth metadata and cross-extension access behavior need to be validated against upstream BYOK behavior before making another local change.
- Some logs show model identifiers like `agent-host-director:deepseek:deepseek-v4-flash`; the ext host LM resolver expects slash-based identifiers such as `vendor/model` and cannot extract a vendor from this shape.
- `DirectorLanguageModelProvider.sendChatRequest` currently serializes structured chat messages into one prompt string before bridging into an AgentHost Director session. That loses standard LM provider message structure and should be replaced or tightly documented as a temporary bridge.

Observed impact:

- Upstream BYOK state management should handle the GitHub sign-in gate for configured non-Copilot model groups.
- Direct `director-code` requests still do not pass VS Code LM tools through to the Director provider runtime, so tool-capable chats can degrade into literal tool-call text.

## Repair Scope

### 7.R1 - Restore native multi-surface tool confirmation semantics

Status: reverted from the 2026-05-28 repair commit. Re-plan and re-implement separately; do not mix with BYOK/model-provider login repair.

Scope:

- Remove the foreign-`toolClientId` confirmation suppression in `AgentHostSessionHandler`.
- Keep `toolClientId` as the execution-owner marker only.
- Allow every observing surface to render and dispatch confirmation for the shared pending tool state.
- Ensure confirmation dispatch is idempotent when two surfaces respond close together.
- Ensure the owning client executes and completes the tool after shared state reaches `Running`, even if a different surface supplied the confirmation.
- Do not fail in-flight Director client tool calls merely because the active client changes or another surface refreshes its tool list.
- Fail client tool calls only when the owning client disconnects, the tool disappears from that owning client, cancellation occurs, or the shared protocol explicitly denies/cancels.

Target files:

- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts`
- `src/vs/workbench/contrib/chat/test/browser/agentSessions/agentHostChatContribution.test.ts`
- `src/vs/platform/agentHost/node/director/directorAgentSession.ts`
- `src/vs/platform/agentHost/test/node/directorAgent.test.ts`

Implementation notes:

- `AgentHostSessionHandler` no longer suppresses confirmation UI for tool calls owned by another client.
- Shared protocol confirmation/cancellation state clears local waiting UI without redispatching duplicate confirmation actions.
- `DirectorAgentSession` keeps per-client tool snapshots and executes an in-flight tool on the original owning client even if another surface becomes active.
- In-flight tool calls are failed only when the owning client disconnects, the owning tool disappears, cancellation occurs, or the protocol denies/cancels the call.

Acceptance:

- Two windows/surfaces subscribed to the same AgentHost session both show the same pending tool confirmation/input state.
- Approving or denying from either surface updates the other surface without leaving a pending request behind.
- Only the owning client executes the client-provided tool and dispatches `session/toolCallComplete`.
- Active-client changes do not fail an in-flight Director tool call.
- No duplicate tool execution occurs when both surfaces observe the same transition.

### 7.R2 - Separate AgentHost session models from Director direct LM provider models

Status: reverted from the 2026-05-28 repair commit. Re-plan with upstream picker/selection semantics before changing global `LanguageModelsService` behavior again.

Scope:

- Keep `agent-host-director` models targeted to Director AgentHost sessions only.
- Do not expose `agent-host-director:*` as a direct Copilot/default chat LM request path.
- Ensure generic/default chat model picker surfaces use `director-code/...` for Director-managed provider models.
- Preserve AgentHost Director session model picker behavior for `agent-host-director` where `targetChatSessionType` is appropriate.
- Keep model ids stable and slash-based where the VS Code LM/ext host path needs to recover the vendor from the identifier.

Target files:

- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLanguageModelProvider.ts`
- `src/vs/workbench/contrib/chat/browser/widget/input/chatModelSelectionLogic.ts` only if native filtering needs a narrow compatibility correction.
- `src/vs/workbench/contrib/chat/test/browser/agentSessions/agentHostChatContribution.test.ts`
- `src/vs/workbench/contrib/directorCode/browser/directorLanguageModel/directorLanguageModelProvider.ts`
- `src/vs/workbench/contrib/directorCode/test/browser/directorLanguageModelProvider.test.ts`

Implementation notes:

- `LanguageModelsService.selectLanguageModels` excludes models with `targetChatSessionType` from direct LM request selection.
- AgentHost session-targeted models remain available to AgentHost session pickers.
- Director-managed provider models remain exposed through slash-based `director-code/...` identifiers.

Acceptance:

- Director AgentHost sessions can still use their session-targeted model picker.
- Generic Copilot/default chat does not select `agent-host-director:*` models as direct LM request targets.
- Director-managed provider models appear as `director-code` models in the normal VS Code model picker.
- ExtHost can resolve the selected model vendor and does not log "Could not extract vendor" for Director selections.

### 7.R3 - Make `director-code` safe for Copilot/default chat without GitHub auth

Status: reset. Upstream VS Code now owns the offline BYOK state transition. The local startup-time eager model resolution workaround and local `metadata.auth` bypass were reverted.

Scope:

- Validate whether `metadata.auth` on `director-code` models is compatible with upstream BYOK state management before removing or narrowing it.
- Keep Director provider credentials behind the existing Director-owned Secret Storage and runtime credential bridge.
- Do not introduce `ICopilotApiService`, `GITHUB_COPILOT_PROTECTED_RESOURCE`, Copilot token manager, or Copilot CAPI into Director provider code.
- Keep `chat.offlineByok` and `github.copilot.clientByokEnabled` semantics aligned with upstream VS Code behavior; do not hard-code a Director-specific Copilot login bypass or eagerly resolve models just to satisfy chat setup.

Target files:

- `src/vs/workbench/contrib/directorCode/browser/directorLanguageModel/directorLanguageModelProvider.ts`
- `src/vs/workbench/contrib/directorCode/browser/directorCode.contribution.ts`
- `src/vs/workbench/contrib/directorCode/test/browser/directorLanguageModelProvider.test.ts`
- Chat setup/BYOK tests only if native BYOK detection needs a narrow repair.

Implementation notes:

- Upstream `$onChatModelsChange` / `HasByokModelsContribution` behavior handles BYOK readiness without Director-specific startup model resolution.
- Director credentials remain behind Director Secret Storage and the turn-time AgentHost runtime credential bridge.
- No Director-owned code imports Copilot CAPI or GitHub Copilot auth.

Acceptance:

- With Copilot signed out and a configured Director provider/model, Copilot/default chat can activate through the existing BYOK/non-Copilot model path.
- Selecting a `director-code` model does not show GitHub Copilot sign-in as a prerequisite.
- Real credentials are resolved only at Director request time.
- Registry, snapshot, model metadata, and logs remain secret-free.

### 7.R4 - Preserve standard LM message shape for direct `director-code` requests

Status: reverted from the 2026-05-28 repair commit. The private attachment side channel is removed; structured message and tool forwarding need a fresh, deliberate design.

Scope:

- Stop treating direct LM requests as an opaque serialized prompt when the provider/runtime can accept structured messages.
- Preserve system/user/assistant roles and text/tool/image/thinking parts as far as the current Director provider runtime supports them.
- If the temporary AgentHost-session bridge remains, document the lossy conversion and confine it to the shortest possible compatibility layer.
- Prefer the shared Phase 7 provider runtime and `DirectorAgentEngineAdapter` semantics over a new Workbench-side HTTP implementation.

Target files:

- `src/vs/workbench/contrib/directorCode/browser/directorLanguageModel/directorLanguageModelProvider.ts`
- Shared AgentHost Director common/provider request adapters as needed.
- Targeted tests for text, tool-call capable, and reasoning-capable requests.

Implementation notes:

- `DirectorLanguageModelProvider.sendChatRequest` converts VS Code LM messages into Director normalized messages instead of serializing them into one prompt string.
- The normalized messages are carried through a marked `MessageAttachmentKind.Simple` attachment so Workbench still avoids node HTTP/provider runtime imports.
- `DirectorAgentEngineAdapter` consumes that marked attachment and sends the structured messages through the shared node-owned provider runtime.
- Text, thinking, tool-use, tool-result, image URL, and data parts are preserved as far as the current normalized provider runtime supports them.

Acceptance:

- Copilot's `ExtensionContributedChatEndpoint` can send a request to a `director-code` model and receive streamed text/thinking parts.
- Tool-capable requests do not lose tool metadata before reaching Director runtime.
- The implementation still keeps provider HTTP and credential resolution out of Workbench UI code.

## Validation

Required before marking this repair complete:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/chat/test/browser/agentSessions/agentHostChatContribution.test.ts -- --grep "tool"
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/directorCode/test/browser/directorLanguageModelProvider.test.ts
git diff --check
```

Rejected validation from 2026-05-28 is kept here only as historical context. It is not acceptance evidence for the reset baseline:

```powershell
npm run compile-check-ts-native
npm run transpile-client
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts
npm run test-node -- --run src/vs/workbench/contrib/chat/test/common/languageModels.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/directorCode/test/browser/directorLanguageModelProvider.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/chat/test/browser/agentSessions/agentHostChatContribution.test.ts -- --grep "permission_request|language model provider|tool"
npm run test-browser-no-install -- --browser chromium --run src/vs/sessions/contrib/providers/agentHost/test/browser/localAgentHostSessionsProvider.test.ts
npm run test-browser-no-install -- --browser chromium --run src/vs/sessions/contrib/providers/copilotChatSessions/test/browser/copilotChatSessionsProvider.test.ts
npm run valid-layers-check
git diff --check
```

Manual acceptance:

- With Copilot signed out, verify the chat setup screen does not require GitHub sign-in solely because a configured Director BYOK provider exists.
- In generic Copilot/default chat, select a `director-code` model while GitHub Copilot is signed out.
- Send a simple non-tool prompt and verify it routes through Director provider credentials, not GitHub Copilot auth.
- Trigger a tool-capable prompt and verify whether VS Code LM tool definitions are forwarded; this is expected to remain a gap until the next repair slice.
- Inspect provider registry/snapshot/logs and confirm no API key or OAuth token is present.

## Non-goals

- Do not modify `extensions/copilot/**`.
- Do not use Copilot CAPI or GitHub Copilot auth for Director-owned models.
- Do not add a second Workbench-side provider HTTP runtime.
- Do not hide Director models from standard VS Code model pickers as a workaround.
- Do not copy the old generated Director tree as source of truth; reuse semantics only where they fit the current AgentHost architecture.
