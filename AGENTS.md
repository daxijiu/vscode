# VS Code Fork Agents Instructions

This repository is the user's VS Code fork at `E:\Projects\Director-Code-batch\vscode`.

For baseline VS Code architecture, coding style, and validation rules, always read [Copilot Instructions](.github/copilot-instructions.md). This file records project-specific direction for the Director Agent / Provider Backend work.

## Current Objective

The current workstream is to make Director an optional AgentHost-based agent, not a product-level replacement for Copilot.

Target architecture:

```text
VS Code Agent Sessions / AgentHost UI
        |
AgentHost IAgent provider
        |
Director / Claude-like / future harness adapter
        |
Director Provider Backend Hub
        |
API key / OAuth / local / compatible model providers
```

The intent is:

- keep Copilot, Copilot CLI, GitHub Copilot auth, and Copilot CAPI isolated;
- add Director and later non-Copilot agents as optional `IAgent` providers;
- make non-Copilot agents consume Director-owned provider/auth/model infrastructure;
- avoid using GitHub Copilot CAPI as the backend for Director-owned agents;
- keep the implementation narrow and AgentHost-shaped.

## Important Paths

Current fork:

- `E:\Projects\Director-Code-batch\vscode`

Current docs:

- `doc/director-agent-provider-roadmap.md`
- `doc/director-agent-provider-phase0-plan.md`
- `doc/director-agent-provider-phase1-plan.md`
- `doc/director-agent-provider-phase2-plan.md`
- `doc/director-agent-provider-phase3-plan.md`
- `doc/director-agent-provider-phase4-plan.md`
- `doc/director-agent-provider-phase5-plan.md`
- `doc/director-agent-provider-phase6-plan.md`
- `doc/director-agent-provider-phase7-plan.md`
- `doc/director-agent-provider-phase8-plan.md`
- `doc/research/claude-agenthost-phase-handoff.md`
- `doc/research/custom-agent-provider-backend-plan.md`
- `MEMORY.md`

Claude AgentHost reference inside this repo:

- `src/vs/platform/agentHost/node/claude/roadmap.md`
- `src/vs/platform/agentHost/node/claude/phase*-plan.md`
- `src/vs/platform/agentHost/node/claude/claudeAgent.ts`
- `src/vs/platform/agentHost/node/claude/claudeAgentSession.ts`
- `src/vs/platform/agentHost/node/claude/claudeProxyService.ts`

Old Director reference repo:

- `E:\Projects\Director-Code-batch\Director-Code-112-check`
- `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\layers\director\vscode`

Treat the old generated tree as reference material only. Do not copy it as the source of truth for this fork.

## Working Rules

- Start by checking `git status --short --branch`.
- Preserve user changes. Do not revert unrelated dirty files.
- Use `rg` / `rg --files` for searches.
- Keep docs UTF-8 safe; many project notes contain Chinese text.
- Use `apply_patch` for manual file edits.
- Keep implementation changes small and phase-aligned.
- Prefer new Director-owned AgentHost/provider modules over broad edits to upstream VS Code areas.
- Do not broaden ownership to all of `src/vs/platform/agentHost/**` or all of `src/vs/sessions/**`.
- Do not modify `extensions/copilot/**` unless a specific compatibility task requires it.
- Do not use `ICopilotApiService`, `GITHUB_COPILOT_PROTECTED_RESOURCE`, or Copilot CAPI in Director-owned non-Copilot backend code.

## Agentic Coding Practice

This section adapts the public Karpathy-inspired Claude Code guidance from `multica-ai/andrej-karpathy-skills` for this VS Code fork. It is a behavior layer on top of the repository-specific Director rules above.

