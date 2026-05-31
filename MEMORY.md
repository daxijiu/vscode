# Project Memory - Director Agent / Provider Backend

Updated: 2026-05-31

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
- `be253aa6d52 feat: add gated director agenthost provider`
- Latest Phase 3 close-out before this slice: `a01b3c8c4d7 Complete Director Phase 3 provider settings`

The Phase 0-4 implementation has been accepted, committed, and pushed. Phase 7 has a completed provider/model projection and provider-runtime reuse slice ready for close-out.

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

Implemented and pushed in the Phase 0-2 wave:

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

Important: check `git status --short --branch` before continuing.

## Plan Documents

Roadmap:

- `doc/director-agent-provider-roadmap.md`

Phase plans:

- `doc/director-agent-provider-phase0-plan.md`
- `doc/director-agent-provider-phase1-plan.md`
- `doc/director-agent-provider-phase2-plan.md`
- `doc/director-agent-provider-phase3-plan.md`
- `doc/director-agent-provider-phase4-plan.md`
- `doc/director-agent-provider-phase5-plan.md`
- `doc/director-agent-provider-phase6-plan.md`
- `doc/director-agent-provider-phase7-plan.md`
- `doc/director-agent-provider-phase8-plan.md`
- `doc/director-agent-provider-phase9-plan.md`
- `doc/director-agent-provider-phase10-plan.md`

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

- Phase 3 passed automated validation and manual source-run acceptance on 2026-05-26. The close-out state is ready to commit; next active work is Phase 4.
- Added Workbench-owned provider registry, API-key Secret Storage wrapper, deterministic OpenAI Codex fake OAuth state, model resolver, and secret-free provider snapshot writer under `src/vs/workbench/contrib/directorCode/**`.
- Added shared AgentHost common DTO/helpers for secret-free snapshots, protocol compatibility routing, and provider request templates under `src/vs/platform/agentHost/common/directorProvider*.ts`.
- Updated `DirectorProviderBackendHub` to read the Workbench-written snapshot when available, while keeping explicit fake fixtures for tests and fallback startup.
- Added a visible `director-code.openSettings` command with Command Palette, Menubar Preferences, and Chat title menu entries. It now opens a `Director Settings` editor pane backed by `ProviderSettingsWidget`; the UI follows the old Director section layout with Connected Providers, Popular Providers, Models, Snapshot, and in-page provider modals.
- Added a Workbench-owned no-network provider setup validation service. It checks auth state and builds a redacted request template; it intentionally does not send API-key traffic through `IRequestService` because VS Code request logging redacts `authorization` but not every provider-specific key header.
- Model ids are separated into AgentHost-visible unique ids and provider wire model ids via `providerModelId`, so future real traffic does not send namespaced picker ids to providers.
- Review fixes already applied in this local slice: AgentHost infers provider from the selected global model id, global default model selection wins over per-provider defaults, snapshot writes are serialized, and known sensitive auth headers are stripped from registry/snapshot/backend metadata.
- Runtime acceptance fix: `director-code.openSettings` must not pass `ServicesAccessor` across `await`. The command now only captures `IEditorService` synchronously in `Action2.run()` and opens the Director Settings editor.
- Runtime acceptance fix: `DirectorAgent` now refreshes provider models periodically from the secret-free snapshot and only emits model changes when the list differs. This fixes the case where AgentHost starts before Workbench writes provider models, leaving the picker empty until a full AgentHost process restart.
- Manual acceptance covered Director Settings, API-key provider save, dry-run provider validation, secret-free registry/snapshot inspection, fake OpenAI Codex OAuth state, AgentHost model list refresh, and expected `Director echo: ...` runtime behavior.
- Phase 3 completion follow-up started after commit `973fdf3aae6`: added `src/vs/workbench/contrib/directorCode/test/common/provider/directorProviderServices.test.ts` covering registry secret/header stripping, API-key auth snapshot state, and deterministic OpenAI Codex fake OAuth state without token leaks.
- Phase 3 completion follow-up now also adds shared sensitive-header redaction, explicit registry/snapshot field allowlisting, active-profile snapshot mirroring to the default-profile AgentHost path, file-backed AgentHost snapshot tests, a `DirectorProviderConnectionTestService`, old-Director-style section/modal Provider Settings UI, and pure normalized-message request adapters under `src/vs/platform/agentHost/common/directorProviderAdapters.ts`.
- Provider Settings UI parity pass added old-style status summary, solid non-transparent modal surfaces, denser model rows, stronger tags/buttons/input contrast, API-key monospace input, model Visible/Hidden toggles, Show All, Set Default gating for hidden models, and metadata-preserving model save/visibility updates.
- Provider Settings UX follow-up uses a stable page shell with section-scoped refreshes, scroll preservation, stale async render guards, and section-scoped disposable stores, so model Visible/Hidden changes no longer clear the whole editor or jump to the top. Provider dialogs no longer close on backdrop clicks; close them with the header button, Cancel, or Escape.
- Hidden models are persisted in the registry for UI management but filtered out of the AgentHost snapshot/model list. Registry and snapshot defaults are normalized to visible models so AgentHost does not point at a hidden model.
- Current `Refresh Models` remains a Phase 3 static/dry-run refresh of configured or template model metadata. Real credential-gated network model discovery belongs to the next provider hardening slice unless Phase 3 is explicitly expanded.
- Validation passed for the completion candidate: `npm run compile-check-ts-native`, `npm run transpile-client`, `npm run valid-layers-check`, targeted `node test\unit\node\index.js --run ...director...` suites with 21 passing across the rerun target files, and `git diff --check`.
- `npm run test-node -- --grep "directorProvider"` still runs nearly the whole node unit suite in this checkout and failed on an existing Windows `Request Service / Kerberos lookup` credential error, not on Director tests. Prefer the narrower `node test\unit\node\index.js --run <test-file>` form for this slice.
- Real OpenAI Codex OAuth browser/device flow is still pending; the local Phase 3 target uses a deterministic fake token state stored in Secret Storage.
- Keep AgentHost runtime provider transports under `src/vs/platform/agentHost/**`; Workbench owns Settings UI, registry, auth, secrets, model-refresh orchestration, connection-test orchestration, and the secret-free provider/model/auth-state snapshot writer.
- Workbench must not import AgentHost node transports. Shared compatibility, request builders, and snapshot DTOs belong under `src/vs/platform/agentHost/common/**`; AgentHost Phase 3 code consumes auth state, not raw API keys or OAuth bearer tokens.
- Keep public `openai-responses` hidden/reserved until implemented separately from old Director `openai-codex`.
- Keep real Director `AgentEngine` turns for Phase 4.
- Keep full old settings editor port, real OAuth hardening, additional OAuth providers, and real provider network connection tests as follow-up work unless this Phase 3 slice is expanded.

