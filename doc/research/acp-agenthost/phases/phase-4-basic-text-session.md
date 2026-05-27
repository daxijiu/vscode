# Phase 4 - Basic Text Session

Updated: 2026-05-27

## Goal

Deliver the first end-to-end usable ACP text turn through native VS Code UI.

This phase assumes real vendor agents are already logged in. If an agent is not logged in, the system should show a clear login-required message and stop cleanly.

## Entry Criteria

- Phase 3 shows enabled ACP agents in the Agent Sessions UI.
- ACP runtime can initialize configured processes.
- First milestone capability policy remains text-only.

## Scope

- Implement `IAgent.createSession` using ACP `session/new`.
- Implement `IAgent.sendMessage` using ACP `session/prompt`.
- Implement active-turn `IAgent.abortSession` using ACP `session/cancel`.
- Implement `IAgent.getSessionMessages` for in-memory turns accumulated since session creation.
- Map text chunks into AgentHost response actions.
- Map reasoning/thought chunks when available.
- Map complete/cancel/error stop reasons.
- Enforce one terminal AgentHost action per turn: complete, cancelled, or error.
- Absorb or ignore late ACP updates after cancellation or terminal completion without emitting a second terminal action.
- Handle unexpected ACP `tool_call` / `tool_call_update` notifications while the client advertises no tools:
  - surface an explicit unsupported-capability status/error;
  - do not execute tools, files, terminal commands, or permission prompts;
  - never hang the turn waiting for an unsupported tool result.
- Preserve in-memory transcript state for visible session.
- Show clear vendor-login-required message for auth-required/missing-login errors.
- Keep tools, file writes, and terminal disabled.

## Non-Goals

- No guided login flow.
- No terminal auth.
- No file/terminal client capabilities.
- No tool call execution.
- No session restore.
- No registry install.

## Implementation Tasks

1. Add `AcpAgentSession` to own ACP session id, VS Code session URI, cwd, and runtime connection.
2. Implement `createSession`:
   - resolve cwd;
   - initialize connection if needed;
   - call `session/new`;
   - surface auth-required as structured error.
3. Implement `sendMessage`:
   - convert user text prompt;
   - call `session/prompt`;
   - stream `session/update` notifications to AgentHost actions.
4. Implement update mapper:
   - assistant text;
   - reasoning/thought;
   - status/progress;
   - unexpected tool call/update downgrade while text-only;
   - usage if available;
   - complete/cancel/error.
5. Add cancellation:
   - call ACP `session/cancel`;
   - mark AgentHost turn cancelled exactly once;
   - ignore late post-cancel updates except for safe diagnostics.
6. Add active-turn state machine:
   - pending;
   - streaming;
   - completed;
   - cancelled;
   - errored.
7. Add tests using fake ACP agent.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpAgent.ts`
- `src/vs/platform/agentHost/node/acp/acpAgentSession.ts`
- `src/vs/platform/agentHost/node/acp/acpSessionUpdateMapper.ts`
- `src/vs/platform/agentHost/test/node/acp/**`
- AgentHost session action tests.

## Acceptance Criteria

- User can create an ACP session from normal Agent Sessions UI.
- Pre-authenticated fake/manual ACP agent can stream text into the UI.
- Missing login produces an actionable vendor-login-required message, not a generic protocol error.
- Cancel stops the current turn and marks the UI as cancelled.
- Cancel races do not emit duplicate terminal actions or resurrect late text/tool updates.
- Unexpected tool updates during the text-only milestone produce a clear unsupported-capability result/error rather than hanging.
- In-memory transcript reads through `getSessionMessages` for the current process lifetime.
- Errors are visible, actionable, and redacted.
- No file/terminal/tool capabilities are advertised.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
npm run test-node -- --grep agentHost
```

Manual smoke, when a real agent is already logged in:

```powershell
agent acp
codebuddy --acp
```

## Risks

- ACP update variants may not map cleanly to existing AgentHost action shapes.
- Vendor agents may produce auth-required in different places.
- Cancellation can race with streamed updates and prompt completion.
- Some real agents may emit tool updates even when the client has not advertised file/terminal/tool capabilities.
- Missing login must not look like a VS Code or Director account failure.

## Handoff Output

- First text-only ACP milestone.
- Fake ACP tests for prompt/update/cancel, unexpected tool update downgrade, and single terminal action under cancel races.
- Manual smoke notes for any real pre-authenticated vendor agent.
