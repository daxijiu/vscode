# Phase 2 Plan - Minimal Non-Copilot `IAgent`

> Handoff plan for Phase 2 of the Director Agent / Provider Backend roadmap. Execute after Phase 1 contracts exist. Cross-reference [director-agent-provider-roadmap.md](./director-agent-provider-roadmap.md).

## 1. Goal

Prove that the current VS Code AgentHost / Agent Sessions surface can host a Director-owned, non-Copilot agent provider with narrow, controlled changes.

The first `DirectorAgent` is intentionally fake/echo-backed. It should create a session, publish a model, stream a deterministic assistant response, support abort/dispose, and leave all Copilot and current Claude behavior unchanged.

## 2. Scope

In scope:

- Add an opt-in `DirectorAgent implements IAgent`.
- Register it beside `CopilotAgent` and the existing gated `ClaudeAgent`.
- Gate it behind a setting/env var.
- Consume the Phase 1 fake provider backend hub.
- Create/list/dispose sessions.
- Publish one or more fake/static models.
- Implement `sendMessage()` with deterministic streamed markdown response.
- Implement `abortSession()` for in-flight fake turns.
- Implement minimal `getSessionMessages()` for current-process sessions.
- Add unit tests.

Out of scope:

- Real LLM calls.
- Secret Storage.
- OAuth.
- Old Director `AgentEngine`.
- Claude SDK subprocess.
- Provider Settings UI.
- Plan Mode.
- Tools beyond no-op client-tool method stubs.
- Session restore across process restart.

## 3. Files to Create or Modify

| Action | File | Purpose |
|---|---|---|
| Create | `src/vs/platform/agentHost/node/director/directorAgent.ts` | `IAgent` provider shell and session orchestration. |
| Create | `src/vs/platform/agentHost/node/director/directorAgentSession.ts` | Minimal per-session state, fake streaming, abort, in-memory turns. |
| Modify | `src/vs/platform/agentHost/common/agentService.ts` | Add Director setting/env constants if Phase 0 chose this location. |
| Modify | `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` | Register the experimental Director AgentHost setting. |
| Modify | `src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts` | Forward setting/env gate into local utility process. |
| Modify | `src/vs/platform/agentHost/node/nodeAgentHostStarter.ts` | Forward setting/env gate into node child-process fallback. |
| Modify | `src/vs/platform/agentHost/node/agentHostMain.ts` | Register backend hub and gated `DirectorAgent`. |
| Modify | `src/vs/platform/agentHost/node/agentHostServerMain.ts` | Register backend hub and gated `DirectorAgent` for server/headless path. |
| Create | `src/vs/platform/agentHost/test/node/directorAgent.test.ts` | Unit tests for provider shell and fake session behavior. |

Avoid modifying:

- `extensions/copilot/**`
- `src/vs/platform/agentHost/node/shared/copilotApiService.ts`
- `src/vs/platform/agentHost/node/claude/**`, unless tests reveal a shared helper is required.

## 4. Dependency Assumptions

Phase 2 assumes Phase 1 has provided:

- `IDirectorProviderBackendHub`;
- `DirectorProviderBackendHub`;
- `DirectorProviderSelection`;
- `DirectorBackendResolution`;
- `toAgentModelInfo(...)` or equivalent conversion helper;
- a default fake provider with at least one model.

If Phase 1 chose different names, update this plan before implementing Phase 2 rather than adapting ad hoc in code.

## 5. Feature Gate

Recommended constants:

```ts
export const AgentHostDirectorAgentEnabledSettingId = 'chat.agentHost.directorAgent.enabled';
export const AgentHostEnableDirectorAgentEnvVar = 'VSCODE_AGENT_HOST_ENABLE_DIRECTOR_AGENT';
```

Recommended setting:

- id: `chat.agentHost.directorAgent.enabled`
- type: boolean
- default: `false`
- tags: experimental / advanced if consistent with nearby AgentHost settings
- description: "Experimental. Enables the Director Agent provider inside AgentHost. Requires `chat.agentHost.enabled`. The agent host process must be restarted for changes to take effect."

Registration rule:

- If env var is truthy, register `DirectorAgent`.
- If setting is true, starters forward env var.
- If neither is set, no `director` provider appears in root state.

Env forwarding should mirror the existing Claude SDK path pattern:

- workbench setting -> `electronAgentHostStarter.ts` env;
- workbench setting -> `nodeAgentHostStarter.ts` env;
- direct env var still wins for command-line/dev launches.

Do not add a product-level default chat agent change.

## 6. `DirectorAgent` Spec

### Provider Identity

```ts
readonly id: AgentProvider = 'director';
```

Descriptor:

```ts
{
	provider: 'director',
	displayName: localize('directorAgent.displayName', "Director"),
	description: localize('directorAgent.description', "Director agent backed by Director Provider Backend"),
}
```

Protected resources:

```ts
getProtectedResources(): ProtectedResourceMetadata[] {
	return [];
}
```

Authentication:

```ts
async authenticate(_resource: string, _token: string): Promise<boolean> {
	return false;
}
```

Phase 2 has no OAuth or API key resource. Returning `false` for every resource keeps the agent out of AgentHost auth fan-out.

### Models

`DirectorAgent.models` should be an observable derived from the Phase 1 backend hub.

At startup:

- call `listModels()`;
- convert `DirectorProviderModel` to `IAgentModelInfo`;
- use `provider: 'director'` in `IAgentModelInfo`, because AgentHost model selection is scoped to the agent provider.

If model loading fails:

- log the error;
- publish `[]`;
- do not throw during agent registration.

Refresh rules:

- Phase 2 may refresh models once in the constructor or an explicit `initialize()` path.
- Do not add file/config watchers in Phase 2.
- If the fake backend supports fixtures changing in tests, expose a private/test-only refresh method or construct a new agent per test.

### Session Lifecycle

`createSession(config)`:

- choose existing `config.session` or create `AgentSession.uri('director', generateUuid())`;
- resolve selected model if provided, otherwise use first backend model;
- create a `DirectorAgentSession`;
- store it in a `DisposableMap` or equivalent map keyed by raw session id;
- return `IAgentCreateSessionResult` with session URI, working directory, and optional project metadata.

Session metadata:

- `startTime`: Date.now() at construction.
- `modifiedTime`: update on `sendMessage`, `abortSession`, and `changeModel`.
- `project`: optional. If `config.workingDirectory` is present, use a simple project display name based on basename; otherwise omit project in Phase 2.
- `agent`: do not set custom markdown agent selection in Phase 2.

`listSessions()`:

- return in-memory session metadata for current-process sessions.
- Persisted restore is Phase 9.

`disposeSession(session)`:

- abort any in-flight fake turn;
- delete session entry;
- dispose resources.

`shutdown()`:

- dispose every session.

Expected in-memory maps:

```ts
private readonly _sessions = this._register(new DisposableMap<string, DirectorAgentSession>());
```

Use `AgentSession.id(session)` as the map key. Avoid `session.toString()` as the primary key because URI formatting caches can make tests more fragile.

### `sendMessage()` Fake Stream

`AgentSideEffects` already routes the client `SessionTurnStarted` action to `IAgent.sendMessage()`. The fake agent should emit response actions, not a second turn-start action.

Suggested action sequence:

```ts
this._onDidSessionProgress.fire({
	kind: 'action',
	session,
	action: {
		type: ActionType.SessionResponsePart,
		turnId,
		part: {
			kind: ResponsePartKind.Markdown,
			id: generateUuid(),
			content: `Director echo: ${prompt}`,
		},
	},
});

this._onDidSessionProgress.fire({
	kind: 'action',
	session,
	action: {
		type: ActionType.SessionTurnComplete,
		turnId,
	},
});
```

For better abort testing, split the echo into two small async chunks with a delay between them. If `abortSession()` fires between chunks, emit:

```ts
{ type: ActionType.SessionTurnCancelled, turnId }
```

and do not emit `SessionTurnComplete`.

Rules:

