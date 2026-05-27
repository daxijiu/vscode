# ACP AgentHost Roadmap

Updated: 2026-05-28

## Product Anchor

ACP support means: **supported ACP agents reuse their own subscription, login, billing, and model routing, while VS Code adapts their interaction into the native AgentHost / Agent Sessions UI.**

This roadmap deliberately does not include generic switching from third-party ACP agents to Director Providers. Director Providers remain for Director. ACP agents remain external agent runtimes.

## Roadmap Overview

| Phase | Name | Primary Outcome | Difficulty | Dependency |
| --- | --- | --- | --- | --- |
| 0 | [Boundary And UX Contract](./phases/phase-0-boundary-and-ux-contract.md) | Architecture, subscription ownership wording, and safety gates are accepted. | Low | Current research |
| 1 | [Manual ACP Agent Configuration](./phases/phase-1-manual-acp-agent-configuration.md) | A basic External ACP Agents management page can add/edit/remove/enable manual agents and emit secret-free config. | Low-medium | Phase 0 |
| 2 | [ACP Runtime Skeleton](./phases/phase-2-acp-runtime-skeleton.md) | AgentHost can launch, initialize, timeout, and dispose a fake/manual ACP process. | Medium | Phase 1 |
| 3 | [Agent List And Subscription State](./phases/phase-3-agent-list-and-subscription-state.md) | Enabled ACP agents appear in the existing VS Code agent list with vendor-owned subscription/login status. | Medium | Phase 2 |
| 4 | [Basic Text Session](./phases/phase-4-basic-text-session.md) | A pre-authenticated ACP agent can create a session, send a prompt, and stream text/reasoning in Agent Sessions UI. | Medium-high | Phase 3 |
| 5 | [Vendor Login UX And Smoke Tests](./phases/phase-5-vendor-login-ux-and-smoke-tests.md) | Missing-login flows become guided and recoverable; real vendor commands are smoke-tested. | Medium-high | Phase 4 |
| 6 | [Tools, Permissions, Files, Terminal](./phases/phase-6-tools-permissions-files-terminal.md) | ACP side effects are mediated by native AgentHost permission/tool/file/terminal UI. | High | Phase 5 |
| 7 | [Registry Browse And Managed Enablement](./phases/phase-7-registry-browse-and-managed-enablement.md) | Users can browse registry agents and create disabled drafts; managed install remains deferred design. | High/security | Phase 7A can run after Phase 3; Phase 7B deferred |
| 8 | [Models, Modes, Config, Restore](./phases/phase-8-models-modes-config-restore.md) | Optional ACP capabilities are surfaced when supported; restore is staged behind feasibility and identity checks. | High | Phase 8A after Phase 5; restore/reconnect parts after Phase 6 |
| 9 | [Hardening And Policy](./phases/phase-9-hardening-and-policy.md) | Enterprise policy, redacted diagnostics, remote/Windows behavior, and release criteria are complete. | High | All prior phases |

## Phase 0 - Boundary And UX Contract

Goal: make the product contract unambiguous before implementation begins.

Scope:

- Write an ADR stating ACP is an AgentHost runtime adapter, not a Director Provider Backend.
- Accepted ADR: [ACP Agents As AgentHost Runtime Adapters](./acp-agenthost-adr.md).
- Define product wording for external subscription ownership.
- Define non-goal: no generic third-party ACP agent to Director Provider switching.
- Decide where external ACP settings live: neutral "External ACP Agents" / "Agent Providers" surface is preferred.
- Decide that the basic management page belongs to Phase 1; registry browse/install belongs to Phase 7.
- Decide config apply behavior: restart/reconnect prompt for the first slice, or explicit dynamic provider reconcile.
- Record protocol implementation strategy.
- First-version default is internal JSON-RPC/local DTOs; SDK adoption is deferred pending dependency/bundling review.
- Decide the first real smoke-test agents.

Acceptance:

- Roadmap and ADR agree that ACP agents use vendor-owned subscriptions.
- UI copy examples exist for at least Cursor Agent and CodeBuddy Code.
- Security review has an initial stance on file/terminal capabilities being disabled until later phases.
- The ADR records internal JSON-RPC/local DTOs, restart/reconnect config apply behavior, External ACP Agents management boundaries, process/log safety, and first smoke targets.

Suggested validation:

```powershell
git diff --check -- doc/research/acp-agenthost
```

## Phase 1 - Manual ACP Agent Configuration

