# Phase 5 - Vendor Login UX And Smoke Tests

Updated: 2026-05-27

## Goal

Improve the missing-login path after the first text milestone, while preserving vendor-owned subscription boundaries.

Phase 4 only needs to show a clear login-required message. Phase 5 turns that into guided recovery and real vendor smoke coverage.

## Entry Criteria

- Phase 4 text sessions work for pre-authenticated agents.
- Missing login produces structured status.
- First vendor smoke targets are chosen.

## Scope

- Surface ACP `authMethods`.
- Display vendor-specific login help.
- Invoke ACP `authenticate` where available and safe.
- Re-check or restart the ACP connection after login completion.
- Keep Phase 5A focused on non-terminal guided recovery:
  - external CLI/browser instructions;
  - ACP `authenticate` only when the method can run without granting file/terminal capabilities;
  - retry/restart after the user completes vendor login.
- Defer terminal-auth to Phase 6 or a Phase 6.5 follow-up after terminal policy is defined.
- Add smoke tests/checklists for real vendor commands:
  - Cursor Agent: `agent acp` or `cursor-agent acp`;
  - CodeBuddy Code: `codebuddy --acp`.
- Keep subscription ownership text visible throughout.

## Non-Goals

- No Director credential brokering.
- No generic provider switching.
- No file/terminal side-effect capabilities unless needed solely for auth and policy-approved.
- No guarantee that every vendor supports in-editor login.

## Implementation Tasks

1. Extend structured ACP auth-required status.
2. Map `authMethods` to UI choices.
3. Add vendor login help:
   - command to run externally;
   - account/subscription owner;
   - retry/restart instruction.
4. Define and implement safe `authenticate` call path:
   - user-triggered only;
   - timeout-bounded;
   - cancellable;
   - logs and errors redacted;
   - no silent browser, terminal, shell, or external-process launch unless the ACP method/vendor docs and UI prompt explicitly allow it;
   - clear fallback to "run the vendor CLI login externally" when in-editor auth is not supported.
5. Decide retry behavior:
   - retry `session/new`;
   - restart ACP connection;
   - ask user to retry manually.
6. Add terminal-auth design note for Phase 6/6.5:
   - required terminal capabilities;
   - permission copy;
   - cancellation and timeout behavior;
   - what is still unsupported in Phase 5A.
7. Add smoke-test checklist for each real vendor.
8. Add redaction tests for auth logs.

## Likely Files

- `src/vs/platform/agentHost/node/acp/**`
- `src/vs/sessions/contrib/providers/agentHost/browser/**`
- Workbench external agent settings/status UI.
- `doc/research/acp-agenthost/vendor-smoke-tests/**` if created later.

## Acceptance Criteria

- Missing login produces a VS Code-native auth-required state.
- UI says which vendor account/subscription is needed.
- Successful vendor login lets session creation continue or asks the user to retry/restart clearly.
- Failed auth does not leak tokens or raw env values.
- Smoke test results are recorded for Cursor/CodeBuddy or selected vendors.
- Terminal-auth is not required for Phase 5 acceptance and remains explicitly deferred.
- Any `authenticate` attempt is user-triggered, cancellable, timeout-bounded, and redacted.

## Validation

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
```

Manual smoke:

```powershell
agent acp
cursor-agent acp
codebuddy --acp
```

## Risks

- Vendor auth behavior can differ from ACP docs.
- Terminal auth may require capabilities intentionally disabled in earlier phases, so it must not become a hidden Phase 5 dependency.
- Users may think VS Code can manage the vendor subscription; copy must be precise.

## Handoff Output

- Guided login-required UI.
- Vendor smoke-test notes.
- Clear compatibility matrix for auth methods seen in tested agents.
- Explicit terminal-auth deferral/design note for Phase 6 or Phase 6.5.
