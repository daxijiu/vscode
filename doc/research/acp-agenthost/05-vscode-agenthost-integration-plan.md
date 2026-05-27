# VS Code AgentHost ACP Integration Plan

Updated: 2026-05-27

## Decision Summary

ACP should be implemented as an optional AgentHost runtime adapter. Each enabled ACP agent should appear in the existing Agent Sessions agent list as an `IAgent` provider.

The re-anchored product goal is: **all supported ACP agents reuse their own existing subscription, login, billing, and model routing**. VS Code is the host UI and lifecycle manager, not the model-provider broker for those agents.

Provider switching between third-party ACP agents and Director Providers is out of scope for this workstream. Difficulty and implementation planning should therefore focus on native VS Code UI adaptation, AgentHost event mapping, external process lifecycle, auth-state display, permission mediation, and logs/debugging.

## Current Fork Anchors

Current AgentHost already has the right extension point:

- `src/vs/platform/agentHost/common/agentService.ts`
  - `IAgent` owns provider identity, session creation, message sending, session restore, cancel, model change, permission/user-input responses, auth hooks, models, and customizations.
- `src/vs/platform/agentHost/node/agentHostMain.ts`
  - registers Copilot always;
  - registers Claude when `VSCODE_AGENT_HOST_CLAUDE_SDK_PATH` is set;
  - registers Director when `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT` is set.
- `src/vs/platform/agentHost/node/agentSideEffects.ts`
  - publishes provider descriptors/models into root `AgentInfo`.
- `src/vs/platform/agentHost/common/state/protocol/channels-root/state.ts`
  - root state carries `agents: AgentInfo[]`.
- `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`
  - maps root `AgentInfo` providers into visible session types.
- `src/vs/platform/agentHost/node/director/directorAgent.ts`
  - current Director `IAgent` example.
- `src/vs/sessions/contrib/providers/agentHost/browser/directorRuntimeCredentialBridge.ts`
  - current narrow reverse-IPC secret bridge for Director credentials.

This means adding ACP agents does not require inventing a new chat UI. It requires publishing new `IAgent` providers and translating ACP sessions into AgentHost session actions.

## Target Architecture

```text
Workbench External ACP Agents management UI
        |
secret-free ACP agent config snapshot
        |
AgentHost node ACP agent manager
        |
one AcpAgentProvider per enabled agent
        |
ACP process + JSON-RPC stdio connection
        |
external ACP agent process
        |
vendor-owned subscription/login/model/runtime
```

The snapshot should contain command metadata but not secrets:

- id;
- display name;
- command path;
- args;
- cwd policy;
- env variable names or secret references, not raw secret values;
- enabled flag;
- install source;
- version/pin;
- allowed capabilities;
- trust state.

Runtime secret/env resolution should be explicit, redacted, and isolated from Director provider credentials. For this workstream, ACP agent credentials remain vendor-owned.

## Provider Identity

Each installed ACP agent should become its own provider so it appears naturally in the Agent Sessions agent list.

Suggested provider id form:

```text
acp-cursor
acp-codebuddy-code
acp-codex
acp-claude
```

Avoid provider ids that are invalid URI schemes or awkward for `AgentSession.uri`. Dots and arbitrary registry ids should be normalized.

The `IAgentDescriptor` should carry:

- provider id;
- display name, for example `Cursor Agent` or `CodeBuddy Code`;
- description that makes external ownership clear.

## Basic Flow

```text
enabled ACP config
        |
AgentHost registers AcpAgent(providerId)
        |
AgentInfo appears in root state
        |
Agent Sessions UI shows the agent
        |
user creates session
        |
AcpAgent resolves cwd/env
        |
spawn ACP process
        |
initialize
        |
auth if needed
        |
session/new
        |
session/prompt
        |
session/update -> AgentHost actions
```

## VS Code UI Adaptation Targets

ACP should not create a parallel chat product surface. The implementation should adapt external-agent behavior into existing VS Code UI:

| UI surface | Expected adaptation | Difficulty |
| --- | --- | --- |
| Agent list | Each enabled ACP agent appears as a selectable AgentHost session type. | Low-medium |
| New session | Session creation uses selected workspace cwd, configured command, and agent-reported defaults. | Medium |
| Subscription/login state | Show "uses Cursor/CodeBuddy/etc. subscription" and auth-required state without implying VS Code owns the subscription. | Medium-high |
| Model/mode display | Display agent-reported models/modes when capabilities expose them; otherwise show vendor-managed/default state. | Medium |
| Streaming response | Map ACP text/thought/tool/status updates into AgentHost session actions for pre-authenticated agents. | Medium-high |
| Tool calls | Render tool calls and progress in existing AgentHost tool UI. | High |
| Permissions | Route ACP permission requests through AgentHost permission UI. | High |
| File edits | Route file writes through workspace containment, changeset/edit UI, and permission gates. | High |
| Terminal | Route terminal create/output/wait/kill through AgentHost terminal UI and policy gates. | High |
| Logs/debug | Provide redacted ACP stderr/protocol diagnostics without dumping prompts/secrets by default. | Medium-high |

The UI work is therefore not mainly visual polish. It is a semantic adaptation from ACP's protocol events to VS Code's existing AgentHost session, permission, tool, terminal, and settings surfaces.

## ACP To AgentHost Mapping

Initial mapping targets:

| ACP concept | AgentHost target |
| --- | --- |
| `initialize` agent info | `IAgentDescriptor`, `models`, capabilities |
| `session/new` result | `IAgentCreateSessionResult` |
| `session/prompt` | `IAgent.sendMessage` implementation |
| assistant text chunk | `SessionResponsePart` + `SessionDelta` |
| thought/reasoning chunk | `SessionReasoning` / reasoning response part |
| tool call start/update | AgentHost tool action/progress |
| permission request | AgentHost permission request plumbing |
| terminal output | AgentHost terminal channel/action, gated |
| file read/write request | AgentHost file service/changeset path, gated |
| usage | AgentHost usage action |
| stop reason | complete/cancel/error terminal action |
| `session/cancel` | `abortSession` |
| mode/config changes | AgentHost session config/mode surface, capability-gated |

The first slice should support text streaming and cancellation for pre-authenticated agents. If a real vendor agent is not logged in, the first slice only needs to show an actionable login-required message. Richer login UX, terminal auth, tool calls, terminal, and file writes should be separate phases.

The `AcpAgent` provider still needs to implement the complete `IAgent` interface from the beginning. Methods outside the active phase should have deterministic unsupported/no-op semantics rather than visible `TODO` failures. In particular, list/restore, model change, permission/user-input responses, client tools, customizations, and authenticate should be stubbed deliberately until their owning phases replace them.

## Subscription And Auth Strategy

### Goal

Use the ACP agent's own subscription and login state.

Examples:

- Cursor Agent uses Cursor login or Cursor API key.
- CodeBuddy uses CodeBuddy login/API key/environment.
- Claude ACP wrapper uses Claude Code/Anthropic-side auth.
- Codex ACP uses its own configured auth path.

VS Code should expose a clear auth-required state and invoke ACP `authenticate` or terminal auth when supported. It should also label subscription ownership clearly, for example:

```text
Cursor Agent - uses your Cursor subscription
CodeBuddy Code - uses your CodeBuddy account
Claude ACP - uses your Claude Code / Anthropic-side auth
```

It should not broker Director secrets to ACP agents.

Initial milestone policy:

- assume real vendor agents are already logged in;
- if login is missing, show a clear vendor-login-required message;
- defer guided login, terminal auth, and auth retry/restart flows to the later auth UX phase.
- in the later auth UX phase, `authenticate` must be user-triggered, cancellable, timeout-bounded, redacted, and unable to launch browser/terminal/external commands silently;
- terminal-auth remains deferred until terminal policy is defined.

### Non-Goal: Generic Provider Switching

The following is explicitly out of scope for the ACP integration workstream:

```text
Switch arbitrary third-party ACP agents between their own subscription and Director Providers.
```

If a future agent-specific integration supports custom env/model configuration, it should be planned as a separate, opt-in task. It should not block or shape the main ACP UI integration.

## Recommended Phases

### Phase A - Research And ADR

Deliverables:

- these research notes;
- architecture decision record;
- explicit subscription/auth/security boundary;
- list of first target agents.

Acceptance:

- consensus that ACP is an AgentHost runtime adapter, not a Director Provider Backend type;
- consensus that ACP agents reuse their own subscriptions.

### Phase B - ACP Runtime Skeleton

Scope:

- `src/vs/platform/agentHost/node/acp/**`;
- v1 stdio JSON-RPC;
- process spawn/dispose;
- initialize;
- auth-required detection;
- request timeout and process cleanup;
- stderr logging with redaction;
- fake ACP agent tests.

No registry install. No file/terminal capabilities yet.

First-version protocol implementation defaults to internal ACP JSON-RPC framing and local DTOs. `@agentclientprotocol/sdk` can be reconsidered later if dependency and bundling policy accepts it.

Difficulty: medium.

### Phase C - Manual Agent Management And Agent List

Scope:

- Phase 1 owns the first neutral `External ACP Agents` management page;
- the management page supports manual add/edit/remove/enable/trust and subscription labels;
- the management page renders from config only and must not eager-launch third-party ACP commands;
- secret-free snapshot into AgentHost;
- snapshot state and live AgentHost state may differ until restart/reconnect unless dynamic reconcile is implemented;
- runtime env/secret references are resolved only at process launch and never written back to snapshots/logs;
- Phase 3 registers one `AcpAgent` per enabled config;
- `AcpAgent` implements the full `IAgent` skeleton with explicit unsupported/no-op behavior for later phases;
- config changes either require AgentHost restart/reconnect or use an explicit dynamic provider reconcile path;
- provider ids normalized from config;
- agents visible in existing Agent Sessions UI with subscription/account wording;
- missing-login state comes only from cached explicit actions, not background probing.

Difficulty: low-medium.

### Phase D - Streaming Turn Mapping

Scope:

- map ACP text/reasoning/session updates into AgentHost actions;
- complete/cancel/error terminal actions;
- preserve final transcript;
- downgrade unexpected `tool_call` / `tool_call_update` notifications into a clear unsupported-capability result/error while text-only;
- enforce exactly one terminal action per turn, even under cancel races and late updates;
- tests for ordering, cancellation, unexpected tool updates, and single terminal action.

Difficulty: medium-high.

### Phase E - Auth UX

Scope:

- display auth-required and subscription-owned states;
- upgrade the initial login-required message into guided vendor login recovery;
- call ACP `authenticate` where available and safe;
- support terminal auth only after terminal policy is defined, likely in Phase 6 or a Phase 6.5 follow-up;
- expose "vendor login required" help;
- redacted logs.

Difficulty: medium-high.

### Phase F - Permission/File/Terminal Bridge

Scope:

- permission request UI through AgentHost;
- file read/write gated and workspace-contained;
- terminal create/output/wait/kill gated and auditable;
- cancellation cleanup.
- capability flags resolved before ACP `initialize`;
- capability changes require reconnect/re-initialize unless a tested dynamic protocol path exists;
- pending permission cancellation returns a valid ACP denied/cancelled response.

Difficulty: high.

### Phase G - Registry Browse And Managed Install

Scope:

- fetch registry;
- show known agents;
- browse-only can create only disabled config drafts;
- first version is browse/manual-config-only with no automatic install;
- install/remove only after trust, policy, supply-chain proof, and local/remote placement rules are accepted in a later phase;
- binary/NPX/UVX handling;
- version pinning;
- trust prompts;
- enterprise policy;
- cache cleanup;
- checksum/signature strategy if available or local allowlist if not.
- first version includes only managed-install policy key/schema/copy; it does not include a managed-install execution path.
- deferred managed install remains unavailable for unverifiable entries unless explicitly allowed through an approved local allowlist.
- in the first version, unverifiable entries can only become disabled drafts/manual configs.

Difficulty: high/security.

### Phase H - Models, Modes, Config, Restore

Scope:

- map ACP-reported models into AgentHost models;
- support stable mode/config APIs;
- gate unstable set-model behavior;
- session list/load/resume is an eventual goal, split into feasibility audit and vendor-gated restore before broad UI exposure;
- delete/archive is VS Code-local only; vendor-side delete is a later separately approved capability;
- vendor smoke tests.

Difficulty: high.

### Phase I - UI Polish, Diagnostics, And Vendor Smoke Tests

Scope:

- polish agent badges/labels/help text for subscription ownership;
- add redacted ACP diagnostics and failure explanations;
- validate policy hooks added by earlier phases rather than introducing high-risk policy for the first time;
- validate first-release local desktop process, config, cache, no-install, and cwd placement;
- document SSH/remote server, WSL, dev containers, and other remote targets as non-blocking follow-up unless later promoted;
- keep ACP telemetry disabled during internal development/testing;
- document diagnostics allowlist/redaction schema and opt-in detailed capture boundaries;
- run smoke tests against first real vendor agents;
- document per-agent known capabilities and gaps.

