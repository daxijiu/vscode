# Director Agent Provider Phase 4 Plan

Updated: 2026-05-26

## Goal

Move the current Director AgentHost provider from deterministic echo to a minimal provider-backed Director AgentEngine turn, while preserving the Phase 3 registry/auth/snapshot boundary.

## Implemented Slice

- `DirectorAgentSession` resolves the selected AgentHost model through `DirectorProviderBackendHub`.
- `DirectorAgentEngineAdapter` converts AgentHost turns and attachments into normalized Director messages, builds the provider-native request with Phase 3 request adapters, sends one non-streaming provider request, and maps the result back into AgentHost session actions.
- Runtime credentials flow through the narrow `directorRuntimeCredentials` reverse IPC channel only when a turn needs them.
- Workbench and Sessions renderers resolve API-key or fake OpenAI Codex OAuth credentials from Secret Storage; AgentHost node receives only the credential needed for the active request.
- Registry JSON, provider snapshots, AgentHost model metadata, and AHP logs remain secret-free.

## Adapter Boundaries

- AgentHost runtime code lives under `src/vs/platform/agentHost/**`.
- Shared request builders, snapshot DTOs, and runtime credential IPC contracts live under `src/vs/platform/agentHost/common/**`.
- Workbench owns Director Settings, provider registry, auth state, Secret Storage wrappers, and snapshot writing under `src/vs/workbench/contrib/directorCode/**`.
- The Sessions renderer contributes only a runtime credential bridge so the Agents window can serve credentials to local AgentHost without importing Workbench UI or AgentHost node transports.

## Manual Acceptance Steps

Use the source-run acceptance profile:

```powershell
$env:VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT='1'
$env:VSCODE_SKIP_PRELAUNCH='1'
.\scripts\code.bat --remote-debugging-port=<free-port> --skip-sessions-welcome --user-data-dir .\.tmp\director-phase3-acceptance\user-data --extensions-dir .\.tmp\director-phase3-acceptance\extensions --shared-data-dir .\.tmp\director-phase3-acceptance\shared-data --skip-welcome --skip-release-notes .
```

Acceptance checks:

- Confirm `chat.agentHost.enabled=true` and `chat.agentHost.directorAgent.enabled=true` in the profile settings.
- Open `Director Settings`.
- Confirm configured providers and visible models appear in the Settings summary and in the secret-free provider snapshot.
- Open the Agents window while Copilot is signed out.
- Pick session type `Director`.
- Pick a configured model such as `deepseek-v4-flash`.
- Send `Reply exactly: DIRECTOR_PHASE4_OK`.
- Confirm the response includes `DIRECTOR_PHASE4_OK` and the selected Director model, proving the turn is provider-backed rather than deterministic echo.
- Confirm missing provider/model/credentials paths show understandable `directorAgentEngine` errors and do not crash the Agents window.
- Scan registry, snapshot, and current AHP/window logs for token-shaped values; only non-secret metadata such as `authKind: api-key` and Copilot protected-resource metadata should appear.

## Validation

Required before commit:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorAgent.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts
npm run test-node -- --run src/vs/platform/agentHost/test/common/directorProviderAdapters.test.ts
npm run test-node -- --run src/vs/workbench/contrib/directorCode/test/common/provider/directorProviderServices.test.ts
git diff --check
```

## Deferred Follow-Ups

- Stream provider deltas instead of only non-streaming text responses.
- Reintroduce old Director tool call semantics through AgentHost permission/tool UI.
- Reintroduce or explicitly gate old Director Plan Mode as AgentHost session state.
- Add real provider-backed model discovery and network validation.
- Replace deterministic fake OpenAI Codex OAuth with real browser/device flow.
- Keep Claude SDK de-CAPI migration, durable session restore, and public OpenAI Responses support in their later roadmap phases.
