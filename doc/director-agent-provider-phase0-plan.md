# Phase 0 Plan - Baseline and Ownership

> Handoff plan for the Director Agent / Provider Backend roadmap. Execute this phase before writing runtime code. Cross-reference [director-agent-provider-roadmap.md](./director-agent-provider-roadmap.md).

## 1. Goal

Freeze the current architecture facts and ownership boundaries so the Director Agent work starts as a narrow AgentHost/provider integration, not as another broad product/chat fork.

This phase is mostly read-only. The expected durable output is a small implementation inventory and a set of decisions that Phase 1 and Phase 2 can execute without re-opening basic questions.

## 2. Scope

In scope:

- Confirm current branch and dirty state.
- Confirm the current Claude AgentHost implementation status.
- Record exactly where current AgentHost provider registration, auth, model publication, session creation, and progress dispatch live.
- Record the current Copilot-bound Claude points.
- Record old Director modules that are reusable as provider/backend concepts.
- Decide the first agent id, file ownership boundaries, and feature gate names.
- Decide which files/directories Phase 1 and Phase 2 may touch.

Out of scope:

- TypeScript source changes under `src/`.
- Provider backend implementation.
- Secret Storage, OAuth, or real LLM traffic.
- Moving old Director code.
- Updating product defaults or replacing Copilot.

## 3. Inputs to Read

Read these first:

- `AGENTS.md`
- `.github/copilot-instructions.md`
- `doc/director-agent-provider-roadmap.md`
- `doc/research/claude-agenthost-phase-handoff.md`
- `doc/research/custom-agent-provider-backend-plan.md`

Read these current VS Code fork files:

- `src/vs/platform/agentHost/common/agentService.ts`
- `src/vs/platform/agentHost/node/agentHostMain.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- `src/vs/platform/agentHost/node/agentService.ts`
- `src/vs/platform/agentHost/node/agentSideEffects.ts`
- `src/vs/platform/agentHost/node/claude/roadmap.md`
- `src/vs/platform/agentHost/node/claude/claudeAgent.ts`
- `src/vs/platform/agentHost/node/claude/claudeProxyService.ts`
- `src/vs/platform/agentHost/node/shared/copilotApiService.ts`
- `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.ts`

Read these old Director generated-tree files only as reference material:

- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\providerRegistry.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\authStateService.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\apiKeyService.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\providers\providerTypes.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\providers\providerFactory.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\browser\agentEngine\directorCodeAgent.ts`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode\src\vs\workbench\contrib\directorCode\common\agentEngine\agentEngine.ts`

## 4. Work Items

### Step 1 - Baseline Local State

Run:

```powershell
git status --short --branch
git rev-parse --show-toplevel
git log -1 --oneline
```

Record:

- branch name;
- latest commit;
- untracked/dirty files relevant to this work;
- whether `doc/research/**` and roadmap files are already untracked.

Do not clean or revert anything.

### Step 2 - Current AgentHost Boundary Inventory

Create a short inventory of current AgentHost flow:

```text
agentHostMain/agentHostServerMain
  -> register IAgent providers
  -> AgentService publishes root state
  -> Workbench AgentHost contribution registers session/chat surfaces
  -> AgentSideEffects routes SessionTurnStarted to IAgent.sendMessage
  -> IAgent emits AgentSignal actions
```

The inventory should list concrete files for:

- provider registration;
- root-state publication;
- model publication;
- protected resource auth;
- session create/list/dispose;
- `SessionTurnStarted` side effect;
- response part / turn complete action path.

### Step 3 - Claude Reference Boundary

Document what should be reused from `src/vs/platform/agentHost/node/claude/**`:

- `IAgent` provider shell;
- session lifecycle shape;
- model observable publication;
- action-signal progress path;
- tool and permission bridge patterns;
- subagent and restore patterns;
- phase plan style.

Document what should not be reused directly:

- `GITHUB_COPILOT_PROTECTED_RESOURCE` for Director/custom providers;
- `ICopilotApiService.models()` as generic model source;
- `ClaudeProxyService.start(githubToken)` as generic provider backend;
- CAPI-specific model filtering.

### Step 4 - Old Director Reuse Boundary

Classify old Director modules into three groups:

Directly reusable concepts:

- provider instance registry;
- API-key/OAuth auth facade;
- provider capabilities;
- normalized provider request/response/stream types;
- model resolver;
- provider factory;
- Provider Manager UI concepts.

Harness-migration concepts:

- `AgentEngine`;
- progress bridge;
- tool bridge;
- Plan Mode;
- message normalization.

Do not copy as-is:

- product-level default chat agent replacement;
- Copilot commercial-flow bypasses;
- generated-tree patch/replay mechanics;
- old `IChatAgentImplementation` entrypoint as the final runtime surface.

### Step 5 - Make Phase 1/2 Decisions

Record decisions in the inventory output:

- First agent id: recommended `director`.
- First setting id: recommended `chat.agentHost.directorAgent.enabled`.
- First env var: recommended `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT`.
- Initial directory: recommended `src/vs/platform/agentHost/node/director/**`.
- Initial common contract file: recommended `src/vs/platform/agentHost/common/directorProviderBackend.ts`.
- Initial tests:
  - `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts`;
  - `src/vs/platform/agentHost/test/node/directorAgent.test.ts`.
- Whether the first fake backend is production-test-only or a gated development implementation.

### Step 6 - Write Inventory

Suggested output:

- `doc/director-agent-provider-phase0-inventory.md`

The inventory should be concise. It should not duplicate the whole roadmap. It should give enough evidence for Phase 1 and Phase 2 implementation agents to proceed without rediscovery.

## 5. Expected Decisions

Recommended default decisions unless Phase 0 finds conflicting code evidence:

| Decision | Default |
|---|---|
| Agent provider id | `director` |
| Setting id | `chat.agentHost.directorAgent.enabled` |
| Env var | `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT` |
| Provider backend type file | `src/vs/platform/agentHost/common/directorProviderBackend.ts` |
| Node implementation directory | `src/vs/platform/agentHost/node/director/` |
| Workbench changes | setting registration and env forwarding only |
| Auth in Phase 1/2 | none; `getProtectedResources()` returns `[]` |
| Real LLM calls in Phase 1/2 | none |

## 6. Validation

Phase 0 does not require TypeScript compilation because it should not edit TypeScript source.

Run:

```powershell
git diff --check -- doc/director-agent-provider-phase0-inventory.md
```

If only plan docs were created, also verify:

```powershell
git status --short -- doc
```

## 7. Exit Criteria

- `doc/director-agent-provider-phase0-inventory.md` exists.
- It records current branch, dirty state, and commit.
- It lists the current AgentHost and Claude boundaries with concrete file paths.
- It records Phase 1/2 decisions.
- It explicitly says old `Director-Code-112-check/vscode.generated/**` is reference-only, not the source root for this fork.
- No runtime code has changed.

## 8. Open Questions

- Should `director` be the permanent provider id, or only the first implementation id?
- Should `chat.agentHost.directorAgent.enabled` be user-visible or hidden/experimental at first?
- Should the fake backend survive as a developer feature or only as a test fixture?
- Should Phase 2 register `DirectorAgent` only in local AgentHost, or also in server/headless AgentHost immediately?