Phase 4:

- Phase 4 AgentHost Director AgentEngine adapter implemented locally on 2026-05-26.
- Director Agent core/tool porting rule: old Director agent core, AgentEngine loop, tool registry, tool prompts/descriptions, tool execution/result handling, and Plan Mode semantics are the default source of truth. Reuse them unless they conflict with AgentHost architecture, Director-owned provider/auth/secrets boundaries, Copilot isolation, or changed VS Code APIs. If a tool cannot be represented safely in the current AgentHost slice, gate or defer it instead of advertising a half-compatible tool.
- `DirectorAgentSession` resolves a `DirectorResolvedProviderBackend` from the Phase 3 secret-free snapshot and runs the AgentHost-owned `DirectorAgentEngineAdapter` instead of deterministic echo.
- The adapter builds provider-native requests from Phase 3 normalized-message request adapters, calls the selected provider, parses Anthropic Messages / OpenAI Chat Completions / OpenAI Codex Responses-shape / Gemini text responses, and emits AgentHost session actions for system notification, reasoning, markdown text, usage, completion, cancellation, and error.
- OpenAI-compatible Chat Completions and Anthropic Messages stream text/thinking deltas into stable AgentHost response parts; Gemini and OpenAI Codex Responses-shape remain non-streaming fallback paths in Phase 4.
- Tool calls flow through AgentHost client-tool and permission/result plumbing. The implementation freezes the per-turn client tool snapshot, only executes tool names advertised to the provider, maps accepted/denied/failed/disconnected results back into provider tool-result messages, executes read-only tool calls concurrently while preserving provider order, executes mutation tools serially, and ends repeated/max-turn loops as visible AgentEngine results instead of session-fatal errors.
- Phase 4.1 tool-surface follow-up restored the old Director-owned read/context implementations in the AgentHost path: `readFile`, `listDirectory`, `fileSearch`, `textSearch`, `problems`, `changes`, `viewImage`, and `githubRepo`. Director defaults now follow the old Agent-mode tool allowlist as client-tool candidates; registered browser, terminal, task, fetch/repo, and read/context tools surface through Director policy instead of a hand-made narrow subset. Reviewable edit tools and real Plan presentation remain deferred until their old review contracts are mapped to AgentHost.
- Plan Mode is recognized through AgentHost session config and deliberately gated with a visible unsupported-mode message. Real old `director_present_plan` presentation remains deferred.
- Multi-turn history is normalized into provider messages with an in-memory trim guard. Provider retry is limited to pre-tool-side-effect requests; calls are not replayed after a tool side effect has run.
- Added a narrow `directorRuntimeCredentials` reverse IPC channel. AgentHost node asks a renderer for the active provider's credential only when a real turn needs it; registry JSON, provider snapshots, AgentHost model metadata, and AHP logs stay secret-free.
- Workbench and Sessions renderers resolve Director API-key/fake OpenAI Codex OAuth credentials from Secret Storage. Workbench remains the owner of Settings UI, provider registry, auth state, secrets, model-refresh orchestration, and snapshot writing; AgentHost node owns runtime provider HTTP calls.
- Manual source-run acceptance with `.tmp\director-phase3-acceptance` confirmed `Director Settings` opens, `deepseek-v4-flash` appears in the Director model picker, Copilot sign-in is not required for Director, and a real provider-backed turn answered `DIRECTOR_PHASE4_OK`.
- Final validation passed for `compile-check-ts-native`, `valid-layers-check`, Director AgentHost tests, provider backend tests, provider adapter tests, Workbench provider service tests, AgentSideEffects client tool flow tests, and `git diff --check`.
- Deferred beyond Phase 4 / later tool-parity slices: old Director reviewable edit tools, real old Director Plan Mode presentation, local/custom runtime adapters, real provider network model discovery/validation, real OpenAI Codex OAuth browser/device flow, Claude SDK de-CAPI migration, durable session restore, and public OpenAI Responses support. `execution_subagent` remains policy-listed and will surface when its AgentHost client-tool implementation is registered. The old 120 Director replay layer has been materialized for reference at `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\reference-director-120\layers\director\vscode`; use it for complete-source inspection, not as the current fork's source of truth.

