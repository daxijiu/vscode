# Phase 6 - Tools, Permissions, Files, Terminal

Updated: 2026-05-28

## Goal

Safely expose ACP side-effect capabilities through native VS Code AgentHost UI and policy paths.

This is the highest-risk runtime phase.

## Entry Criteria

- Phase 5 login UX is usable.
- Product/security agrees on capability gating.
- AgentHost permission, tool, changeset/file, and terminal surfaces are identified.
- Enterprise/internal policy hooks for file/terminal/tool capabilities are designed.

## Scope

- Map ACP permission requests into AgentHost permission UI.
- Map ACP tool calls/progress into AgentHost tool UI.
- Add file read with workspace containment.
- Add file write only through permission and edit/changeset UI.
- Add terminal create/output/wait/kill only through AgentHost terminal policy.
- Cancel pending permissions on turn cancellation.
- Make capabilities configurable per ACP agent.
- Add policy hooks to disable ACP file, terminal, and tool capabilities before they are advertised.
- Resolve client capability flags before ACP `initialize`.
- Treat capability changes as requiring reconnect/re-initialize unless the active ACP protocol version explicitly supports a dynamic capability update and tests cover it.
- Add terminal-auth only after the same terminal policy gates apply to regular terminal requests.

## Non-Goals

- No default blanket file/terminal access.
- No bypass around AgentHost permission policy.
- No raw terminal execution from ACP requests.
- No unsupported tool-call schema guessing.
- No silent mid-connection capability mutation.

## Implementation Tasks

1. Define capability flags in ACP config/snapshot.
   - Resolve the effective flags before process launch/`initialize`.
   - Show pending reconnect/re-initialize when a user changes effective capabilities for a live agent.
2. Implement policy resolution for side-effect capabilities:
   - external ACP tools disabled;
   - ACP file read/write disabled;
   - ACP terminal disabled;
   - effective policy reflected in initialized client capabilities.
3. Implement ACP permission request mapper.
4. Implement tool-call lifecycle mapper:
   - start;
   - progress/update;
   - completed;
   - failed/rejected.
5. Implement file read containment.
6. Implement file write through edit/changeset path.
7. Implement terminal create/output/wait/kill through AgentHost terminal manager.
8. Add cancellation cleanup for pending permission/tool/terminal requests.
9. Ensure cancellation sends valid ACP denial/cancel responses for pending permission requests, not only local UI cleanup.
10. Add denial paths that return valid ACP responses.
11. Add redaction for file/terminal logs.
12. Add reconnect/re-initialize tests for capability toggles.
13. Add policy tests proving disabled capabilities are not advertised or executed.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpClientCapabilities.ts`
- `src/vs/platform/agentHost/node/acp/acpPermissionBridge.ts`
- `src/vs/platform/agentHost/node/acp/acpToolBridge.ts`
- `src/vs/platform/agentHost/node/acp/acpFileSystemBridge.ts`
- `src/vs/platform/agentHost/node/acp/acpTerminalBridge.ts`
- Existing AgentHost permission/tool/terminal services.

## Acceptance Criteria

- No ACP file write bypasses workspace containment and permission gates.
- No ACP terminal command runs without the intended policy path.
- Rejected permissions return valid ACP responses and do not hang the turn.
- Tool calls have complete lifecycle states in UI.
- Cancelling a turn cancels pending permissions/tool waits.
- Cancelling a turn responds to pending ACP permission requests with an explicit denied/cancelled outcome.
- Capability changes for a live ACP process require reconnect/re-initialize or a tested dynamic protocol path.
- Policy-disabled file/terminal/tool capabilities are not advertised during ACP `initialize`.
- Policy-disabled requests return valid ACP denial/error responses and do not execute side effects.
- Logs are redacted.

## Phase 6A Implementation Status

- 2026-05-28: implemented the Phase 6A skeleton for capability negotiation, inbound permission mediation, and tool lifecycle projection.
- ACP `initialize` now resolves client capabilities from the secret-free snapshot plus explicit policy. File read/write, terminal execution, and tool-call metadata are omitted by default; policy-disabled capabilities are not advertised.
- ACP JSON-RPC inbound requests no longer all fail as `MethodNotFound`; `session/request_permission` is handled through an ACP permission bridge and returns valid deny/cancel outcomes. Unknown inbound requests remain `MethodNotFound`.
- Pending permission requests are cancellable; turn/session cancellation resolves them with `{ outcome: 'cancelled' }` before notifying `session/cancel`.
- ACP `tool_call` and `tool_call_update` session updates are mapped to AgentHost tool lifecycle actions. The Phase 6A mapper shows start/progress/complete/fail states with redacted unsupported markers and does not execute tools, read/write files, open terminals, or wait for tool results.
- Fake ACP fixtures and focused tests cover disabled initialize capabilities, default permission denial, pending permission cancellation, tool lifecycle action ordering, unknown-request method-not-found behavior, and redaction of file/terminal/prompt-like tool content.

Still deferred beyond Phase 6A:

- Real filesystem read bridge with workspace containment.
- File write/edit/changeset execution and approval.
- Terminal create/output/wait/kill and terminal-auth.
- MCP bridge and real tool invocation/result plumbing.
- Dynamic live capability mutation without reconnect/re-initialize.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
npm run test-node -- --grep agentHost
```

Required focused tests:

- permission approve/reject/cancel;
- file read outside workspace denied;
- file write outside workspace denied;
- terminal creation denied by policy;
- terminal output redaction;
- cancelled turn with pending permission;
- pending permission cancellation response sent back to ACP;
- capability toggle requires reconnect/re-initialize before new permissions are advertised;
- policy-disabled file/terminal/tool capabilities not advertised;
- policy-disabled file/terminal/tool request denied without side effects;
- failed tool call returns a visible result.

## Risks

- Side effects are the main security risk of ACP.
- Terminal output and file contents can leak secrets.
- Permission prompts can deadlock if cancellation is not wired.
- Tool-call event ordering can desync UI state.
- ACP capabilities negotiated during `initialize` can drift from UI config unless reconnect/re-initialize is explicit.
- If policy hooks are deferred to Phase 9, file/terminal/tool support can exist without a reliable kill switch.

## Handoff Output

- Capability-gated side-effect bridge.
- Focused tests for permission, file, terminal, cancellation, and redaction.
- Reconnect/re-initialize behavior for capability changes.
- Policy hooks and focused tests for ACP file, terminal, and tool capabilities.
- Security review notes.
