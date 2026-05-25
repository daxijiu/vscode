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

Phase 0-2 has been accepted, committed, and pushed. The current active work is Phase 3.

Phase 3 should port the old Director provider registry/API-key/OpenAI Codex OAuth/model resolver semantics, add the provider protocol routing/conversion layer, and restore a practical Director Settings entry based on the old `ProviderSettingsWidget` / `DirectorCodeSettingsEditor`.

Provider runtime adapters should be AgentHost/platform-owned under `src/vs/platform/agentHost/**`; Workbench should own Settings UI, registry, auth, secrets, model-refresh orchestration, connection tests, and the secret-free provider/model/auth-state snapshot writer.

Workbench must not import AgentHost node transports. Shared compatibility, request builders, and snapshot DTOs belong under `src/vs/platform/agentHost/common/**`; AgentHost Phase 3 code consumes auth state, not raw API keys or OAuth bearer tokens.

Current Phase 3 local slice:

- Workbench-owned provider registry, API-key Secret Storage wrapper, deterministic OpenAI Codex fake OAuth state, model resolver, and secret-free snapshot writer are being implemented under `src/vs/workbench/contrib/directorCode/**`.
- AgentHost shared DTO/helpers for snapshots, compatibility routing, and provider request templates live under `src/vs/platform/agentHost/common/directorProvider*.ts`.
- `DirectorProviderBackendHub` reads the Workbench snapshot when available and otherwise keeps the deterministic fake fallback.
- `director-code.openSettings` currently opens a QuickInput acceptance shell, not the full old editor-pane settings UI yet.
- Provider setup validation is no-network by design so API-key headers are not sent through request logging.
- OpenAI Codex OAuth currently uses a deterministic fake Secret Storage token state for local acceptance.

Do not jump directly to real Director `AgentEngine` traffic, Claude SDK de-CAPI migration, additional OAuth providers beyond OpenAI Codex OAuth, public OpenAI Responses support, or session restore before Phase 3 proves the provider settings, OAuth, protocol routing/conversion, and backend boundary.
