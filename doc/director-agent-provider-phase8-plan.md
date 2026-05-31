# Director Agent Provider Phase 8 Plan

Status: minimal implementation slice completed locally on 2026-05-31.

## Goal

Phase 8 hardens the OAuth support introduced in Phase 3 and adds a second non-Copilot OAuth provider path without changing the AgentHost tool surface or later session-restore work.

This slice keeps OAuth state Workbench-owned:

- OAuth tokens live only in Secret Storage.
- Registry JSON, provider snapshots, model metadata, AgentHost protocol state, and runtime logs stay token-free.
- AgentHost asks for credentials only through the existing `directorRuntimeCredentials` bridge and receives only a bearer access token.
- Director-owned OAuth identity never uses GitHub Copilot auth, GitHub Copilot bearer tokens, Copilot CAPI, or `GITHUB_COPILOT_PROTECTED_RESOURCE`.

## Implemented Slice

- Added a shared `DirectorOAuthTokenRecord` shape under `src/vs/platform/agentHost/common/directorRuntimeCredentials.ts`.
- The record is provider-instance scoped and stores `providerInstanceId`, provider id, auth variant, identity key, access token, optional refresh token, optional expiry, and timestamps.
- `DirectorOAuthService` now exposes a generic provider-scoped lifecycle:
  - deterministic local/manual sign-in;
  - explicit token storage;
  - expiry-aware auth state;
  - deterministic refresh when a refresh token exists;
  - logout;
  - access-token-only runtime resolution.
- Kept the existing OpenAI Codex deterministic local acceptance path through compatibility wrappers.
- Added an Anthropic OAuth provider template in Provider Settings, using the generic lifecycle and a provider-specific identity key.
- Provider Settings OAuth dialogs now use generic sign-in/sign-out, show expired/error status, and expose a refresh-token action for the local deterministic flow.
- Added focused Workbench provider-service tests for OpenAI Codex token-record migration, Anthropic OAuth state, snapshot redaction, runtime credential resolution, expiry, refresh, and logout.

## Boundaries

- No changes under `extensions/copilot/**`.
- No Director-owned path imports or calls `ICopilotApiService`, GitHub Copilot auth, GitHub Copilot bearer tokens, Copilot CAPI, or `GITHUB_COPILOT_PROTECTED_RESOURCE`.
- Workbench still owns Provider Settings, registry, Secret Storage, auth state, model refresh orchestration, and secret-free snapshots.
- AgentHost node still owns runtime/provider HTTP adapters and consumes only snapshot metadata plus turn-time credentials.
- The existing `director`, `director-claude`, and direct `director-code` model-provider paths continue to use the existing credential bridge.

## Acceptance

- OpenAI Codex OAuth still supports deterministic local sign-in/sign-out for acceptance.
- Anthropic OAuth can be added from Provider Settings, can sign in/out, and produces provider-specific ready/signed-out/expired auth state.
- Expired OAuth tokens are not returned as runtime credentials.
- Refresh-token state can refresh to a new access token inside Workbench without exposing the refresh token to AgentHost.
- Registry and snapshot files do not contain OAuth access tokens or refresh tokens.
- OAuth-backed Director models remain governed by their own provider auth state and do not depend on Copilot login.

## Deferred

- Real OpenAI Codex browser/device flow.
- Real Anthropic PKCE/manual-code exchange.
- VS Code `AuthenticationProvider` and provider-specific `ProtectedResourceMetadata` integration. This slice records provider-specific OAuth identity in Director-owned Secret Storage records and snapshot auth-state identity keys only.
- Token refresh through real network endpoints.
- OAuth telemetry and stress tests from Phase 10.
- Durable session restore from Phase 9.

## Validation

Required validation for this slice:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
npx -y node@24 test/unit/node/index.js --run src/vs/workbench/contrib/directorCode/test/common/provider/directorProviderServices.test.ts
git diff --check
rg -n "ICopilotApiService|GITHUB_COPILOT_PROTECTED_RESOURCE|copilotApi|CAPI|GitHub Copilot" src/vs/workbench/contrib/directorCode src/vs/platform/agentHost/common/directorRuntimeCredentials.ts src/vs/platform/agentHost/node/director src/vs/sessions/contrib/providers/agentHost/browser/directorRuntimeCredentialBridge.ts
```

Broaden to AgentHost Director tests if credential bridge or backend resolution behavior changes beyond this slice.
