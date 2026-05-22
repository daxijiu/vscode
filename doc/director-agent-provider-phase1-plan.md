# Phase 1 Plan - Provider Backend Contracts

> Handoff plan for Phase 1 of the Director Agent / Provider Backend roadmap. Execute after Phase 0 decisions are recorded. Cross-reference [director-agent-provider-roadmap.md](./director-agent-provider-roadmap.md).

## 1. Goal

Add the minimal provider/backend contracts needed by future non-Copilot agents without wiring real user secrets, OAuth, or real LLM traffic.

This phase establishes the type boundary between AgentHost runtime code and the Director-owned provider backend hub. It deliberately avoids `ICopilotApiService`, `CCAModel`, Secret Storage, and real provider HTTP calls.

## 2. Scope

In scope:

- Provider instance references.
- Provider model metadata independent of Copilot CAPI.
- Provider capabilities.
- Resolved backend shape.
- Missing-auth / disabled-provider / missing-model status shapes.
- Provider backend hub service interface.
- Test-only fake/in-memory backend hub.
- Unit tests for registration, model listing, backend resolution, and error states.

Out of scope:

- Secret Storage.
- OAuth.
- Real OpenAI / Anthropic / Gemini requests.
- Model API refresh.
- Provider Settings UI.
- Agent registration.
- Old Director `AgentEngine`.

## 3. Files to Create or Modify

| Action | File | Purpose |
|---|---|---|
| Create | `src/vs/platform/agentHost/common/directorProviderBackend.ts` | Common provider/backend contracts consumed by AgentHost and tests. |
| Create | `src/vs/platform/agentHost/node/director/directorProviderBackendHub.ts` | In-memory backend hub implementation used by early phases and tests. |
| Create | `src/vs/platform/agentHost/test/node/directorProviderBackend.test.ts` | Unit tests for contract behavior and fake hub. |
| Optional modify | `src/vs/platform/agentHost/test/node/AGENTS.md` | Only if a new test convention needs to be recorded. |

Do not modify `src/vs/platform/agentHost/node/shared/copilotApiService.ts`.

## 4. Contract Shape

The exact names can evolve during implementation, but the contract should keep this shape.

### Provider Identity

```ts
export type DirectorProviderKind =
	| 'anthropic'
	| 'anthropic-compatible'
	| 'openai'
	| 'openai-compatible'
	| 'openai-codex'
	| 'gemini'
	| 'local'
	| 'custom-http';

export type DirectorProviderAuthKind = 'none' | 'api-key' | 'oauth' | 'bearer';
```

### Provider Model

```ts
export interface DirectorProviderModel {
	readonly providerInstanceId: string;
	readonly id: string;
	readonly name: string;
	readonly family?: string;
	readonly maxContextWindow?: number;
	readonly supportsVision: boolean;
	readonly capabilities?: DirectorProviderCapabilities;
}
```

`DirectorProviderModel` must not depend on `CCAModel`. If a later provider reads CAPI-like data, conversion belongs at that provider boundary, not in this common type.

### Capabilities

```ts
export interface DirectorProviderCapabilities {
	readonly streaming?: boolean;
	readonly toolCalling?: boolean;
	readonly thinking?: boolean;
	readonly vision?: boolean;
	readonly agentMode?: boolean;
}
```

### Resolved Backend

```ts
export interface DirectorResolvedProviderBackend {
	readonly providerInstanceId: string;
	readonly providerKind: DirectorProviderKind;
	readonly apiType: 'anthropic-messages' | 'openai-completions' | 'openai-codex' | 'gemini-generative' | 'local' | 'custom-http';
	readonly modelId: string;
	readonly auth: DirectorResolvedProviderAuth;
	readonly baseURL?: string;
	readonly headers?: Record<string, string>;
	readonly capabilities?: DirectorProviderCapabilities;
	readonly identityKey?: string;
}
```

Auth shape:

```ts
export type DirectorResolvedProviderAuth =
	| { readonly kind: 'none' }
	| { readonly kind: 'api-key'; readonly value: string }
	| { readonly kind: 'bearer'; readonly accessToken: string; readonly refreshToken?: string; readonly clientId?: string };
```

In Phase 1 fake implementations may include literal fake credentials, but production registry state must not persist this resolved auth object.

### Resolution Result

Use a discriminated union instead of throwing for expected user configuration states.