Goal: represent ACP agents as explicit user-enabled config without running registry install yet.

Scope:

- Add a Workbench-owned External ACP Agents management page for manually configured ACP agents.
- Store command, args, cwd policy, display name, vendor/subscription label, enabled flag, allowed capabilities, and trust state.
- Use secret references or env variable names only; do not store raw secrets in JSON snapshots.
- Write a secret-free ACP config snapshot for AgentHost consumption.
- Render the management page from config only; do not launch external commands merely to show status.
- First-version storage/cwd behavior is local desktop/local workspace; remote behavior is follow-up.
- Show pending restart/reconnect requirement if snapshot and live AgentHost state can diverge.
- Keep registry discovery and package install out of this phase.

Likely code areas:

- `src/vs/workbench/contrib/directorCode/**` only if reusing current Director settings shell;
- preferably a neutral future `src/vs/workbench/contrib/agentProviders/**` or similar;
- `src/vs/platform/agentHost/common/**` for shared snapshot DTOs.

Acceptance:

- A manually configured agent can be enabled/disabled.
- Snapshot contains no raw API keys, bearer tokens, or OAuth tokens.
- Multi-root cwd behavior has an explicit policy.

Implementation status:

- 2026-05-27: implemented the first manual-config skeleton with a neutral `agentProviders` Workbench service/UI, `externalAcpAgents.openSettings`, and a secret-free snapshot for later AgentHost runtime consumption.
- This implementation intentionally does not register live AgentHost providers, launch ACP commands, probe login state, run JSON-RPC, or reuse Director Provider Backend credentials.

Difficulty: low-medium.

## Phase 2 - ACP Runtime Skeleton

Goal: create the AgentHost node runtime foundation without UI complexity.

Scope:

- Add `src/vs/platform/agentHost/node/acp/**`.
- Implement ACP v1 stdio JSON-RPC framing.
- Spawn and dispose an ACP process from a manual config.
- Resolve runtime env/secret references only at process launch, never into snapshots/logs.
- Call `initialize`.
- Detect auth-required errors and return a structured status, but do not build full login UI yet.
- Implement request timeout and process kill/dispose cleanup.
- Build a deterministic fake ACP agent fixture for tests.
- Do not advertise file, terminal, or write capabilities yet.

Likely code areas:

- `src/vs/platform/agentHost/node/acp/acpConnection.ts`
- `src/vs/platform/agentHost/node/acp/acpProcess.ts`
- `src/vs/platform/agentHost/node/acp/acpProtocol.ts`
- `src/vs/platform/agentHost/test/node/acp/**`

Acceptance:

- Fake ACP process initializes successfully.
- Broken JSON/protocol exit paths fail clearly and dispose process handles.
- Cancel/dispose does not leave a child process running.
- No prompt/file/secret data is logged by default.

Implementation status:

- 2026-05-27: implemented AgentHost node ACP runtime primitives under `src/vs/platform/agentHost/node/acp/**` with internal ACP v1 JSON-RPC DTOs, line-based stdio request tracking, structured redacted errors, launch-time runtime env resolution, shell-free process launch, initialize, timeout, dispose/kill, and diagnostics.
- Added deterministic fake ACP agent tests for initialize success, unsupported protocol versions, auth-required errors, malformed JSON, request timeout, pending-request disposal, process exit cleanup, process-not-found handling, missing env/secret references, and stderr secret redaction.
- This phase intentionally does not register an `IAgent` provider, read registry metadata, run package managers, advertise file/terminal/write/tool capabilities, or call Director/Copilot backend code.

Difficulty: medium.

Suggested validation:

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
```

## Phase 3 - Agent List And Subscription State

Goal: make enabled ACP agents visible as native VS Code agents.

Scope:

- Register one `AcpAgent` `IAgent` provider per enabled ACP config.
- Implement the complete `IAgent` skeleton with explicit unsupported/no-op behavior for later-phase methods.
- Normalize provider ids, for example `acp-cursor`, `acp-codebuddy-code`.
- Publish descriptor/model placeholder state through AgentHost root state.
- Adapt Agent Sessions labels/descriptions so users understand external subscription ownership.
- Show auth/subscription state in creation flow or agent details.
- Do not launch third-party ACP commands just to render the agent list.
- Missing-login status can only come from cached explicit actions such as createSession/Test Connection/runtime error.
- Subscription label must be visible in the session creation or agent detail path; descriptor-only metadata is not enough unless rendered.
- Follow the Phase 1 config apply policy: restart/reconnect prompt or explicit dynamic provider reconcile.

Likely code areas:

- `src/vs/platform/agentHost/node/acp/acpAgent.ts`
- `src/vs/platform/agentHost/node/agentHostMain.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- `src/vs/platform/agentHost/node/agentSideEffects.ts`
- `src/vs/sessions/contrib/providers/agentHost/browser/**` if the current UI needs label/detail support.

