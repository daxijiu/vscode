# Phase 0 Inventory - Director Agent Provider

Updated: 2026-05-25

## Local State

| Item | Value |
|---|---|
| Repository | `E:\Projects\Director-Code-batch\vscode` |
| Branch | `codex/Director` tracking `origin/codex/Director` |
| Commit | `9da6c704379 docs: record director agent project context` |
| Remote | `origin https://github.com/daxijiu/vscode.git` |
| Dirty paths before this file | none under `doc`, `src`, `AGENTS.md`, or `MEMORY.md` |
| Phase 0 write scope | `doc/director-agent-provider-phase0-inventory.md` only |

No source files were modified for this inventory.

## Current AgentHost Flow

```text
agentHostMain / agentHostServerMain
  -> construct shared services
  -> register IAgent providers
  -> AgentService publishes root state agents/models/resources
  -> AgentHost session providers project root state into Agent Sessions UI
  -> SessionTurnStarted reaches AgentSideEffects
  -> IAgent.sendMessage emits AgentSignal actions
  -> AgentHostStateManager reduces response parts / turn completion
```

| Concern | Current file(s) | Notes for Director |
|---|---|---|
| Provider registration | `src/vs/platform/agentHost/node/agentHostMain.ts` around provider registration; `src/vs/platform/agentHost/node/agentHostServerMain.ts` server registration path; `src/vs/platform/agentHost/node/agentService.ts` `registerProvider()` | `CopilotAgent` is always registered. `ClaudeAgent` is currently registered only when `AgentHostClaudeSdkPathEnvVar` is present. Director should follow the same narrow registration point, behind its own gate. |
| Settings and env forwarding | `src/vs/platform/agentHost/common/agentService.ts` exports `AgentHostClaudeAgentSdkPathSettingId` and `AgentHostClaudeSdkPathEnvVar`; `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` registers `chat.agentHost.claudeAgent.path`; `src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`; `src/vs/platform/agentHost/node/nodeAgentHostStarter.ts` | The current Claude gate is path-based: setting -> env var -> AgentHost process. Director Phase 2 should add `chat.agentHost.directorAgent.enabled` and `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT` using the same small forwarding shape. |
| Root state / agents | `src/vs/platform/agentHost/node/agentService.ts` `registerProvider()` calls `_updateAgents()`; `src/vs/platform/agentHost/common/state/sessionState.ts` `createRootState()` starts with `agents: []` | Root state is provider-driven. Director should publish an `IAgentDescriptor`, static/fake models in Phase 2, and no protected resources in Phase 1/2. |
| Agent contract / model publication | `src/vs/platform/agentHost/common/agentService.ts` `IAgent`, `IAgentModelInfo`, `AgentSignal`, `AgentProvider` | Director backend contracts should map their provider/model concepts into `IAgentModelInfo` without importing `CCAModel` or Copilot-only types. |
| Auth fan-out | `src/vs/platform/agentHost/node/agentService.ts` `authenticate()` fans a protected resource token to all providers that declare that resource; `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.ts` resolves VS Code auth sessions for `ProtectedResourceMetadata` | Phase 1/2 Director should return `[]` from `getProtectedResources()`. API keys are not `ProtectedResourceMetadata`; they belong to later Secret Storage / provider backend work. |
| Session lifecycle | `src/vs/platform/agentHost/node/agentService.ts` `createSession()`, `listSessions()`, `disposeSession()`; `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts` projects session types and calls `connection.createSession()` / `disposeSession()` | Director Phase 2 only needs create/list/dispose in current process. Durable restore waits for Phase 9. |
| Turn side effects | `src/vs/platform/agentHost/node/agentSideEffects.ts` handles `ActionType.SessionTurnStarted` and calls `agent.sendMessage(...)` | The minimal Director echo session should emit ordinary `AgentSignal.kind === 'action'` progress so this path remains unchanged. |
| Progress actions | `src/vs/platform/agentHost/node/agentSideEffects.ts` `_handleAgentSignal()` and `_dispatchActionForSession()`; `src/vs/platform/agentHost/common/state/protocol/actions.ts` defines session actions | Phase 2 should emit `SessionResponsePart` with `ResponsePartKind.Markdown`, then `SessionTurnComplete`. Do not add a second progress protocol. |
| Model picker | `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts` `_syncSessionTypesFromRootState()` and new-session config flow; `IAgentModelInfo` in `agentService.ts` | Phase 2 can expose one fake model. Phase 3+ can replace the fake source with provider backend models. |
| Feature gates | Existing Claude path gate: `chat.agentHost.claudeAgent.path` -> `VSCODE_AGENT_HOST_CLAUDE_SDK_PATH`; AgentHost master gate: `chat.agentHost.enabled` | Director should have an explicit Director gate, not reuse the Claude SDK path as a proxy for enabled state. |

