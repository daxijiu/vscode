# Project Memory - Director Agent / Provider Backend

Updated: 2026-05-25

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

- `9da6c704379 docs: record director agent project context`
- `4b087dfc4bf docs: add agent provider research notes`
- `fd76ff9f138 docs: add director agent provider roadmap`

The current Phase 0-2 implementation is local/uncommitted at this update.

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
- `doc/director-agent-provider-phase0-plan.md`
- `doc/director-agent-provider-phase1-plan.md`
- `doc/director-agent-provider-phase2-plan.md`
- `AGENTS.md`
- `MEMORY.md`

Implemented locally in the current Phase 0-2 wave:

- Phase 0 inventory: `doc/director-agent-provider-phase0-inventory.md`.
- Phase 1 Provider Backend contract and fake hub:
  - `src/vs/platform/agentHost/common/directorProviderBackend.ts`
  - `src/vs/platform/agentHost/node/director/directorProviderBackendHub.ts`
  - `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts`
- Phase 2 minimal gated Director agent:
  - `src/vs/platform/agentHost/node/director/directorAgent.ts`
  - `src/vs/platform/agentHost/node/director/directorAgentSession.ts`
  - `src/vs/platform/agentHost/test/node/directorAgent.test.ts`
  - narrow gate/registration edits in `agentService.ts`, both AgentHost starters, both AgentHost main entrypoints, and `chat.shared.contribution.ts`.

Manual Phase 0-2 acceptance package generated locally:

- `.tmp/director-phase0-2-acceptance/`
- `.tmp/director-phase0-2-acceptance.zip`
- The package now includes `Ensure-DirectorAcceptanceBuild.ps1`, and the launch scripts run it before opening Code OSS. It checks the core `out/` tree, the Codicons font, built-in extension outputs, and the Copilot Chat `dist/extension.js` entrypoint, then runs `npm run gulp copy-codicons`, `npm run transpile-client`, `npm run gulp compile-extensions`, and `npm --prefix extensions/copilot run compile` if required.
- The enabled and disabled launch scripts support `-Fresh` and rewrite their profile `settings.json` on every run.

The package is ignored workspace state. It contains enabled/disabled AgentHost profiles and PowerShell launch/smoke scripts; it should not be committed.

Important: check `git status --short --branch` before continuing. The Phase 0-2 implementation files are local/uncommitted at this memory update.

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

Phase 0 found that the old generated-tree path currently exists but is empty/unmaterialized. For Phase 3+, materialize the old tree or mine the replay patch:

- `E:\Projects\Director-Code-batch\Director-Code-112-check\patches\replay\004-director-agent-engine.120-insider.patch`

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

- Done locally: produced `doc/director-agent-provider-phase0-inventory.md`.
- Confirmed branch, dirty state, current AgentHost boundaries, Claude reference boundary, old Director reference boundary, and Phase 1/2 decisions.

Phase 1:

- Done locally: added provider backend contracts.
- Done locally: added fake/in-memory backend hub.
- Done locally: added tests for model listing, backend resolution, disabled provider, missing auth, unknown model, and conversion to `IAgentModelInfo`.

Phase 2:

- Done locally: added gated minimal `DirectorAgent implements IAgent`.
- Done locally: no protected resources.
- Done locally: no Copilot CAPI.
- Done locally: fake/echo streaming only.
- Done locally: create/list/dispose session, send, abort, change model, and shutdown.
- Runtime acceptance fix: if Director appears in the AgentHost picker but clicking it still opens `copilotcli`/Local, inspect the workbench renderer log for `command 'workbench.action.chat.openNewChatSessionInPlace.agent-host-director' not found`. The current fix makes dynamic chat-session command registration skip already-registered static commands so the duplicate `agent-host-copilotcli` command does not abort before `agent-host-director` is registered.
- Runtime acceptance note: if many UI icons render as empty boxes, check `out/vs/base/browser/ui/codicons/codicon/codicon.ttf`. Source launch needs `npm run gulp copy-codicons` before `npm run transpile-client` when the ignored `src/.../codicon.ttf` file is missing.
- Runtime acceptance note: if `GitHub.copilot-chat` fails with `Cannot find module ... extensions/copilot/dist/extension`, run `npm --prefix extensions/copilot run compile`. The regular `compile-extensions` task does not produce the Copilot Chat dist bundle.
- Runtime acceptance note: `Director echo: <message>` is expected for Phase 0-2 because the Director agent is fake/echo-backed until real provider traffic is wired later.
- Runtime acceptance note: Director conversation history is not durable in Phase 2. `DirectorAgentSession` records turns in memory only; restoring across workbench/AgentHost restart is Phase 9.

Phase 3:

- Port provider registry and API-key backend semantics from old Director.

Phase 4:

- Wrap old Director `AgentEngine` as an AgentHost harness adapter.

Phase 5:

- Build provider-backed Anthropic-compatible local endpoint.

Phase 6:

- De-CAPI Claude-like SDK harness.
- Observed acceptance follow-up: the current upstream Claude provider can disappear while logged out of Copilot because the current Claude path is still Copilot-protected/CAPI-backed. Fix this in Phase 6 by making the Director-backed Claude-like provider independent from GitHub Copilot login state.

Phase 7:

- Provider Settings UI and model picker integration.

Phase 8:

- OAuth provider support.

Phase 9:

- Session restore, migration, and compatibility.
- Observed acceptance follow-up: Phase 2 Director sessions keep messages only in current process memory. Durable Director conversation history belongs in Phase 9.

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

Current Phase 0-2 validation results:

- `npm run compile-check-ts-native` passed.
- `npm run gulp copy-codicons` passed and restored the ignored Codicons font used by source launch UI.
- `npm run transpile-client` passed.
- `npm run gulp compile-extensions` passed and produced the built-in extension `out/` files needed for source launch.
- `npm --prefix extensions/copilot run compile` passed and produced `extensions/copilot/dist/extension.js`.
- `npm run valid-layers-check` passed.
- `npm run test-node -- --run src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts` passed, 6 passing.
- `npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts` passed, 5 passing.
- Direct combined mocha against generated output also passed, 9 passing.
- Dependency scan for `ICopilotApiService`, `GITHUB_COPILOT_PROTECTED_RESOURCE`, `copilotApi`, `CAPI`, and `Copilot` in Director-owned backend/agent files returned no hits.
- `npm run test-node -- --grep "Director"` ran the full node unit suite in this repository and failed on an existing environment-specific `Request Service / Kerberos lookup` credential error, not on Director tests.
- `.tmp/director-phase0-2-acceptance/Run-DirectorSmoke.ps1` passed after the manual acceptance package was generated.
- Manual package settings were checked: enabled profile has both `chat.agentHost.enabled` and `chat.agentHost.directorAgent.enabled` set to `true`; disabled profile keeps `chat.agentHost.enabled` true and sets `chat.agentHost.directorAgent.enabled` to `false`.

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

Manual acceptance:

- Run `.tmp/director-phase0-2-acceptance/Launch-DirectorDisabled.ps1 -Fresh` and confirm Director is not offered as an AgentHost provider.
- Run `.tmp/director-phase0-2-acceptance/Launch-DirectorEnabled.ps1 -Fresh` and confirm Director is offered, creates an AHP `createSession` request with `provider: director`, streams deterministic echo text, and does not trigger GitHub/Copilot auth.

Then review and commit/push the local Phase 0-2 implementation.

After that, start Phase 3 only after deciding how to materialize or mine the old Director provider registry/auth/model resolver from the 112 replay patch.