Acceptance:

- Enabled ACP agents appear in the existing Agent Sessions agent list.
- UI text makes clear that the agent uses its own subscription/account.
- Disabled/untrusted ACP agents do not appear.
- Provider id works with `AgentSession.uri`.
- Unsupported `IAgent` methods do not crash visible agent-list or session-creation UI paths.

Implementation status:

- 2026-05-27: implemented AgentHost startup/reconnect snapshot registration for enabled, trusted, valid manual External ACP Agents using stable `acp-*` provider ids, duplicate/invalid-entry skip warnings, and an `AcpAgent` `IAgent` skeleton.
- The skeleton publishes external subscription/account wording through the provider descriptor and a placeholder ACP runtime model, while `createSession`, `sendMessage`, and model changes remain explicit Phase 4/8 unsupported paths.
- Agent Sessions now carries AgentHost root `AgentInfo.description` into session type descriptions and renders it as picker detail text, so "uses your vendor subscription/account" copy is visible without polluting the label.
- This phase intentionally does not call `AcpProcess.initialize()`, launch third-party CLIs, probe login state, watch snapshots, dynamically unregister providers, connect Director Provider Backend, or use Copilot CAPI.

Difficulty: medium.

## Phase 4 - Basic Text Session

Goal: deliver the first end-to-end usable ACP chat turn through native VS Code UI.

Scope:

- Assume the target real vendor agent is already logged in before the session starts.
- Implement `IAgent.createSession` against ACP `session/new`.
- Implement `IAgent.sendMessage` against ACP `session/prompt`.
- Map text chunks and reasoning/thought chunks into AgentHost session actions.
- Map completion/cancel/error stop reasons.
- Treat unexpected tool updates as unsupported during the text-only milestone; do not execute tools or hang waiting for tool results.
- Enforce one terminal action per turn and absorb late updates after cancel/complete/error.
- Preserve enough transcript state for the in-memory session view.
- If the agent reports auth-required or missing login, stop cleanly and show a clear VS Code-native message telling the user to log in with that vendor's CLI/account flow.
- Keep tools, file writes, and terminal disabled.

Likely code areas:

- `src/vs/platform/agentHost/node/acp/acpAgent.ts`
- `src/vs/platform/agentHost/node/acp/acpAgentSession.ts`
- `src/vs/platform/agentHost/node/acp/acpSessionUpdateMapper.ts`
- AgentHost session action tests.

Acceptance:

- User can create an ACP session from the normal Agent Sessions UI.
- User can send a text prompt and see streamed text.
- If the selected agent is not logged in, the turn/session fails with an actionable login-required message rather than a generic protocol error.
- Cancel marks the turn cancelled and tells the ACP agent to stop.
- Cancel races and late updates cannot emit duplicate terminal actions.
- Unexpected tool calls in text-only mode produce a clear unsupported-capability result/error.
- Errors are visible, actionable, and redacted.

Difficulty: medium-high.

Suggested validation:

```powershell
npm run compile-check-ts-native
npm run test-node -- --grep acp
npm run test-node -- --grep agentHost
```

## Phase 5 - Vendor Login UX And Smoke Tests

Goal: improve the missing-login path after the first milestone, without changing the subscription boundary.

Scope:

- Surface ACP `authMethods`.
- Turn Phase 4's login-required message into a guided recovery flow.
- Handle auth-required during initialize/session creation with vendor-specific help text.
- Invoke ACP `authenticate` where available and safe.
- Treat safe `authenticate` as user-triggered, cancellable, timeout-bounded, redacted, and unable to launch browser/terminal/external commands silently.
- Defer terminal-auth until Phase 6 or a Phase 6.5 follow-up, after terminal policy is defined.
- Add user-facing status for "uses Cursor subscription", "uses CodeBuddy account", etc.
- Re-check or restart the ACP connection after the user completes vendor login.
- Smoke-test first real vendor commands.

Candidate smoke targets:

- Cursor Agent: `agent acp` or `cursor-agent acp`.
- CodeBuddy Code: `codebuddy --acp`.
- One deterministic fake ACP agent for automated tests.