## Claude Reference Boundary

### Reuse

| Claude reference | Use in Director? | Reason |
|---|---|---|
| `src/vs/platform/agentHost/node/claude/claudeAgent.ts` | yes | Best current `IAgent` provider shell: descriptor, model observable, session URI ownership, create/list/dispose/send entrypoints. |
| `src/vs/platform/agentHost/node/claude/claudeAgentSession.ts` | partial | Useful for later real harness lifecycle, abort, restart, and metadata patterns. Too heavy for Phase 2 echo. |
| `src/vs/platform/agentHost/node/claude/claudeSdkPipeline.ts` | later | Shows how stream events become `SessionResponsePart` and `SessionTurnComplete`. Useful once Director has a real runtime stream. |
| `src/vs/platform/agentHost/node/claude/claudeReplayMapper.ts` and `phase13-plan.md` | later | Restoration should return `Turn[]` directly. Phase 2 stays in-memory. |
| `src/vs/platform/agentHost/node/claude/claudeSubagent*.ts` and `phase12-plan.md` | later | Useful when Director exposes subagents. Not in Phase 1/2. |
| `src/vs/platform/agentHost/node/claude/claudeTool*.ts`, `claudeCanUseTool.ts`, `claudeInteractiveTools.ts` | later | Tool and permission bridge patterns. Not needed for fake streaming. |
| `src/vs/platform/agentHost/node/claude/phase*-plan.md` | yes | Planning style and per-phase split should be mirrored for Director. |

### Do Not Reuse Directly

| Claude/Copilot point | Why not |
|---|---|
| `GITHUB_COPILOT_PROTECTED_RESOURCE` | It is GitHub Copilot account auth. Director/custom providers must not share this resource identity. |
| `ICopilotApiService.models()` | It returns Copilot CAPI models. Director models must come from a Director-owned provider backend. |
| `ClaudeProxyService.start(githubToken)` | Its local Anthropic-compatible endpoint shape is useful, but the current implementation forwards to Copilot CAPI. |
| CAPI model filtering in `claudeAgent.ts` | Filtering `CCAModel` is not a generic provider registry. |
| Claude SDK path as the only gate | Director should be enabled by its own boolean env/setting gate, not by presence of an SDK package path. |

## Old Director Reference Boundary

The user-specified generated-tree path exists:

```text
E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode
```

At Phase 0 inspection time that directory is empty/unmaterialized in this workspace. The old module evidence was therefore read from the replay source patch:

```text
E:\Projects\Director-Code-batch\Director-Code-112-check\patches\replay\004-director-agent-engine.120-insider.patch
```

This is not a blocker for Phase 1/2 because those phases should not copy old runtime code. Phase 3+ should either materialize the old tree or extract the exact files from the patch before porting semantics.

