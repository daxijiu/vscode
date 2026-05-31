# Director Agent Provider Phase 6 Plan

Status: minimal implementation slice completed locally on 2026-05-31.

## Goal

Phase 6 de-CAPIs the Claude-like SDK harness by adding a Director-backed provider path that can use the Phase 5 `DirectorAnthropicEndpointService` instead of GitHub Copilot CAPI.

The accepted slice is deliberately additive:

- legacy `claude` remains Copilot-backed and keeps using `ClaudeProxyService`;
- new `director-claude` is Director-backed and has no GitHub/Copilot protected resources;
- both providers reuse the same Claude SDK session, mapper, client-tool, customization, and lifecycle pipeline.

## Implemented Slice

- Added `IClaudeSdkEndpointHandle` as the neutral SDK endpoint handle: `{ baseUrl, nonce, dispose }`.
- Added `IClaudeAgentBackend` and moved the legacy Copilot auth/model/proxy behavior into `CopilotClaudeAgentBackend`.
- Refactored the reusable Claude SDK provider implementation into `ClaudeSdkAgent`; `ClaudeAgent` is now the small legacy Copilot-backed subclass.
- Added `DirectorClaudeAgent` with provider id `director-claude`.
- Registered `director-claude` in `agentHostMain.ts` and `agentHostServerMain.ts` only when the Claude SDK path exists and the Director agent gate is enabled.
- Made `DirectorClaudeAgent` project models from `IDirectorProviderBackendHub`, keeping missing-auth models visible as unconfigured and hiding disabled/local/custom-http providers.
- Made `DirectorClaudeAgent` start `IDirectorAnthropicEndpointService` with the current `sessionId` and Director provider at materialization time, then pass the resulting endpoint into `claudeSdkOptions.buildOptions()`.
- Kept `director-claude` session selection pinned to the Director provider only; the endpoint resolves each SDK request `model` within that provider so materialized `changeModel()` updates remain live instead of reusing the materialization-time model.
- Added focused `directorClaudeAgent.test.ts` coverage for provider identity/auth, Director model projection, SDK options endpoint env, selected/default model propagation, and endpoint dispose ordering.

## Boundaries

- No changes under `extensions/copilot/**`.
- No Director-owned path imports or calls `ICopilotApiService`, `GITHUB_COPILOT_PROTECTED_RESOURCE`, GitHub tokens, or Copilot CAPI.
- `ClaudeProxyService` remains legacy Claude-only and is not turned into a universal provider backend.
- API keys and OAuth tokens stay behind `IDirectorRuntimeCredentialService`; they are not written to model metadata, provider snapshots, AgentHost protocol state, or SDK options logs.

## Deferred

- Real Director-backed Claude subagent runtime selection for `runSubagent` / `execution_subagent`.
- Durable transcript/session partitioning beyond provider-specific AgentHost session URIs and metadata stores.
- OAuth provider hardening beyond the existing Phase 3/5 credential bridge.
- Local/custom-http provider support in the Anthropic-compatible endpoint.

## Validation

Required validation for this slice:

```powershell
npm run compile-check-ts-native
npm run transpile-client
npx -y node@24 test/unit/node/index.js --run src/vs/platform/agentHost/test/node/directorClaudeAgent.test.ts
npx -y node@24 test/unit/node/index.js --run src/vs/platform/agentHost/test/node/directorAnthropicEndpointService.test.ts
npm run valid-layers-check
git diff --check
```

If the local default `node` is 22, use `npx -y node@24 test/unit/node/index.js --run <test-file>` for focused out tests after `npm run transpile-client`.
