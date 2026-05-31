# Director Agent Provider Phase 9 Plan

Status: minimal implementation slice completed locally on 2026-05-31.

## Goal

Phase 9 makes provider-backed Director AgentHost sessions durable across AgentHost process restarts without adding a private restore protocol.

This slice uses the existing AgentHost restore flow:

- `IAgent.listSessions()`
- `IAgent.getSessionMetadata()`
- `IAgent.getSessionMessages()`
- `AgentService.restoreSession()`
- AgentHost state-manager `Turn[]` restoration

Director owns only the provider-specific persisted session data needed to answer those interfaces.

## Implemented Slice

- Added `DirectorSessionStore` under `src/vs/platform/agentHost/node/director/`.
- The store persists Director session metadata and normalized `Turn[]` into the existing per-session `session.db` metadata table.
- A narrow Director catalog entry records the session ids that belong to the `director` provider so `listSessions()` can rebuild the catalog after AgentHost restart.
- `DirectorAgent.createSession()` persists new sessions immediately, including working directory and selected model.
- `DirectorAgent.sendMessage()` restores persisted sessions on demand when they are not in memory, sends through the existing provider-backed `DirectorAgentSession`, and persists the updated turns.
- `DirectorAgent.listSessions()`, `getSessionMetadata()`, and `getSessionMessages()` now read from persisted session data as well as in-memory sessions.
- `DirectorAgent.changeModel()` updates the persisted model selection.
- `DirectorAgent.truncateSession()` provides minimal durable tail truncation by keeping turns through the requested turn id, or clearing all turns when no turn id is provided.
- Restore leaves missing provider/model/auth states listable and openable. Sending into that session follows the existing Director recoverable error path.

## Boundaries

- No changes under `extensions/copilot/**`.
- No new AgentHost or UI restore protocol.
- No prompt, response, API key, OAuth access token, or refresh token is written to registry JSON, provider snapshots, model metadata, telemetry, logs, or error messages.
- Director persists normalized AgentHost `Turn[]` for Director sessions only. It does not try to migrate old Chat Agent transcripts.
- Workbench remains out of AgentHost node runtime.
- Streaming and tool execution still flow through normal AHP session actions.

## Acceptance

- A Director session created in one `DirectorAgent` instance is visible through `listSessions()` in a later instance using the same session data service.
- `getSessionMessages()` restores the previous normalized turns from disk.
- Sending another prompt after restore includes the restored user/assistant history in the provider request.
- If the saved model is later removed, the session still lists with its previous model selection and the next send produces the existing AgentHost-visible model-unavailable error.
- `truncateSession()` keeps persisted state aligned with the visible durable tail.

## Deferred

- Full old Director Chat Agent history migration.
- In-place cross-harness session conversion.
- Durable compaction and session-summary generation beyond the persisted AgentHost metadata fields in this slice.
- External preview readiness gates from full Phase 10.