| Old module | Reference location | Reuse role | Target phase |
|---|---|---|---:|
| `providerRegistry.ts` | `patches/replay/004-director-agent-engine.120-insider.patch` creates `src/vs/workbench/contrib/directorCode/common/agentEngine/providerRegistry.ts` | Provider instance source of truth, default provider/model, base URL, auth kind, model visibility | 3 |
| `apiKeyService.ts` | same patch creates `common/agentEngine/apiKeyService.ts` | Secret-backed API-key semantics, key testing, change events | 3 |
| `authStateService.ts` | same patch creates `common/agentEngine/authStateService.ts` | Auth resolver and OAuth/API-key facade split | 3/8 |
| `oauthService.ts` | same patch creates `common/agentEngine/oauthService.ts` | OAuth flow semantics and token storage concepts | 8 |
| `modelResolver.ts` | same patch creates `common/agentEngine/modelResolver.ts` | Model discovery, fallback, cache and capability normalization | 3 |
| `providers/providerTypes.ts` | same patch creates `common/agentEngine/providers/providerTypes.ts` | Normalized provider request/response/stream types and capabilities | 1/3 |
| `providers/providerFactory.ts` | same patch creates `common/agentEngine/providers/providerFactory.ts` | Transport factory concepts for Anthropic/OpenAI/Gemini/compatible providers | 3/5 |
| `directorCodeAgent.ts` | same patch creates `browser/agentEngine/directorCodeAgent.ts`; class implements `IChatAgentImplementation` | Harness-migration reference only: old Chat Agent entrypoint should become an AgentHost adapter, not the final surface | 4 |
| `agentEngine.ts` | same patch creates `common/agentEngine/agentEngine.ts` | Director runtime loop, provider calls, tools, compact/retry semantics | 4 |
| `directorPlanMode.ts` | referenced by old Director plans/patches | Director-specific session policy and `director_present_plan` behavior | 4/9 |

Do not copy the old generated tree as the source of truth for this fork. Use it as reference material for contracts, auth semantics, model resolution, and runtime behavior.

## Minimal File Set Expected

### Phase 1 allowed files

| File | Purpose |
|---|---|
| `src/vs/platform/agentHost/common/directorProviderBackend.ts` | Director-owned provider/backend contracts, resolved backend shape, capability and auth state types. |
| `src/vs/platform/agentHost/node/director/directorProviderBackendHub.ts` | Fake/in-memory backend implementation for tests and Phase 2 development only. |
| `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts` | Unit coverage for provider listing, model listing, missing auth/disabled states, and no Copilot dependency. |

### Phase 2 allowed files