- If `turnId` is undefined, generate a local id only for in-memory history, but still prefer tests and AgentSideEffects paths that supply a real `turnId`.
- Do not emit `SessionTurnStarted`; the client already did that.
- Always emit at most one terminal action for a turn:
  - `SessionTurnComplete`, or
  - `SessionTurnCancelled`, or
  - `SessionError`.
- Store emitted response parts in session history so `getSessionMessages()` can return current-process turns.
- Use deterministic IDs in tests by allowing an optional ID generator or by asserting on action type/content rather than exact generated IDs.

## 7. `DirectorAgentSession` Spec

Recommended fields:

```ts
class DirectorAgentSession extends Disposable {
	readonly sessionUri: URI;
	readonly createdAt: number;
	modifiedAt: number;
	model: ModelSelection | undefined;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _turns: Turn[] = [];
	private _activeAbort: AbortController | undefined;
	private _activeTurnId: string | undefined;
}
```

Methods:

- `send(prompt, attachments, turnId)`:
  - aborts or rejects if another fake turn is active;
  - records user message in `_turns`;
  - emits one or two markdown response parts;
  - emits terminal action;
  - updates `modifiedAt`.
- `abort()`:
  - aborts active controller;
  - emits cancel only if a turn is active and not already terminal.
- `getTurns()`:
  - returns readonly snapshot of `_turns`.
- `changeModel(model)`:
  - updates model and `modifiedAt`.
- `dispose()`:
  - aborts active turn, clears state, calls `super.dispose()`.

Fake streaming timing:

- Use `timeout(0)` or a tiny injectable delay between chunks so abort tests can interleave.
- Tests should not depend on wall-clock sleeps longer than necessary.

Concurrency rule:

- Phase 2 may serialize sends per session using a `SequencerByKey` in `DirectorAgent`, or reject concurrent sends with a clear error.
- Prefer serialization if it is simple, because existing AgentHost patterns already expect per-session sequencing.

### Stubs and No-Ops

Implement required `IAgent` methods with safe minimal behavior:

- `resolveSessionConfig()` returns empty object schema and current values.
- `sessionConfigCompletions()` returns empty items.
- `changeModel()` updates the session selected model if the model belongs to the `director` provider; otherwise throw a protocol/user-visible error.
- `respondToPermissionRequest()` no-op in Phase 2.
- `respondToUserInputRequest()` no-op in Phase 2.
- `setClientTools()` stores nothing or stores the latest array for future phases; no tool execution yet.
- `onClientToolCallComplete()` no-op.
- `setClientCustomizations()` returns `[]`.
- `setCustomizationEnabled()` no-op.

Avoid throwing `TODO` from methods the workbench may call during normal minimal usage. For truly unsupported optional behavior, prefer omitting optional methods.

## 8. Registration Details

In `agentHostMain.ts` and `agentHostServerMain.ts`:

- construct/register the Phase 1 backend hub service before constructing `DirectorAgent`;
- add it to `ServiceCollection` if using DI;
- register `DirectorAgent` only when the env var is truthy;
- keep existing `CopilotAgent` registration first;
- keep existing Claude SDK-path gate unchanged.

Pseudo-order:

```ts
const directorBackendHub = instantiationService.createInstance(DirectorProviderBackendHub);
diServices.set(IDirectorProviderBackendHub, directorBackendHub);

agentService.registerProvider(instantiationService.createInstance(CopilotAgent));

if (process.env[AgentHostClaudeSdkPathEnvVar]) {
	agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));
}

if (process.env[AgentHostEnableDirectorAgentEnvVar]) {
	agentService.registerProvider(instantiationService.createInstance(DirectorAgent));
}
```

If registration order affects UI ordering, document the choice. Director can appear after Claude in Phase 2.

Registration checklist:

- `CopilotAgent` still registers without any Director gate.
- Existing Claude registration still depends only on `AgentHostClaudeSdkPathEnvVar`.
- `DirectorAgent` registers only when `AgentHostEnableDirectorAgentEnvVar` is truthy.
- `DirectorProviderBackendHub` registration does not require the Director agent gate if tests or future providers need it. If this feels too eager, gate both and document why.
- Headless/server path and local utility-process path behave the same.

## 9. Tests

Create `directorAgent.test.ts`.

