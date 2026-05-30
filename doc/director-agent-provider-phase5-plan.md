# Director Agent Provider Phase 5 Plan

Status: implemented locally on 2026-05-30.

## Goal

Create a reusable local Anthropic-compatible endpoint backed by Director Provider Backend Hub, so later Claude-like SDK harness work can use Director-managed providers without GitHub Copilot CAPI.

## Implemented Slice

- Added `DirectorAnthropicEndpointService` under `src/vs/platform/agentHost/node/director`.
- The endpoint binds to `127.0.0.1`, uses the existing `Bearer <nonce>.<sessionId>` proxy auth shape, exposes `GET /`, `GET /v1/models`, `POST /v1/messages`, and a clear 501 for `POST /v1/messages/count_tokens`.
- `POST /v1/messages` resolves Director provider/model selection through `IDirectorProviderBackendHub`, resolves credentials only through `IDirectorRuntimeCredentialService`, then calls the shared Director provider runtime.
- Responses are converted back to Anthropic-compatible JSON or SSE. Streaming OpenAI-compatible and Anthropic-compatible backends are supported through the existing Director runtime event shape.
- Registered the service in both AgentHost entrypoints without changing the existing Copilot-backed `ClaudeProxyService`.
- Extended the Director provider request adapter/runtime for Anthropic bearer auth, `thinking` request passthrough, and `cache_creation_input_tokens` usage passthrough.

## Boundaries

- No `ICopilotApiService`, GitHub Copilot auth, GitHub token, or Copilot CAPI dependency is introduced under `src/vs/platform/agentHost/node/director`.
- API keys and OAuth/bearer tokens are resolved only at request time through the runtime credential bridge and are not written to snapshots, model metadata, logs, or endpoint responses.
- Existing Copilot-backed Claude provider/proxy remains intact. Phase 6 will decide how to wire a Director-backed Claude-like harness to this endpoint.
- Local/custom-http providers remain unsupported for this endpoint until a compatible runtime contract exists.

## Validation

- `npm run compile-check-ts-native`
- `npx -y node@24 test/unit/node/index.js --run src/vs/platform/agentHost/test/node/directorAnthropicEndpointService.test.ts`
- `npx -y node@24 test/unit/node/index.js --run src/vs/platform/agentHost/test/common/directorProviderAdapters.test.ts`
- `npx -y node@24 test/unit/node/index.js --run src/vs/platform/agentHost/test/node/directorAgent.test.ts`

## Deferred To Phase 6

- Switching the Claude-like SDK harness from `IClaudeProxyService.start(githubToken)` to the Director-backed endpoint.
- Advertising a Director-backed Claude-like provider independently from GitHub Copilot login.
- Mapping Claude SDK model/session config into Director provider/model selection.
