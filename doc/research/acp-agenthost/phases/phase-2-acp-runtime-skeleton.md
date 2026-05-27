# Phase 2 - ACP Runtime Skeleton

Updated: 2026-05-27

## Goal

Build the AgentHost node runtime foundation for ACP without full UI behavior.

AgentHost should be able to launch, initialize, timeout, and dispose an ACP process from a manual config.

## Entry Criteria

- Phase 1 can emit a secret-free enabled ACP agent config.
- A fake ACP agent fixture approach is chosen.
- File/terminal/write capabilities remain disabled.
- Protocol implementation strategy is chosen: first version uses internal JSON-RPC/local DTOs.

## Scope

- Add `src/vs/platform/agentHost/node/acp/**`.
- Implement ACP v1 stdio JSON-RPC framing.
- Spawn a configured ACP command with controlled cwd/env.
- Resolve runtime env only at process launch from the secret-free snapshot's env names/secret references.
- Call `initialize`.
- Capture stderr with redaction.
- Detect auth-required errors and return structured status.
- Implement request timeout, dispose, and process kill.
- Add fake ACP agent tests.

## Non-Goals

- No real chat turn UI.
- No registry install.
- No guided login flow.
- No file/terminal/client-side tool capabilities.
- No `session/new`, `session/prompt`, or `session/cancel` yet beyond protocol DTO definitions.
- No session restore.

## Implementation Tasks

1. Implement the Phase 0 protocol strategy:
   - internal JSON-RPC/local DTOs for the first version;
   - keep SDK adoption as a later replacement option only after dependency/bundling review.
2. Implement stdio line framing and JSON-RPC request tracking.
3. Implement process lifecycle:
   - spawn;
   - stderr capture;
   - stdout parse;
   - exit/error classification;
   - dispose/kill.
4. Implement `AcpRuntimeEnvironmentResolver`:
   - expand secret/env references only at process launch;
   - preserve required host env such as `PATH`, `HOME`, `USERPROFILE`, and proxy variables according to policy;
   - do not log expanded values;
   - mark missing required secret/env references as structured errors.
5. Implement `initialize`.
6. Implement request timeout and process disposal.
7. Implement structured errors:
   - auth required;
   - process not found;
   - missing runtime env/secret reference;
   - unsupported protocol version;
   - malformed JSON;
   - process exited.
8. Add fake ACP agent fixture for deterministic tests.
9. Add no-secret logging tests.

## Likely Files

- `src/vs/platform/agentHost/node/acp/acpConnection.ts`
- `src/vs/platform/agentHost/node/acp/acpProcess.ts`
- `src/vs/platform/agentHost/node/acp/acpProtocol.ts`
- `src/vs/platform/agentHost/node/acp/acpErrors.ts`
- `src/vs/platform/agentHost/test/node/acp/**`

## Acceptance Criteria

- Fake ACP process initializes successfully.
- Unsupported protocol version fails clearly.
- Broken JSON fails clearly and disposes process resources.
- Timeout/dispose does not leave child processes running.
- Logs do not include prompt content, file contents, or secret env values.
- Runtime env/secret references are expanded only at process launch and never written back to snapshots/logs.
- Missing required env/secret references fail clearly before spawn or before initialize.
- Runtime does not advertise file/terminal/write capabilities.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
```

## Risks

- Windows `.cmd` and shell behavior can make spawn brittle.
- Direct `shell: true` can become a security footgun.
- Stderr logs may include secrets or prompts from third-party agents.
- Process cleanup is easy to miss on cancellation or parse failure.
- Accidentally pulling in an SDK before dependency/bundling review can block tests and packaging.
- Over-inheriting the host environment can leak credentials; under-inheriting can break PATH/proxy/login discovery.

## Handoff Output

- ACP process/connection primitives.
- Runtime environment resolver with redaction behavior.
- Fake ACP agent fixture.
- Focused node tests for initialize, timeout, and dispose behavior.