Acceptance:

- Missing login produces a clear VS Code-native auth-required state.
- Successful vendor login lets session creation continue or clearly asks the user to retry/restart the agent.
- UI does not imply VS Code, Director, or Copilot owns the external subscription.
- Logs do not expose auth tokens or API keys.
- Terminal-auth is not required for Phase 5 acceptance.

Implementation status:

- 2026-05-28: implemented the Phase 5A guided recovery slice with ACP `authenticate`, redacted auth method retention, vendor-owned auth-required copy, cached login/test status, explicit Copy Login Command/Open Login Help/Clear Login Status/Test or Retry Connection actions, and Cursor/CodeBuddy smoke checklist docs.
- Test Connection is user-triggered only, enabled + trusted gated, timeout-bounded, prompt-free, and disposes the ACP process. Render/refresh/AgentHost registration/picker paths remain no-probe.
- Terminal-auth, tools/files/terminal, model/mode switching, registry install, session restore, Director Provider Backend, and Copilot CAPI remain out of scope.

Difficulty: medium-high.

## Phase 6 - Tools, Permissions, Files, Terminal

Goal: safely expose ACP side-effect capabilities through native VS Code controls.

Scope:

- Map ACP permission requests into AgentHost permission UI.
- Map ACP tool calls/progress into AgentHost tool UI.
- Add file read with workspace containment.
- Add file write only through permission and edit/changeset UI.
- Add terminal create/output/wait/kill only through AgentHost terminal policy.
- Cancel pending permission requests when a turn is cancelled.
- Keep capabilities configurable per ACP agent.
- Add policy hooks for disabling ACP file, terminal, and tool capabilities before they are advertised.
- Resolve capability flags before ACP `initialize`.
- Require reconnect/re-initialize after capability changes unless a tested dynamic protocol path exists.

Acceptance:

- No ACP file write can bypass workspace containment and permission gates.
- No ACP terminal command can run without the intended terminal policy path.
- Rejected permissions return valid ACP responses and do not hang the turn.
- Tool calls have complete lifecycle states in the UI.
- Turn cancellation responds to pending ACP permission requests with explicit denied/cancelled results.
- Live capability toggles require reconnect/re-initialize before new file/terminal/tool capabilities are advertised.
- Policy-disabled file/terminal/tool capabilities are not advertised and cannot execute side effects.

Implementation status:

- 2026-05-28: Phase 6A implemented the safe skeleton: capability negotiation is policy-gated and disabled by default for file write, terminal execution, and tool metadata; `session/request_permission` returns valid deny/cancel outcomes without side effects; ACP tool lifecycle updates are projected into AgentHost tool UI actions with redacted unsupported markers.
- Real filesystem read/write, terminal execution/auth, MCP bridge, and actual tool invocation remain deferred to later Phase 6 slices.

Difficulty: high.

## Phase 7 - Registry Browse And Managed Enablement

Goal: move from manual config to trust-gated discovery and enablement.

Scope:

- Fetch ACP registry metadata.
- Display registry agents, versions, descriptions, icons, auth method hints, and distribution type.
- In browse-only mode, registry entries can create only disabled config drafts.
- First version is browse/manual-config-only and performs no automatic install.
- First-version required work is Phase 7A only: local registry-shaped catalog, browse UI, disabled drafts, Phase 1 manual enablement path, a registry browse settings skeleton, and managed-install settings/copy that keeps install unavailable.
- Registry-derived drafts can be enabled only through the Phase 1 manual review/edit/enable/trust path.
- Keep managed install as Phase 7B deferred design until trust gates, supply-chain proof, policy gates, and local/remote install placement are designed.
- Deferred Phase 7B design covers binary, NPX, UVX, install cache, version pinning, and enterprise disable controls.
- Deferred managed-install design blocks unverifiable entries unless an approved local allowlist covers them.

Acceptance:

- Users can browse registry entries without executing anything.
- Registry-derived drafts remain disabled until the user completes Phase 1 manual review/edit/enable/trust.
- Version pins are visible.
- No silent execution of remote binary/package metadata.
- Browse-only cannot write enabled config.
- Deferred managed install requires an accepted integrity/pin strategy before it can be implemented.
- No managed install distribution type is enabled in the first version.
- First-version tests do not require install confirmation, distribution handlers, or install cache.

Implementation status:

- 2026-05-28: implemented Phase 7A as local-only registry browse plus disabled drafts. The bundled catalog is registry-shaped but does not fetch from the network, run installers, probe login state, or report telemetry. Registry drafts are disabled/untrusted, excluded from AgentHost snapshots, and must be reviewed before they can enter the ordinary manual enable/trust flow. The Phase 7A controls are ordinary settings skeletons; managed install and enterprise policy metadata remain deferred.

Difficulty: high/security.

## Phase 8 - Models, Modes, Config, Restore

Goal: surface optional ACP capabilities without assuming all agents support them.

Scope:

- Map agent-reported models into AgentHost models when available.
- Surface modes/config options only when capabilities provide them.
- Gate unstable set-model behavior.
- Implement session list/load/resume only when capability-proven; delete/archive remains VS Code-local only.
- Support restore as an eventual goal through staged feasibility and vendor-gated rollout.
- Define restore transcript ownership and VS Code URI / ACP session id / vendor restore id mapping during Phase 8A before exposing restore UI.
- Record per-vendor compatibility notes.

Acceptance:

- Unsupported capabilities are hidden or explicitly marked unavailable.
- Model/mode changes never call unsupported ACP methods.
- Session restore is tested per vendor before being presented as reliable.
- Restored sessions either produce trustworthy `getSessionMessages` output or clearly show partial/unavailable history.
- Broad restore UI stays hidden until at least one vendor/protocol path passes feasibility and identity mapping tests.

Difficulty: high.

## Phase 9 - Hardening And Policy

Goal: make the feature shippable inside this fork.

Scope:

- First-release local desktop behavior.
- Remote workspace behavior as non-blocking follow-up.
- Windows command resolution and quoting.
- Process cleanup and crash recovery.
- Redacted diagnostics surface.
- Validate enterprise policy hooks already added for external agents and file/terminal capabilities; add or validate future registry/managed-install enterprise policy metadata after it is designed.
- ACP telemetry disabled during internal development/testing.
- Documentation and troubleshooting.
- Local desktop process, config, cache, install, and cwd placement matrix.
- Remote target follow-up notes for SSH/remote server, WSL, dev containers, and Codespaces.
- Diagnostics allowlist/redaction schema with opt-in detailed capture boundaries.

Acceptance:

- Windows `.cmd`/PATH behavior is tested.
- First release supports local VS Code desktop, local workspace, local AgentHost process, local config/cache/logs, and local pre-installed/pre-authenticated ACP CLI.
- External process execution can be disabled by policy.
- Diagnostic logs are useful but redacted.
- Final docs clearly explain that external ACP agents use their own subscription/account.
- Phase 9 does not introduce first-time policy hooks for high-risk capabilities; it validates and finalizes them.
- Remote targets are documented but are not first-release blockers unless later promoted.
- External ACP AgentHost support is enabled by default for internal development/testing.
- Delete/archive remains VS Code-local only unless vendor-side delete is separately approved later.

Implementation status:

- 2026-05-28: Phase 8A implemented optional capability display and restore feasibility audit plumbing. ACP `initialize` capability metadata is now conservatively normalized for explicit model lists, modes/session config schema, static config completions, and restore/list/load indicators. AgentHost keeps the placeholder `external-acp-runtime` model until a successful explicit `createSession` returns a trustworthy model list; unsupported model changes, vendor restore/list/load, visible restore UI, and vendor-side delete/archive remain deferred.
- Restore feasibility after 8A: the host can remember advertised restore/list/load indicators for audit purposes, but `listSessions()` remains local in-memory only, no ACP restore method is called, no transcript identity mapping is trusted yet, and no visible restore/list/load/resume UI is exposed.

Difficulty: high.

## Recommended First Milestone

The first milestone should combine Phases 0-4 only:

```text
Manual ACP command -> AgentHost provider appears in UI -> pre-authenticated session -> send text prompt -> stream text -> cancel/dispose cleanly.
```

This milestone proves the architecture and UI path while avoiding the highest-risk surfaces: full login orchestration, registry install, file writes, terminal execution, tool calls, and generic provider switching. If the selected real vendor agent is not logged in, the milestone only needs to show a clear vendor-login-required message.

## Roadmap Guardrails

- Do not use Copilot CAPI for ACP agents.
- Do not pass Director Provider credentials to third-party ACP agents.
- Do not add a custom ACP chat webview.
- Do not enable file/terminal capabilities in the first text-turn milestone.
- Do not treat registry metadata as trusted executable content.
- Do not promise session restore or model switching unless the active agent advertises and passes those capabilities.