Test cases:

- descriptor returns provider `director`.
- `getProtectedResources()` returns `[]`.
- `authenticate()` returns `false`.
- models are published from fake backend.
- `createSession()` returns a `director:/...` URI.
- `listSessions()` includes created session.
- `disposeSession()` removes session.
- `sendMessage()` emits `SessionResponsePart` and `SessionTurnComplete`.
- `abortSession()` cancels an in-flight fake stream and emits `SessionTurnCancelled`.
- `shutdown()` disposes all sessions.
- no `ICopilotApiService` mock is needed to instantiate `DirectorAgent`.

Add registration tests if existing agentHost main/server tests make this practical:

- without env var, provider is not registered;
- with env var, provider is registered.

If main-process registration tests are too heavy for Phase 2, document a manual smoke step and keep unit coverage around the class itself.

Additional behavior tests:

| Test | Expected |
|---|---|
| create with explicit session URI | preserves supplied `director:/...` URI |
| create with model selection | session stores selected model |
| change model to known model | updates metadata and model |
| change model to unknown provider | rejects with clear error |
| send after dispose | rejects or no-ops with clear error |
| double abort | idempotent |
| shutdown during active send | cancels active turn and disposes |

## 10. Manual Smoke

After compile and tests:

1. Enable `chat.agentHost.enabled`.
2. Enable `chat.agentHost.directorAgent.enabled`.
3. Restart the AgentHost/workbench.
4. Open Agent Sessions.
5. Confirm `Director` appears as an agent/provider.
6. Create a Director session.
7. Send a prompt.
8. Confirm deterministic echo output streams and completes.
9. Confirm Copilot and existing Claude behavior remain unchanged.

Optional manual checks:

10. Disable `chat.agentHost.directorAgent.enabled`.
11. Restart AgentHost/workbench.
12. Confirm `Director` disappears.
13. Re-enable and confirm it reappears without changing Copilot/Claude settings.

## 11. Validation

Required:

```powershell
npm run compile-check-ts-native
npm run valid-layers-check
```

Targeted:

```powershell
npm run test-node -- --grep directorAgent
```

If targeted grep is unavailable, run the nearest AgentHost node test suite and document the exact command.

## 12. Failure Modes and Recovery

Expected recoverable failures:

- No fake models available:
  - publish empty model list;
  - create session should return a user-readable error or fallback model only if Phase 1 explicitly allows it.
- Model selection references another provider:
  - reject `createSession` or `changeModel` with a clear error.
- Send called for unknown session:
  - throw a protocol error or normal `Error` consistent with nearby agents.
- Abort called for idle/unknown session:
  - idle abort is no-op;
  - unknown session should not crash the host.

Do not recover by registering Copilot resources, using CAPI models, or silently creating a Copilot session.

## 13. Review Checklist

- `DirectorAgent.getProtectedResources()` returns `[]`.
- No `ICopilotApiService` import exists in `node/director/**`.
- No `GITHUB_COPILOT_PROTECTED_RESOURCE` import exists in `node/director/**`.
- `DirectorAgent` is invisible without its gate.
- `DirectorAgent` can be instantiated in unit tests without GitHub auth.
- Fake stream emits protocol actions, not UI-specific progress objects.
- `setClientTools` and customization methods are safe no-ops, not crashing TODO stubs.
- No old Director generated-tree files are imported.

## 14. Exit Criteria

- `DirectorAgent` is compiled and tested.
- Provider appears only when gated on.
- `DirectorAgent` has no protected resources and no Copilot token path.
- A fake/echo Director session can create, stream, complete, abort, list, and dispose.
- Copilot and current Claude gates remain unchanged.
- No real provider credentials are required.
- No old Director `AgentEngine` code has been moved yet.

## 15. Open Questions

- Should Phase 2 model ids include backend instance id, or should the fake model stay simple until Phase 3?
- Should `DirectorAgent` publish one model or multiple fake models to exercise picker behavior?
- Should fake streaming delay be deterministic through an injectable clock/test scheduler?
- Should setting registration live in `chat.shared.contribution.ts` permanently, or move to an AgentHost-specific contribution later?
