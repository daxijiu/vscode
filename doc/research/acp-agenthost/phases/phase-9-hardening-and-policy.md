# Phase 9 - Hardening And Policy

Updated: 2026-05-28

## Goal

Make ACP AgentHost support shippable inside this VS Code fork.

This phase focuses on policy, reliability, diagnostics, Windows behavior, local-desktop release criteria, and remote follow-up boundaries.

Until the product is ready for external release, ACP AgentHost support is an internal development/test feature. The feature is enabled by default for that internal use, with no ACP telemetry reporting.

## Entry Criteria

- Core runtime, UI, auth UX, side-effect bridges, registry, and optional capabilities have reached feature-complete status.
- Known vendor smoke targets are documented.
- Security-sensitive phases have focused tests.
- Earlier phases already have policy hooks for external agents, registry, managed install, and file/terminal capabilities.
- Local desktop process placement has already been decided; remote targets are documented as follow-up work.

## Scope

- Local desktop release matrix.
- Remote workspace behavior as a documented non-blocking follow-up.
- Windows command resolution and quoting.
- Process cleanup and crash recovery.
- Redacted diagnostics surface.
- Finalize and validate enterprise policy for:
  - external ACP agents;
  - registry access;
  - managed-install policy key/schema/copy for the deferred install path;
  - file/terminal capabilities.
- Telemetry boundaries.
- ACP telemetry disabled for internal development/testing.
- Documentation and troubleshooting.
- Release gate checklist.

## Non-Goals

- No new feature expansion.
- No provider switching.
- No new registry distribution type unless required for release.

## Implementation Tasks

1. Test Windows command resolution:
   - `.cmd`;
   - PATH;
   - spaces in paths;
   - workspace cwd.
2. Document remote workspace behavior as follow-up:
   - where process runs;
   - where config lives;
   - how cwd is resolved.
   - where registry install/cache lives;
   - how local vs remote policy is applied.
   - explicitly mark SSH/remote server, WSL, dev containers, and other remote targets as non-blocking for the first release unless later promoted.
3. Add crash recovery:
   - process exit during turn;
   - reconnect/restart;
   - user-visible failure.
4. Add diagnostics with an explicit allowlist/redaction schema:
	- default event type/status/duration only;
	- stderr availability, byte count, and line count only;
	- redacted protocol event summary;
	- no raw prompts, tool args, file contents, terminal output, env values, tokens, or secrets by default;
	- opt-in detailed local capture only with retention/export boundaries;
   - no telemetry upload for ACP runtime/process events during internal development/testing.
5. Verify enterprise policy gates added by earlier phases.
6. Add policy matrix tests:
   - external ACP disabled;
   - registry disabled;
   - managed-install policy key/schema/copy exists and does not enable an install path;
   - file/terminal capability disabled;
   - diagnostics available locally;
   - ACP telemetry disabled.
7. Finalize user docs and troubleshooting.
8. Define release checklist.

## Likely Files

- AgentHost node ACP runtime files.
- Workbench settings/registry UI.
- Policy/configuration contribution files.
- Documentation under `doc/`.
- Tests under AgentHost and Sessions areas.

## Acceptance Criteria

- Windows `.cmd`/PATH behavior is tested.
- First release supports local VS Code desktop with local workspace, local AgentHost process, and local pre-installed/pre-authenticated ACP CLI.
- Remote workspace behavior is documented as a follow-up and tested where feasible, but is not a first-release blocker.
- Local install, cache, config, cwd, and process-placement behavior is documented.
- External ACP execution can be disabled by policy.
- Registry can be disabled by policy.
- Managed-install policy key/schema/copy exists for the deferred install path and does not affect browse/manual-config-only behavior.
- File/terminal capabilities can be disabled by policy.
- Diagnostic logs are useful but redacted.
- Diagnostics have a documented allowlist/redaction schema and opt-in detailed capture boundary.
- ACP telemetry is disabled for internal development/testing.
- Policy defaults are validated before release; Phase 9 does not introduce first-time policy hooks for high-risk features.
- Final docs clearly explain that external ACP agents use their own subscription/account.

## Validation

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --grep acp
npm run test-node -- --grep agentHost
```

Manual validation:

- pre-authenticated fake ACP agent;
- pre-authenticated Cursor Agent if available;
- pre-authenticated CodeBuddy Code if available;
- local desktop with local workspace and local pre-installed ACP CLI;
- missing-login flow;
- policy-disabled external agents;
- policy-disabled registry;
- policy-disabled terminal/file capabilities.
- managed-install policy key/schema/copy present while no install path exists;
- local process placement;
- remote process placement documented as non-blocking follow-up;
- crash during active turn;
- diagnostics redaction sample export.
- ACP telemetry disabled.

## Risks

- Policy gaps can create enterprise adoption blockers.
- Diagnostics can leak sensitive prompts or environment values.
- Remote/local process placement may be surprising.
- Windows command handling is easy to regress.
- If policy hooks are added only in this phase, earlier feature work can accidentally ship unsafe defaults.

## Handoff Output

- Release-ready ACP AgentHost support.
- Policy documentation.
- Redacted diagnostics.
- Final validation checklist and known vendor compatibility notes.
- Local desktop placement matrix and remote follow-up notes.
- Diagnostics redaction schema.

## Recorded Decisions

- The first release matrix is local desktop only:
  - local VS Code desktop;
  - local workspace;
  - local AgentHost node process;
  - local config/cache/logs;
  - local pre-installed ACP CLI;
  - vendor login/subscription already present in that CLI.
- SSH/remote server, WSL, dev containers, Codespaces, and other remote targets are not first-release blockers.
- During internal development/testing, external ACP AgentHost support is enabled by default rather than hidden behind an experiment gate.
- ACP telemetry is off; do not upload ACP process/runtime failure events.

## Implementation Status

- 2026-05-28: Phase 9 implemented the first hardening/release-gate slice.
- Windows command resolution now has an ACP-owned resolver for absolute/relative commands, PATH/PATHEXT lookup, direct `.exe` spawn, explicit `.cmd`/`.bat` `cmd.exe /d /s /c` shim behavior, missing-command errors, and redacted command summaries.
- Local CWD handling is centralized: Phase 9 supports local file workspaces, fixed local CWD, or no CWD; remote/virtual workspaces fail with a clear message instead of being passed as ACP cwd.
- Diagnostics now use an allowlisted process diagnostic shape: event type, status, duration, exit code, signal, fixed stderr-available message, stderr byte/line counts, and command summary only. Raw stderr text is deferred to a future opt-in local capture mode with explicit retention/export boundaries.
- `externalAcpAgents.execution.enabled` gates snapshot registration, Test Connection, direct session creation, and runtime spawn. Registry browse remains browse-only, managed install remains disabled, and tools/files/terminal capability settings default false.
- Crash during an active prompt is covered by a fake fixture test: the active turn receives a single redacted terminal error and the child process exits cleanly.
- Release checklist, troubleshooting, local/remote matrix, and diagnostics schema are recorded in [ACP AgentHost Release Gate](../acp-agenthost-release-gate.md).

## Deferred After Phase 9

- Enterprise policy metadata beyond settings-level gates.
- Vendor-side delete/archive.
- Managed install, package manager execution, downloads, or extraction.
- Real filesystem, terminal, or tool execution.
- Remote AgentHost/runtime placement for SSH, WSL, dev containers, Codespaces, or remote server.
- Director Provider Backend, Copilot CAPI, or credential bridge integration.