Difficulty: medium-high.

## Difficulty Summary

| Outcome | Difficulty | Confidence |
| --- | --- | --- |
| Show manually configured ACP agents in Agent Sessions list | Low-medium | High |
| Send a basic prompt to a local ACP agent and show text output | Medium | High |
| Initial login-required prompt for missing vendor login | Low-medium | High |
| Guided auth-required flow using the agent's own subscription/login | Medium-high | Medium |
| Tool call rendering and permission mediation | High | Medium |
| File write and terminal proxy support | High | Medium |
| Registry browse/manual drafts | Medium-high/security | Medium |
| Deferred managed install | High/security | Medium |
| Session restore across agents | High | Low-medium |
| Subscription/login state display for external agents | Medium-high | Medium |
| Native VS Code UI adaptation for tools/files/terminal | High | Medium |

## Decisions And Open Items

1. Should ACP live under `src/vs/platform/agentHost/node/acp/**` or under `src/vs/platform/agentHost/node/director/acp/**`?
   - Recommendation: `node/acp/**` because ACP is broader than Director.

2. Should Workbench ACP settings live in Director Settings or a neutral Agent Providers page?
   - Recommendation: neutral "External ACP Agents" / "Agent Providers" management page, with Director linking to it. The basic management page belongs to Phase 1; registry browse/install belongs to Phase 7.

3. Should initial client capabilities include file/terminal?
   - Recommendation: no. Start with text/auth/cancel, then add file/terminal behind policy gates.

4. Should registry install be in the first implementation?
   - Recommendation: no. Manual command first.

5. Should `@agentclientprotocol/sdk` be adopted as a dependency?
   - Decision: first version uses a small internal JSON-RPC adapter plus local DTOs. SDK adoption is deferred until VS Code dependency/bundling policy explicitly accepts it.

6. What is the first target agent?
   - Recommendation: choose one local deterministic/fake ACP agent for tests, then one real vendor command such as Cursor Agent or CodeBuddy only for manual smoke validation.

7. How should subscription ownership be shown?
   - Recommendation: each external ACP agent row/session should explicitly say it uses that vendor's own subscription/login. Avoid "Provider" language where users could confuse it with Director Providers.

8. Should Phase 7 ship managed install or browse/manual-config-only first?
   - Decision: browse/manual-config-only first. No automatic install in the first version. No managed install distribution type is enabled initially.

9. Should Phase 8 expose session restore in the first optional-capabilities slice?
   - Direction: support restore as a goal, but split it. First audit implementation difficulty and vendor compatibility; expose restore only after transcript reconstruction and identity mapping pass smoke tests.

10. What is the release support matrix for remote environments?
   - Decision: first release supports local desktop only: local VS Code desktop, local workspace, local AgentHost node process, local config/cache/logs, and local pre-installed/pre-authenticated ACP CLI. SSH/remote server, WSL, dev containers, Codespaces, and other remote targets are non-blocking follow-up work.

11. Should external ACP AgentHost support be experiment-gated during internal development?
   - Decision: no. It is enabled by default for internal development/testing until product release planning says otherwise.

12. Should ACP runtime/process telemetry be reported?
   - Decision: no telemetry upload for ACP process/runtime events during internal development/testing. Diagnostics stay local/redacted unless the user explicitly exports them.

13. Should delete/archive call vendor-side destructive APIs?
   - Decision: no by default. Delete/archive is VS Code-local only; vendor-side delete is a later separately approved capability.

## Next Implementation Slice

The clean first task after this research is:

```text
Add a gated, manual-command ACP AgentHost provider prototype that can:
1. register one configured ACP agent as an AgentHost provider;
2. launch it over stdio;
3. initialize ACP v1;
4. create a session with workspace cwd;
5. send one text prompt;
6. stream text updates into AgentHost;
7. cancel and dispose cleanly;
8. if missing login, show a clear vendor-login-required message;
9. avoid file/terminal capabilities.
```

That slice proves the architecture without committing to registry install, tool execution, terminal proxying, or any Director Provider switching.

The first real-vendor follow-up should verify that the UI can show a vendor-owned subscription/login state cleanly, not that Director Providers can drive the external agent.