Phase 5:

- Completed locally on 2026-05-30: built `DirectorAnthropicEndpointService`, a Director-owned local Anthropic-compatible endpoint under `src/vs/platform/agentHost/node/director`.
- The endpoint is backed by `IDirectorProviderBackendHub`, resolves credentials only through `IDirectorRuntimeCredentialService`, exposes nonce/session-bearer `/v1/models` and `/v1/messages`, supports Anthropic-compatible and OpenAI-compatible streaming through the shared Director provider runtime, and aborts provider transport when the client disconnects.
- It does not import or call `ICopilotApiService`, GitHub Copilot auth, or Copilot CAPI. The existing Copilot-backed `ClaudeProxyService` remains unchanged for legacy Claude paths.
- Added provider runtime parity for Anthropic bearer auth, `thinking` request passthrough, and `cache_creation_input_tokens` usage passthrough.
- Phase 6 should wire a Director-backed Claude-like SDK harness to this endpoint and solve Copilot-logout visibility, without changing the existing Copilot-backed Claude path unless explicitly gated.

Phase 6:

- Completed locally on 2026-05-31: added `director-claude`, an optional Director-backed Claude-like AgentHost provider gated by the Claude SDK path and the Director agent env gate.
- Refactored the Claude SDK harness through a backend strategy and neutral SDK endpoint handle. Legacy `claude` still uses `ClaudeProxyService`; `director-claude` uses `IDirectorAnthropicEndpointService.start({ sessionId })`.
- `director-claude` has no protected resources and `authenticate()` returns false, so Copilot logout does not suppress or sign-in gate this provider.
- Director-backed Claude model projection comes from `IDirectorProviderBackendHub`, keeps missing-auth models as unconfigured, hides disabled/local/custom-http providers, and does not write API keys/OAuth tokens into metadata/log/snapshot surfaces.
- Deferred: real Director-backed subagent runtime selection, durable transcript partitioning, local/custom-http endpoint compatibility, and OAuth hardening beyond the existing Director credential bridge.

Phase 7:

- Completed locally on 2026-05-27: AgentHost Director model projection carries provider display name, API type, model family/version, context/output token limits, capabilities, and missing-auth status without secrets.
- Completed locally on 2026-05-27: provider HTTP/SSE execution and response parsing moved behind `src/vs/platform/agentHost/node/director/providers/**`, and `DirectorAgentEngineAdapter` now consumes that shared node runtime instead of maintaining a second hand-written provider parser.
- Completed locally on 2026-05-27: Workbench registers a `director-code` `LanguageModelChatProvider` surface that projects Director-managed registry/model metadata into broader model pickers without Copilot CAPI or GitHub Copilot auth. Direct `director-code` requests route through AgentHost Director sessions as the narrow Phase 7 bridge, keeping provider HTTP node-owned and credentials turn-time only.
- Corrected on 2026-05-30 after failed manual acceptance: adopt upstream VS Code `20ed2bc21d4 Fix offline BYOK state management (#318187)` as the configured-BYOK/no-GitHub-sign-in baseline, roll back local Chat Setup / Copilot-session visibility / multi-surface tool-confirmation experiments from `46ab6211a4b`, also roll back the `director-code` auth-metadata bypass, global `targetChatSessionType` selector filter, and private direct-LM structured-message attachment side channel. Treat direct `director-code` VS Code LM tool passthrough as unresolved.
- Provider runtime, request/stream parsing, model resolver fallback, and direct model-provider projection should continue to reuse the old Director 120 reference semantics from `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\reference-director-120\layers\director\vscode`; avoid growing a second hand-written provider stack unless AgentHost/secret/Copilot boundaries require adaptation.

Phase 8:

- Completed locally on 2026-05-31: added a minimal OAuth hardening slice with provider-instance scoped `DirectorOAuthTokenRecord` storage under Secret Storage, generic Workbench `DirectorOAuthService` lifecycle methods, expiry-aware auth state, deterministic refresh, and logout.
- OpenAI Codex keeps deterministic local/manual OAuth acceptance through the generic lifecycle; Anthropic OAuth is now available as a deterministic local/manual Provider Settings template.
- Runtime credential bridges still return bearer access tokens only and do not expose refresh tokens. Registry JSON, provider snapshots, model metadata, and AgentHost state remain token-free.
- Deferred: real OpenAI Codex browser/device OAuth, real Anthropic PKCE/manual-code exchange, VS Code `AuthenticationProvider`, provider-specific `ProtectedResourceMetadata`, network refresh endpoints, and Phase 10 telemetry/stress work.

Phase 9:

- Minimal session restore slice completed locally on 2026-05-31.
- Added `DirectorSessionStore` under `src/vs/platform/agentHost/node/director/`, persisting Director session metadata and normalized `Turn[]` in the existing per-session `session.db`.
- Added a narrow Director catalog metadata entry so `DirectorAgent.listSessions()` can surface persisted Director sessions after AgentHost restart.
- `DirectorAgent.createSession`, `sendMessage`, `changeModel`, `listSessions`, `getSessionMetadata`, `getSessionMessages`, and `truncateSession` now use the persisted store.
- Restored sessions can continue provider-backed conversation with previous user/assistant turns included in the next provider request.
- Saved model/provider/auth gaps remain listable/openable and fail through the existing recoverable send error path.
- Deferred: old Chat Agent full transcript migration, in-place cross-harness conversion, durable compaction/session-summary generation beyond this metadata/turn store.

Phase 10:

- Minimal hardening slice completed locally on 2026-05-31.
- Added `DirectorTelemetryReporter` under `src/vs/platform/agentHost/node/director/`, reusing `ITelemetryService` for Director session, provider resolution, and model-call outcome telemetry.
- Telemetry is low-cardinality and avoids prompts, responses, file paths, provider instance ids, model ids, API keys, OAuth access tokens, and refresh tokens.
- Focused tests cover restore-after-restart history reuse, saved model removal after restore, and telemetry redaction.
- Manual dogfood checklist is recorded in `doc/director-agent-provider-phase10-plan.md`.
- Deferred: full external preview readiness, broad abort/soak/leak checks, Director-backed Claude SDK transcript partition hardening, and old Chat Agent full migration.

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

Phase 11:

- Plan SDK/runtime distribution so supported non-Copilot agents do not require manual SDK path setup.
- Keep full external preview readiness, old Chat Agent transcript migration, and broad soak/leak testing as explicit follow-up unless the user expands Phase 10.
