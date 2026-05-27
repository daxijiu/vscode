# Phase 3 - Agent List And Subscription State

Updated: 2026-05-27

## Goal

Make enabled ACP agents visible as native VS Code AgentHost agents, with clear vendor-owned subscription/login state.

## Entry Criteria

- Phase 1 emits enabled ACP config.
- Phase 2 can initialize an ACP process or return structured status.
- Product wording for subscription ownership is accepted.
- Config apply behavior is accepted: restart/reconnect prompt or dynamic provider reconcile.

## Scope

- Register one `AcpAgent` `IAgent` provider per enabled ACP config.
- Implement the full required `IAgent` surface in skeleton form, not only `createSession` and `sendMessage`.
- Normalize provider ids, for example:
  - `acp-cursor`
  - `acp-codebuddy-code`
  - `acp-codex`
  - `acp-claude`
- Publish agent descriptors and placeholder model state.
- Adapt Agent Sessions UI labels/details so users see vendor-owned subscription/account state.
- Hide disabled/untrusted agents.
- Show missing-login state as a clear status only when known from an explicit user action.
- Keep agent-list rendering lazy: do not launch third-party ACP commands just to show the list.
- Apply config changes according to the Phase 1 policy:
  - if restart/reconnect is required, show that state clearly;
  - if dynamic reconcile is implemented, add safe provider unregister/reconcile behavior.
- Keep the initial skeleton explicitly limited:
  - `resolveSessionConfig`: return the minimal text-session config schema;
  - `sessionConfigCompletions`: return no completions until Phase 8;
  - `listSessions`: return no persisted sessions until restore is implemented;
  - `getSessionMessages`: return only in-memory turns once Phase 4 creates them;
  - `disposeSession`: dispose any local session/runtime entry allocated so far;
  - `abortSession`: no-op when no turn is active, real cancel in Phase 4;
  - `changeModel`: return a clear unsupported result/error until Phase 8;
  - `respondToPermissionRequest` / `respondToUserInputRequest`: ignore unknown ids and remain unsupported until Phase 5/6;
  - `setClientTools` / `onClientToolCallComplete`: ignore or reject until Phase 6;
  - `setClientCustomizations` / `setCustomizationEnabled`: return empty/no-op until ACP customization support is planned;
  - `authenticate`: return `false` or an auth-unsupported result until Phase 5;
  - `shutdown`: dispose all ACP sessions/connections owned by the provider.

## Non-Goals

- No full chat turn yet.
- No guided login flow.
- No file/terminal/tool capabilities.
- No registry install.
- No External ACP Agents management page work; that belongs to Phase 1.
- No eager process launch from provider registration or agent list rendering.

## Implementation Tasks

1. Implement `AcpAgent` skeleton implementing the complete required `IAgent` interface.
   - Prefer explicit unsupported/no-op methods over leaving runtime `TODO` throws in visible user flows.
   - Add comments/tests that document which phase owns each stub's real behavior.
2. Register `AcpAgent` providers from enabled ACP config.
3. Publish `IAgentDescriptor` with external subscription wording.
4. Prevent duplicate registration:
   - do not call `registerProvider` twice for the same id;
   - choose restart/reconnect or implement provider unregister/reconcile.
5. Implement the minimum visible subscription UI:
   - the session creation flow or agent picker/detail must visibly show the subscription label;
   - descriptor description alone is insufficient unless the current UI actually renders it.
6. Define status source rules:
   - unknown by default;
   - missing login only after explicit createSession/Test Connection/runtime error;
   - never launch a process just to refresh status.
7. Extend Agent Sessions UI only if existing descriptor fields are insufficient.
8. Add tests for provider id normalization, visibility, visible subscription label, cached status, and no eager launch.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpAgent.ts`
- `src/vs/platform/agentHost/node/agentHostMain.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- `src/vs/platform/agentHost/node/agentSideEffects.ts`
- `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`
- `src/vs/sessions/contrib/providers/agentHost/test/browser/**`

## Acceptance Criteria

- Enabled ACP agents appear in the existing Agent Sessions agent list.
- Disabled/untrusted ACP agents do not appear.
- UI text clearly says the agent uses its own subscription/account.
- The chosen minimum UI surface visibly renders the subscription label in the session creation or agent detail path.
- Provider id works with `AgentSession.uri`.
- No new ACP-specific chat webview is introduced.
- Rendering the agent list does not start external ACP processes.
- Missing-login status is sourced only from cached explicit actions, not background probing.
- Enable/disable follows the accepted restart/reconnect or dynamic reconcile policy.
- `AcpAgent` compiles against the current full `IAgent` interface.
- Unsupported methods have deterministic initial behavior and do not crash agent-list rendering.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep agentHost
```

## Risks

- Current Agent Sessions UI may only show provider label/icon, not enough detail for subscription ownership.
- Adding metadata to root `AgentInfo` may require protocol/schema changes.
- Provider id normalization mistakes can break session URIs.
- Current `AgentService.registerProvider` rejects duplicate ids and has no unregister path, so dynamic enable/disable must be designed deliberately.
- Eager status checks can launch third-party CLIs unexpectedly.
- If the subscription label is only stored in descriptor metadata that no UI renders, the product requirement is not actually met.
- A partial `IAgent` implementation can compile-break or expose `TODO` errors in unrelated UI paths such as restore, model change, permissions, or client tools.

## Handoff Output

- ACP agents visible in native agent list.
- Clear subscription/account wording in a visible UI path.
- Tests for visibility, provider id behavior, subscription label rendering, cached status source, and lazy no-launch rendering.
- A full `IAgent` skeleton with explicit unsupported/no-op semantics for later phases.