- Think before coding: state assumptions when the task is ambiguous, surface meaningful tradeoffs, and ask when local evidence cannot resolve the uncertainty.
- Keep solutions simple: implement the smallest design that satisfies the current phase and avoid speculative configuration, future-proofing, or one-off abstractions.
- Make surgical changes: every changed line should trace back to the user's request, the current phase plan, or cleanup caused by your own edit.
- Match the surrounding code: follow existing VS Code style and Director module boundaries even when a different style would be personally preferable.
- Define success criteria for non-trivial work: turn requests into checkable outcomes such as compile-checks, focused tests, snapshot inspection, or manual acceptance steps.
- Loop until verified: after editing, run the narrowest useful validation first, broaden only when risk or changed surface justifies it, and report any unrun checks plainly.
- Do not hide confusion: if runtime evidence contradicts the plan, update the plan or memory with the corrected understanding instead of patching around the symptom.
- Prefer small diffs and clean handoffs: mention unrelated issues you notice, but do not fix or delete unrelated code unless the user explicitly asks.

## Validation

For TypeScript source changes, follow the repository rule from `.github/copilot-instructions.md`: compile-check before tests.

Common validation commands:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
```

AgentHost-focused tests, when available:

```powershell
npm run test-node -- --grep agentHost
```

For docs-only changes:

```powershell
git diff --check -- <changed-doc-paths>
```

## Current Phase Direction

The recommended implementation order is:

```text
Phase 0 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 7 -> Phase 5 -> Phase 6 -> Phase 8 -> Phase 9 -> Phase 10 -> Phase 11
```

Phase 0-3 has been accepted and committed on branch `codex/Director`. Phase 4 is implemented as an AgentHost-owned Director AgentEngine adapter slice that covers provider-backed turns, streaming, AgentHost client-tool calls, Plan Mode gating, bounded loop behavior, and in-memory context trimming.

Phase 3 ported the old Director provider registry/API-key/OpenAI Codex OAuth/model resolver semantics, added the provider protocol routing/conversion layer, and restored a practical Director Settings entry based on the old `ProviderSettingsWidget` / `DirectorCodeSettingsEditor`.

Provider runtime adapters should be AgentHost/platform-owned under `src/vs/platform/agentHost/**`; Workbench should own Settings UI, registry, auth, secrets, model-refresh orchestration, connection tests, and the secret-free provider/model/auth-state snapshot writer.

Workbench must not import AgentHost node transports. Shared compatibility, request builders, and snapshot DTOs belong under `src/vs/platform/agentHost/common/**`; AgentHost Phase 3 code consumes auth state, not raw API keys or OAuth bearer tokens.

Accepted Phase 3 implementation:

- Workbench-owned provider registry, API-key Secret Storage wrapper, deterministic OpenAI Codex fake OAuth state, model resolver, connection validation service, and secret-free snapshot writer live under `src/vs/workbench/contrib/directorCode/**`.
- AgentHost shared DTO/helpers for snapshots, compatibility routing, provider request templates, and normalized-message request adapters live under `src/vs/platform/agentHost/common/directorProvider*.ts`.
- `DirectorProviderBackendHub` reads the Workbench snapshot when available and otherwise keeps the deterministic fake fallback. Workbench also mirrors the active profile snapshot to the default-profile global storage path consumed by the local AgentHost.
- `director-code.openSettings` opens a `Director Settings` editor pane backed by `ProviderSettingsWidget`; the UI follows the old Director section layout with Connected Providers, Popular Providers, Models, Snapshot, and in-page provider modals.
- Provider setup validation is no-network by design so API-key headers are not sent through request logging; it returns a redacted request template.
- OpenAI Codex OAuth currently uses a deterministic fake Secret Storage token state for local acceptance.
- Phase 3 includes pure normalized-message request adapters for Anthropic Messages, OpenAI Chat Completions, OpenAI Codex, and Gemini request shapes. Real LLM traffic remains Phase 4.

Phase 4 should wrap the old Director `AgentEngine` as an AgentHost harness adapter. Keep Claude SDK de-CAPI migration, additional OAuth providers beyond OpenAI Codex OAuth, public OpenAI Responses support, and session restore in their later roadmap phases unless the user explicitly expands the scope.

Director Provider porting rule:

- Old Director provider runtime and model-provider projection code are the default source of truth for Phase 7 provider behavior because they were already accepted in the old Director line.
- Reference `E:\Projects\Director-Code-batch\Director-Code-112-check\vscode.generated\reference-director-120\layers\director\vscode`, especially `providerTypes.ts`, `providerFactory.ts`, `abstractProvider.ts`, `requestFetch.ts`, `openaiProvider.ts`, `anthropicProvider.ts`, `geminiProvider.ts`, `openaiCodexProvider.ts`, `modelResolver.ts`, `directorCodeModelProvider.ts`, and `providerGroupProjection.ts`.
- Reuse old request shape, streaming event, reasoning/tool/image conversion, model resolver fallback, and provider group projection semantics unless they conflict with the current AgentHost architecture, Director-owned Secret Storage boundary, or Copilot isolation.
- Workbench may own registry/auth/secrets/settings/snapshot orchestration, but it must not import AgentHost node transports or grow a second provider HTTP runtime.

Director Agent core/tool porting rule:

- Old Director agent core, AgentEngine loop, tool registry, tool prompts/descriptions, tool execution, tool result handling, and Plan Mode semantics are the default source of truth because they were already accepted in the old Director line.
- Reuse old semantics directly unless they conflict with the current AgentHost architecture, Director-owned provider/auth/secrets boundary, Copilot isolation, or changed VS Code APIs.
- If a tool's old behavior cannot be represented safely in the current AgentHost slice, do not advertise a half-compatible tool as Director-ready. Gate or defer it with a documented reason.
- Any deviation from the old implementation must be documented in the phase plan with the concrete AgentHost/security/API reason. Avoid inventing narrower prompts, loop limits, or tool behavior without evidence.

Accepted Phase 4 implementation:

- `DirectorAgentSession` now resolves a `DirectorResolvedProviderBackend` from the Phase 3 secret-free snapshot and routes the turn through an AgentHost-owned `DirectorAgentEngineAdapter`.
- A narrow `directorRuntimeCredentials` reverse IPC channel resolves API-key/OAuth credentials only at turn time; API keys and OAuth tokens are not written into registry JSON, provider snapshots, AgentHost model metadata, or AHP logs.
- The Workbench and Sessions renderers provide the runtime credential bridge from Secret Storage. AgentHost node owns runtime HTTP/provider adapter code and never imports Workbench provider UI or Copilot CAPI.
- OpenAI-compatible Chat Completions and Anthropic Messages can stream text/thinking deltas into stable AgentHost response parts. OpenAI Codex Responses-shape and Gemini remain non-streaming fallbacks in this phase.
- Tool calls flow through AgentHost client-tool and permission plumbing with provider-native schema conversion, advertised-tool gating, per-turn tool snapshots, rejected/failed/disconnected client handling, and a bounded iteration guard.
- The first old Director tool-surface parity slice restores Director-owned read/context implementations (`readFile`, `listDirectory`, `fileSearch`, `textSearch`, `problems`, `changes`, `viewImage`, `githubRepo`) in the AgentHost client-tool path, restores the old Agent-mode tool allowlist as Director's default client-tool candidate list, passes AgentHost working directories into tool invocation context, and rejects `openBrowserPage` calls that try to open local paths or `file://` URIs.
- Plan Mode is recognized through AgentHost session config and deliberately gated with a clear message until old `director_present_plan` semantics have an AgentHost-shaped command/action contract.
- Multi-turn history is normalized into provider messages with an in-memory trim guard; provider retry is side-effect-safe and does not replay calls after a tool side effect has run.
- Deferred beyond Phase 4 / later tool-parity slices: old Director reviewable edit tools, real old Director Plan Mode presentation, durable compaction/session restore, local/custom runtime adapters, public OpenAI Responses support separate from OpenAI Codex, Claude SDK de-CAPI, and additional OAuth hardening. `execution_subagent` remains policy-listed and will surface when its AgentHost client-tool implementation is registered.

Current Phase 7 baseline:

- AgentHost Director model projection now carries provider display name, API type, model family/version, context/output token limits, capabilities, and missing-auth status without writing secrets into model metadata.
- Provider HTTP/SSE runtime execution and response parsing live under `src/vs/platform/agentHost/node/director/providers/**`; common code keeps DTOs and pure helpers only.
- `DirectorAgentEngineAdapter` consumes the shared node provider runtime while preserving provider-backed turns, DeepSeek/OpenAI-compatible `reasoning_content` fallback, provider-native tool calls, usage reporting, retry classification, and no retry after side-effecting tools.
- Workbench registers a `director-code` `LanguageModelChatProvider` surface that projects Director-managed models from the Workbench registry/model resolver into broader VS Code model pickers without Copilot CAPI or GitHub Copilot auth.
- Upstream VS Code `20ed2bc21d4 Fix offline BYOK state management (#318187)` is the source of truth for the configured-BYOK/no-GitHub-sign-in gate; do not add Director-specific Chat Setup or Copilot login bypasses.
- The rejected 2026-05-28 repair experiments were rolled back: no eager `selectLanguageModels` startup workaround, no global `targetChatSessionType` selector filter, no `director-code` auth-metadata bypass, and no private direct-LM structured-message attachment side channel. Direct `director-code` requests still use the narrow Phase 7 AgentHost-session bridge and are not accepted for tool-heavy generic chat yet.
- Provider Settings / Refresh Models remain Workbench-owned and secret-redacted.

Accepted Phase 5 implementation:

- `DirectorAnthropicEndpointService` lives under `src/vs/platform/agentHost/node/director` as an additive Director-owned local Anthropic-compatible endpoint.
- It binds to `127.0.0.1`, uses nonce/session bearer auth, exposes `/v1/models`, `/v1/messages`, and a clear unsupported `count_tokens` response, and aborts provider transport when the SDK/client disconnects.
- It resolves provider/model selection through `IDirectorProviderBackendHub`, resolves credentials only through `IDirectorRuntimeCredentialService`, and calls the shared Director provider runtime. It does not import or call `ICopilotApiService`, GitHub Copilot auth, or Copilot CAPI.
- Anthropic-compatible and OpenAI-compatible backends can produce Anthropic JSON/SSE output for SDK-compatible consumers. Local/custom-http providers remain gated until a compatible runtime contract exists.
- The existing Copilot-backed `ClaudeProxyService` remains unchanged. Phase 6 wires a Director-backed Claude-like SDK harness to the new endpoint and handles Copilot-logout visibility.

Accepted Phase 6 implementation:

- `director-claude` is an optional AgentHost Claude-like provider registered only when the Claude SDK path exists and the Director agent gate is enabled.
- The reusable Claude SDK/session pipeline is shared through a backend strategy; legacy `claude` remains Copilot-backed through `ClaudeProxyService`, while `director-claude` starts `IDirectorAnthropicEndpointService` with the current `sessionId`.
- `director-claude` has no protected resources and `authenticate()` returns false, so it does not trigger GitHub Copilot login.
- Director-backed Claude models come from `IDirectorProviderBackendHub`; missing-auth models remain visible as `PolicyState.Unconfigured`, while disabled/local/custom-http providers are hidden.
- `claudeSdkOptions` now consumes a neutral SDK endpoint handle instead of depending on `IClaudeProxyHandle`; endpoint handles are disposed after the SDK session pipeline.
- API keys/OAuth tokens remain behind Director runtime credential resolution and are not written into model metadata, provider snapshots, AgentHost protocol state, or SDK options logs.

Current Phase 8 minimal slice:

- Director OAuth tokens are provider-instance scoped `DirectorOAuthTokenRecord`s in Secret Storage with provider id, auth variant, identity key, access token, optional refresh token, optional expiry, and timestamps.
- OpenAI Codex keeps deterministic local/manual OAuth acceptance through the generic lifecycle.
- Anthropic OAuth is available as a deterministic local/manual Provider Settings template with provider-specific auth state.
- Runtime credential bridges return bearer access tokens only; refresh tokens are not exposed to AgentHost, snapshots, model metadata, registry JSON, or logs.
- Real browser/device OAuth, real Anthropic PKCE exchange, VS Code `AuthenticationProvider`, and provider-specific `ProtectedResourceMetadata` integration remain deferred.
