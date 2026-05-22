# Project Memory - Director Agent / Provider Backend

更新时间：2026-05-22

## Project Context

This checkout is the user's VS Code fork:

```text
E:\Projects\Director-Code-batch\vscode
```

Remote:

```text
origin https://github.com/daxijiu/vscode.git
```

Current branch during this memory update:

```text
codex/Director
```

Current remote-synced commits:

- `4b087dfc4bf docs: add agent provider research notes`
- `fd76ff9f138 docs: add director agent provider roadmap`

At the time this file was created, the Phase 0-2 plan documents had additional local refinements that were not yet committed.

## Project Goal

The goal is to refactor the user's Director AI work into a more maintainable VS Code fork architecture:

- Director should become an optional AgentHost `IAgent` provider.
- Future non-Copilot agents, such as Claude-like SDK agents or other open-source/CLI agents, should also be optional AgentHost providers.
- Non-Copilot agents should use a Director-owned Provider Backend Hub for model providers, API keys, OAuth, base URLs, model lists, capabilities, and transport adapters.
- Copilot, Copilot CLI, GitHub Copilot auth, and GitHub Copilot CAPI should remain isolated and unchanged.

Short version:

```text
AgentHost = runtime/session shell
Director Provider Backend Hub = user LLM provider/auth/model source of truth
```

## Architecture Direction

Target shape:

```text
VS Code Agent Sessions / AgentHost UI
        |
AgentHost IAgent Provider
        |
Harness Adapter
        |
Director Provider Backend Hub
        |
API key / OAuth / local / compatible providers
```

Core rules:

- Do not treat markdown-defined custom agents as runtime harnesses.
- Do not turn `ClaudeProxyService` into the universal backend.
- Do not use `GITHUB_COPILOT_PROTECTED_RESOURCE` for Director/custom providers.
- API keys belong in Secret Storage and provider auth resolution, not in `ProtectedResourceMetadata`.
- Session kind should stay stable; do not switch agent runtime in-place.
- Keep workbench and sessions changes narrow.

## Current Status

Completed and pushed:

- `doc/director-agent-provider-roadmap.md`
- `doc/research/claude-agenthost-phase-handoff.md`
- `doc/research/custom-agent-provider-backend-plan.md`

Created and locally refined:

- `doc/director-agent-provider-phase0-plan.md`
- `doc/director-agent-provider-phase1-plan.md`
- `doc/director-agent-provider-phase2-plan.md`

Created in this update:

- `AGENTS.md`
- `MEMORY.md`

Important: check `git status --short --branch` before continuing. There may be uncommitted doc refinements.

## Plan Documents

Roadmap:

- `doc/director-agent-provider-roadmap.md`

Phase plans:

- `doc/director-agent-provider-phase0-plan.md`
- `doc/director-agent-provider-phase1-plan.md`
- `doc/director-agent-provider-phase2-plan.md`

Research:

- `doc/research/claude-agenthost-phase-handoff.md`
- `doc/research/custom-agent-provider-backend-plan.md`

Claude AgentHost reference plans:

- `src/vs/platform/agentHost/node/claude/roadmap.md`
- `src/vs/platform/agentHost/node/claude/phase*-plan.md`

## Reference Code

Current VS Code fork AgentHost:

- `src/vs/platform/agentHost/common/agentService.ts`
- `src/vs/platform/agentHost/node/agentHostMain.ts`
- `src/vs/platform/agentHost/node/agentHostServerMain.ts`
- `src/vs/platform/agentHost/node/agentService.ts`
- `src/vs/platform/agentHost/node/agentSideEffects.ts`
- `src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.ts`

Current Claude AgentHost implementation:

- `src/vs/platform/agentHost/node/claude/claudeAgent.ts`
- `src/vs/platform/agentHost/node/claude/claudeAgentSession.ts`
- `src/vs/platform/agentHost/node/claude/claudeProxyService.ts`
- `src/vs/platform/agentHost/node/claude/claudeSdkPipeline.ts`
- `src/vs/platform/agentHost/node/shared/copilotApiService.ts`

Old Director reference implementation:

- `E:\Projects\Director-Code-batch\Director-Code-112-check`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode`

Old Director modules to mine for concepts:

- `src/vs/workbench/contrib/directorCode/common/agentEngine/providerRegistry.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/apiKeyService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/authStateService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/oauthService.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerTypes.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/providers/providerFactory.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/modelResolver.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/agentEngine.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/directorCodeAgent.ts`
- `src/vs/workbench/contrib/directorCode/browser/agentEngine/toolBridge.ts`
- `src/vs/workbench/contrib/directorCode/common/agentEngine/directorPlanMode.ts`

The old generated tree is reference-only. It is not the durable source root for this fork.

## Phase Summary

Recommended execution order:

```text
0 -> 1 -> 2 -> 3 -> 4 -> 7 -> 5 -> 6 -> 8 -> 9 -> 10 -> 11
```

Phase 0:

- Produce `doc/director-agent-provider-phase0-inventory.md`.
- Confirm branch, dirty state, current AgentHost boundaries, Claude reference boundary, old Director reference boundary, and Phase 1/2 decisions.

Phase 1:

- Add provider backend contracts.
- Add fake/in-memory backend hub.
- Add tests for model listing, backend resolution, disabled provider, missing auth, unknown model, and conversion to `IAgentModelInfo`.

Phase 2:

- Add gated minimal `DirectorAgent implements IAgent`.
- No protected resources.
- No Copilot CAPI.
- Fake/echo streaming only.
- Create/list/dispose session, send, abort, and shutdown.

Phase 3:

- Port provider registry and API-key backend semantics from old Director.

Phase 4:

- Wrap old Director `AgentEngine` as an AgentHost harness adapter.

Phase 5:

- Build provider-backed Anthropic-compatible local endpoint.

Phase 6:

- De-CAPI Claude-like SDK harness.

Phase 7:

- Provider Settings UI and model picker integration.

Phase 8:

- OAuth provider support.

Phase 9:

- Session restore, migration, and compatibility.

Phase 10:

- Hardening, telemetry, stress tests, dogfood.

Phase 11:

- SDK/runtime distribution strategy.

## Current Decisions

Unless superseded by Phase 0 inventory:

| Decision | Value |
|---|---|
| First agent provider id | `director` |
| First setting id | `chat.agentHost.directorAgent.enabled` |
| First env var | `VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT` |
| Common provider type file | `src/vs/platform/agentHost/common/directorProviderBackend.ts` |
| Node implementation directory | `src/vs/platform/agentHost/node/director/` |
| Phase 1/2 auth | none |
| Phase 1/2 real LLM calls | none |
| Phase 2 protected resources | `[]` |

## Validation Notes

For TypeScript changes:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
```

For AgentHost-focused tests:

```powershell
npm run test-node -- --grep agentHost
```

For docs-only changes:

```powershell
git diff --check -- <changed-doc-paths>
```

## Known Risks

- Accidentally making Director another product-level Copilot replacement instead of an optional AgentHost provider.
- Reusing `ClaudeProxyService` as if it were backend-neutral.
- Letting `ICopilotApiService` leak into Director provider backend code.
- Mixing API-key provider work with OAuth too early.
- Copying old generated-tree code directly into the current fork.
- Broad edits to `src/vs/sessions/**` or `src/vs/platform/agentHost/**`.

## Next Recommended Action

Finish or execute Phase 0:

1. Generate `doc/director-agent-provider-phase0-inventory.md`.
2. Commit the refined Phase 0-2 plan docs plus `AGENTS.md` and `MEMORY.md`.
3. Start Phase 1 only after the inventory confirms the file boundaries and feature gate names.