```ts
export type DirectorBackendResolution =
	| { readonly status: 'ok'; readonly backend: DirectorResolvedProviderBackend }
	| { readonly status: 'missingAuth'; readonly providerInstanceId: string; readonly message: string }
	| { readonly status: 'disabled'; readonly providerInstanceId: string; readonly message: string }
	| { readonly status: 'modelUnavailable'; readonly providerInstanceId: string; readonly modelId: string; readonly message: string }
	| { readonly status: 'error'; readonly message: string };
```

### Hub Interface

```ts
export interface IDirectorProviderBackendHub {
	readonly _serviceBrand: undefined;

	listProviderInstances(): Promise<readonly DirectorProviderInstance[]>;
	listModels(providerInstanceId?: string): Promise<readonly DirectorProviderModel[]>;
	resolveBackend(selection?: DirectorProviderSelection): Promise<DirectorBackendResolution>;
}
```

Register a decorator if the implementation is intended for DI:

```ts
export const IDirectorProviderBackendHub = createDecorator<IDirectorProviderBackendHub>('directorProviderBackendHub');
```

## 5. Implementation Steps

### Step 1 - Add Common Types

Create `directorProviderBackend.ts` with:

- provider kind literals;
- auth kind literals;
- model interface;
- capability interface;
- resolved backend interface;
- resolution union;
- hub interface;
- small helper functions for:
  - checking `status === 'ok'`;
  - converting a provider model to `IAgentModelInfo`;
  - selecting a default model.

Keep helpers pure and fully unit-testable.

### Step 2 - Add In-Memory Hub

Create `directorProviderBackendHub.ts` with a small implementation:

- Constructor accepts optional provider instance/model fixtures.
- Default fixture exposes one enabled fake provider:
  - provider instance id: `director-fake`;
  - provider kind: `local`;
  - model id: `echo`;
  - model display name: `Director Echo`;
  - capabilities: streaming + toolCalling false.
- `listProviderInstances()` returns enabled and disabled fixtures.
- `listModels(providerInstanceId?)` filters models by instance.
- `resolveBackend(selection?)` returns:
  - `ok` for enabled fixture with model;
  - `disabled` for disabled provider;
  - `modelUnavailable` for unknown model;
  - `missingAuth` for an API-key fixture without fake auth.

This is a development/test scaffold, not the final provider registry.

### Step 3 - Keep Copilot Out

Add a unit test or static assertion that Phase 1 files do not import:

- `ICopilotApiService`;
- `CCAModel`;
- Claude proxy services.

The simplest test can be a source text assertion in `directorProviderBackend.test.ts` or a review checklist. Prefer normal behavior tests if source assertions feel too brittle.

### Step 4 - Unit Tests

Test cases:

- default fake provider is listed;
- default fake model is listed;
- resolving no selection returns the default fake backend;
- resolving explicit provider/model returns expected backend;
- disabled provider returns `disabled`;
- unknown model returns `modelUnavailable`;
- API-key fixture without auth returns `missingAuth`;
- helper converts `DirectorProviderModel` to `IAgentModelInfo` without CAPI fields.

## 6. Validation

Primary validation:

```powershell
npm run compile-check-ts-native
```

Targeted tests:

```powershell
npm run test-node -- --grep directorProviderBackend
```

Layering:

```powershell
npm run valid-layers-check
```

If targeted `test-node -- --grep` is not supported in the local package scripts, use the nearest existing AgentHost node test command and document the exact command that worked.

## 7. Exit Criteria

- `directorProviderBackend.ts` exists and has no dependency on Copilot CAPI types.
- `directorProviderBackendHub.ts` provides a fake/in-memory backend suitable for Phase 2.
- Tests cover success and expected configuration-error states.
- `npm run compile-check-ts-native` passes.
- `npm run valid-layers-check` passes or any failure is clearly unrelated/pre-existing and documented.

## 8. Open Questions

- Should the fake hub be compiled into product code behind a development gate, or live only in tests once Phase 3 starts?
- Should `local` and `custom-http` be separate provider kinds or one provider kind with a transport field?
- Should `DirectorProviderModel.id` be raw model id, while AgentHost model id includes provider instance id?
- Should conversion to `IAgentModelInfo.provider` use agent provider id (`director`) or backend provider id (`director-fake`)? Phase 2 should likely use agent provider id for AgentHost model picker compatibility.