| File | Purpose |
|---|---|
| `src/vs/platform/agentHost/node/director/directorAgent.ts` | Minimal `IAgent` implementation with descriptor, static/fake models, session lifecycle, echo stream, abort/dispose. |
| `src/vs/platform/agentHost/node/director/directorAgentSession.ts` | Current-process session state for Phase 2 echo. |
| `src/vs/platform/agentHost/common/agentService.ts` | Add Director setting/env constants only. |
| `src/vs/platform/agentHost/node/agentHostMain.ts` | Register `DirectorAgent` behind `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT`. |
| `src/vs/platform/agentHost/node/agentHostServerMain.ts` | Same registration for standalone/server AgentHost. |
| `src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts` | Forward Director setting/env into utility process. |
| `src/vs/platform/agentHost/node/nodeAgentHostStarter.ts` | Forward Director setting/env into node fallback process. |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` | Register `chat.agentHost.directorAgent.enabled` as experimental/advanced. |
| `src/vs/platform/agentHost/test/node/directorAgent.test.ts` | Provider registration, fake response stream, abort/dispose, no protected resources. |

The first slice should stay around this explicit file set. If implementation needs more files, update this inventory or the relevant phase plan before editing.

## Prohibited Scope

- Do not claim ownership of all `src/vs/platform/agentHost/**`.
- Do not claim ownership of all `src/vs/sessions/**`.
- Do not modify `extensions/copilot/**` for Phase 1/2.
- Do not use `ICopilotApiService`, `GITHUB_COPILOT_PROTECTED_RESOURCE`, Copilot CAPI, GitHub Copilot tokens, or Copilot entitlement checks in Director-owned backend code.
- Do not implement Secret Storage, OAuth, provider settings UI, real OpenAI/Anthropic traffic, Claude SDK subprocess integration, or old `AgentEngine` migration in Phase 1/2.
- Do not replace Copilot or change product-level default chat agent behavior.
- Do not treat markdown custom agents as runtime harnesses; markdown custom agent selection is separate from a concrete `IAgent` provider.

## Phase 1/2 Decisions

| Decision | Value | Reason |
|---|---|---|
| First provider id | `director` | Short, stable, and matches the product/runtime name. |
| First setting id | `chat.agentHost.directorAgent.enabled` | Mirrors current AgentHost settings and keeps Director opt-in. |
| First env var | `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT` | Explicit gate for AgentHost child process registration. |
| Common contract file | `src/vs/platform/agentHost/common/directorProviderBackend.ts` | Shared contract without workbench or Copilot dependency. |
| Node implementation directory | `src/vs/platform/agentHost/node/director/` | Narrow Director-owned AgentHost island. |
| Initial backend | fake/in-memory development scaffold | Proves boundary without secrets, OAuth, or real traffic. |
| Protected resources in Phase 1/2 | none; `getProtectedResources()` returns `[]` | API-key provider work comes later and is not OAuth metadata. |
| Real LLM calls in Phase 1/2 | none | Phase 2 should only stream deterministic echo/fake content. |
| Session restore in Phase 2 | in-memory only | Durable transcript restore is Phase 9. |
| Standalone AgentHost support | yes, if the same gate is passed | Keeps local and server AgentHost registration behavior aligned. |

## Phase 1 Handoff Checkpoints

- Define provider/backend types without importing `CCAModel`, `ICopilotApiService`, or Claude SDK types.
- Include explicit states for disabled provider, missing auth, unavailable model, and selected fake backend.
- Provide helper conversion into `IAgentModelInfo`.
- Add tests proving model listing and backend resolution work with the fake hub.
- Run `npm run compile-check-ts-native` before tests if TypeScript is changed.
- Run `npm run valid-layers-check` after TypeScript edits.

## Phase 2 Handoff Checkpoints

- Add Director gate constants and forward setting -> env in both AgentHost starters.
- Register `DirectorAgent` beside `CopilotAgent`, not instead of it.
- Keep `ClaudeAgent` registration behavior unchanged.
- `DirectorAgent.getProtectedResources()` returns `[]`.
- `DirectorAgent.models` comes from the Phase 1 fake backend.
- `createSession()` returns an `AgentSession.uri('director', rawId)` summary.
- `sendMessage()` emits `SessionResponsePart` markdown and `SessionTurnComplete`.
- `abortSession()` cancels the current fake stream without throwing on already-complete sessions.
- Tests verify provider registration, fake streaming, abort, dispose, and no Copilot auth/resource dependency.

## Risks Before Implementation

- The Claude reference is mature but CAPI-bound; copy only the `IAgent` shell and event mapping patterns.
- The current Claude gate is SDK-path based, while Director needs a boolean gate. Avoid mixing the two.
- `AgentService.authenticate()` fans out a token to all providers sharing a protected resource; Director OAuth resources must be provider-specific in Phase 8.
- The old Director generated-tree path is currently empty/unmaterialized. Port old semantics from replay patches or materialize a reference tree before Phase 3+.
- Phase 2 fake streaming can accidentally grow into a real backend. Keep the fake backend visibly development-only until provider registry/auth exists.

## Validation Performed

- `git status --short --branch`
- `git rev-parse --show-toplevel`
- `git log -1 --oneline`
- `git remote -v`
- Read `.github/copilot-instructions.md`
- Read `AGENTS.md`
- Read `doc/director-agent-provider-phase0-plan.md`
- Read `doc/director-agent-provider-roadmap.md`
- Read `doc/research/claude-agenthost-phase-handoff.md`
- Read `doc/research/custom-agent-provider-backend-plan.md`
- Inspected AgentHost registration/settings/env, current `IAgent` contract, session lifecycle, auth, and progress action paths.
- Inspected Claude reference files and phase plans.
- Inspected old Director reference availability and replay patch module evidence.
